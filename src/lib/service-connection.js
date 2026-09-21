/**
 * The Bridge's single connection to its Service.
 *
 * V1 keeps exactly one Service WebSocket. This module owns that socket's whole
 * lifecycle: connect, report failures, reconnect after an unintended drop, and
 * swap endpoints when the configured Service URL changes.
 *
 * It speaks no protocol. There is no heartbeat, no authentication, no message
 * persistence and no offline queue: incoming frames are handed to an optional
 * handler as raw data and otherwise ignored, which is what keeps unknown text
 * and malformed JSON harmless.
 *
 * `WebSocket` and the timer functions are injectable so the lifecycle can be
 * driven deterministically under `node --test`; in the extension they resolve to
 * the service worker's globals.
 */

/** Connection state is deliberately separate from the Job state (IDLE/RUNNING/NOT_READY). */
export const CONNECTION_STATES = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
});

/**
 * Simple backoff for unintended drops. The last value repeats, so a Service that
 * stays down is retried every 15s without building a reconnect framework.
 */
export const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([1000, 2000, 5000, 15000]);

const NOOP_LOGGER = { info: () => {}, warn: () => {} };

export function createServiceConnection(options = {}) {
  const {
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    reconnectDelaysMs = DEFAULT_RECONNECT_DELAYS_MS,
    logger = NOOP_LOGGER,
  } = options;

  if (typeof WebSocketImpl !== 'function') {
    throw new TypeError('createServiceConnection 需要一个 WebSocket 实现。');
  }
  if (!Array.isArray(reconnectDelaysMs) || reconnectDelaysMs.length === 0) {
    throw new TypeError('reconnectDelaysMs 必须是非空数组。');
  }

  /** The one active socket, or null. Every other socket is stale by definition. */
  let socket = null;
  let url = '';
  let state = CONNECTION_STATES.DISCONNECTED;
  let attempt = 0;
  let reconnectTimer = null;
  let stopped = false;

  let messageHandler = null;
  let stateChangeHandler = null;

  function setState(next) {
    if (state === next) return;
    state = next;
    logger.info?.(`[bridge] service connection: ${next}`);
    try {
      stateChangeHandler?.(next);
    } catch (error) {
      logger.warn?.('[bridge] state change handler failed', error);
    }
  }

  function clearReconnect() {
    if (reconnectTimer === null) return;
    clearTimeoutImpl(reconnectTimer);
    reconnectTimer = null;
  }

  /**
   * Drop the current socket without letting its late events be mistaken for the
   * next connection's. Handlers are detached before closing.
   */
  function closeSocket() {
    const stale = socket;
    if (!stale) return;
    socket = null;
    stale.onopen = null;
    stale.onmessage = null;
    stale.onerror = null;
    stale.onclose = null;
    try {
      stale.close();
    } catch {
      // Already closed; nothing to release.
    }
  }

  function scheduleReconnect() {
    if (stopped || url === '') return;
    const index = Math.min(attempt, reconnectDelaysMs.length - 1);
    const delay = reconnectDelaysMs[index];
    attempt += 1;
    clearReconnect();
    logger.info?.(`[bridge] reconnecting in ${delay}ms`);
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  }

  /**
   * Construct the socket, absorbing an outright refusal of the URL.
   *
   * A URL the runtime will not even construct must not throw out of
   * `setUrl()` into a `chrome.storage.onChanged` listener, and retrying it on a
   * timer would spin forever. Reporting DISCONNECTED and waiting for the URL to
   * change keeps the worker alive and the failure diagnosable.
   */
  function createSocket() {
    try {
      return new WebSocketImpl(url);
    } catch (error) {
      logger.warn?.(`[bridge] refusing to dial ${url}`, error);
      setState(CONNECTION_STATES.DISCONNECTED);
      return null;
    }
  }

  function openSocket() {
    if (stopped || url === '') return;
    clearReconnect();
    // Guarantees "at most one active Service WebSocket" on every path in.
    closeSocket();

    const ws = createSocket();
    if (!ws) return;
    socket = ws;
    setState(CONNECTION_STATES.CONNECTING);

    ws.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      setState(CONNECTION_STATES.CONNECTED);
    };

    ws.onmessage = (event) => {
      if (socket !== ws) return;
      // Raw pass-through only. A throwing handler must not take the connection
      // down, and unparsed frames are simply not our business yet.
      try {
        messageHandler?.(event?.data);
      } catch (error) {
        logger.warn?.('[bridge] service message handler failed', error);
      }
    };

    ws.onerror = () => {
      if (socket !== ws) return;
      // The close event always follows, and schedules the single reconnect.
      logger.warn?.('[bridge] service connection error');
    };

    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      setState(CONNECTION_STATES.DISCONNECTED);
      scheduleReconnect();
    };
  }

  return {
    get state() {
      return state;
    },
    get url() {
      return url;
    },

    /**
     * Point the Bridge at a Service endpoint.
     *
     * An empty value means "not configured" and closes the connection; V1 must
     * not dial anywhere until an operator configures a URL. Setting the same URL
     * again is a no-op unless nothing is connected and no retry is pending, which
     * lets a waking service worker call this unconditionally.
     *
     * @param {string} nextUrl
     */
    setUrl(nextUrl) {
      const next = typeof nextUrl === 'string' ? nextUrl.trim() : '';

      if (next === url) {
        if (next !== '' && socket === null && reconnectTimer === null) openSocket();
        return;
      }

      url = next;
      attempt = 0;
      clearReconnect();
      closeSocket();
      setState(CONNECTION_STATES.DISCONNECTED);
      if (url !== '') openSocket();
    },

    /** Close the connection and stop reconnecting; the worker is going away. */
    stop() {
      stopped = true;
      clearReconnect();
      closeSocket();
      setState(CONNECTION_STATES.DISCONNECTED);
    },

    /** @param {(data: unknown) => void} handler */
    setMessageHandler(handler) {
      messageHandler = typeof handler === 'function' ? handler : null;
    },

    /** @param {(state: string) => void} handler */
    setStateChangeHandler(handler) {
      stateChangeHandler = typeof handler === 'function' ? handler : null;
    },
  };
}
