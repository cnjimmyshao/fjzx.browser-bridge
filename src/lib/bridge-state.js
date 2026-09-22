import {
  ERROR_CODES,
  SERVICE_MESSAGE_TYPES,
  createRequestContextError,
  createRequestContextOk,
  createResultError,
  createResultOk,
  createStatus,
  isJsonCompatible,
  parseServiceMessage,
} from './protocol.js';
import { CONTEXT_ERROR_CODES } from './request-context.js';

/**
 * Bridge's current technical state, and the single Job it may be running.
 *
 * The state is *derived*, never stored: Bridge is RUNNING while a Job is in
 * flight, otherwise NOT_READY when no Work Tab is bound, otherwise IDLE. That is
 * what keeps the three states from drifting apart, and it means a Work Tab
 * disappearing is reflected in the next GET_STATUS without any bookkeeping.
 *
 * There is no queue, no history, no retry and no idempotency: a Job arrives,
 * runs, and its RESULT is pushed once. Nothing about it is kept afterwards.
 *
 * The executor is injected, so `node --test` drives the whole state machine with
 * a stub — and later issues replace only that dependency.
 */

/** The only V1 Bridge states. */
export const BRIDGE_STATES = Object.freeze({
  IDLE: 'IDLE',
  RUNNING: 'RUNNING',
  NOT_READY: 'NOT_READY',
});

/**
 * A NOT_READY reason that is not about tabs: the platform will not run user
 * scripts at all, so Bridge cannot do its one job until an operator allows it.
 * The reason itself is the architecture's; what it means is technical, not
 * business.
 */
export const USER_SCRIPTS_UNAVAILABLE = 'USER_SCRIPTS_UNAVAILABLE';

/**
 * Describe a rejection value without ever throwing.
 *
 * A value can carry a `Symbol.toPrimitive` that throws itself, and an escape from
 * here would leave the Job registered — Bridge would answer every later EXECUTE
 * with BUSY and never deliver this one's RESULT.
 */
function describeError(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return '（无法描述的失败值）';
  }
}

/**
 * @param {{
 *   connection: {send: (text: string) => boolean},
 *   workTab: {isBound: boolean, tabId: number | null, reason: string | null},
 *   executor: {execute: (job: {tabId: number, script: string, input: unknown}) => Promise<unknown>},
 *   requestContext?: {
 *     isAvailable: () => boolean,
 *     read: (request: {tabId: number, targetUrl: unknown, scope?: unknown, topLevelSite?: unknown}) => Promise<object>,
 *   },
 *   onStateChange?: (state: string) => void,
 *   logger?: {info?: Function, warn?: Function},
 * }} options
 */
export function createBridgeState({
  connection,
  workTab,
  executor,
  requestContext,
  onStateChange,
  logger = {},
}) {
  if (!connection || typeof connection.send !== 'function') {
    throw new TypeError('createBridgeState 需要一个实现 send 的 connection。');
  }
  if (!workTab) {
    throw new TypeError('createBridgeState 需要 workTab。');
  }
  if (!executor || typeof executor.execute !== 'function') {
    throw new TypeError('createBridgeState 需要一个实现 execute 的 executor。');
  }

  /** The one Job in flight, or null. Never a collection: V1 has no queue. */
  let currentJob = null;
  let lastState = null;

  /** Why Bridge cannot serve right now, or null when it can. */
  function notReadyReason() {
    if (!workTab.isBound) return workTab.reason;
    // A Work Tab is bound but the platform will not run scripts in it, so a Job
    // would be accepted and then fail for a reason the Service cannot see.
    if (typeof executor.isAvailable === 'function' && !executor.isAvailable()) {
      return USER_SCRIPTS_UNAVAILABLE;
    }
    return null;
  }

  function state() {
    if (currentJob !== null) return BRIDGE_STATES.RUNNING;
    if (notReadyReason() !== null) return BRIDGE_STATES.NOT_READY;
    return BRIDGE_STATES.IDLE;
  }

  function statusMessage() {
    const current = state();
    if (current === BRIDGE_STATES.RUNNING) {
      return createStatus(current, { jobId: currentJob.jobId });
    }
    if (current === BRIDGE_STATES.NOT_READY) {
      return createStatus(current, { reason: notReadyReason() });
    }
    return createStatus(current);
  }

  function announceState() {
    const current = state();
    if (current === lastState) return;
    lastState = current;
    logger.info?.(
      current === BRIDGE_STATES.RUNNING
        ? `[bridge] state: RUNNING (${currentJob.jobId})`
        : `[bridge] state: ${current}`,
    );
    try {
      onStateChange?.(current);
    } catch (error) {
      logger.warn?.('[bridge] state change handler failed', error);
    }
  }

  /**
   * Send one message. A failed send is dropped rather than queued: V1 has no
   * offline queue and no retry, so the Service's own timeout is the backstop.
   */
  function send(message) {
    let text;
    try {
      text = JSON.stringify(message);
    } catch (error) {
      logger.warn?.('[bridge] cannot serialize an outgoing message', error);
      return false;
    }
    if (connection.send(text)) return true;
    logger.warn?.(
      `[bridge] dropped ${message.type}${message.jobId ? ` for ${message.jobId}` : ''}: no live service connection`,
    );
    return false;
  }

  /**
   * Answer the Service that asked — and only that one.
   *
   * A request outlives the connection it arrived on: the operator may repoint the
   * Service URL while it is being served, in which case the replacement Service
   * must not receive page data it never asked for. The work still finishes; the
   * answer simply has nowhere to go.
   */
  function sendToOrigin(originUrl, subject, message) {
    if (connection.url !== originUrl) {
      logger.warn?.(
        `[bridge] dropped ${message.type} for ${subject}: the endpoint changed while it ran`,
      );
      return;
    }
    send(message);
  }

  function sendResultFor(job, message) {
    sendToOrigin(job.originUrl, job.jobId, message);
  }

  /**
   * Why a context request cannot be served, or null when it can.
   *
   * Deliberately *narrower* than `notReadyReason()`: reading cookies and the
   * page's own facts never runs Service JavaScript, so an operator who has not
   * granted "Allow User Scripts" can still be told what the browser would send.
   * Conflating the two would take a capability away for an unrelated reason.
   */
  function contextNotReadyReason() {
    if (!workTab.isBound) return workTab.reason;
    if (requestContext === undefined || requestContext === null) return 'CONTEXT_UNAVAILABLE';
    if (typeof requestContext.read !== 'function') return 'CONTEXT_UNAVAILABLE';
    if (typeof requestContext.isAvailable === 'function' && !requestContext.isAvailable()) {
      return 'CONTEXT_UNAVAILABLE';
    }
    return null;
  }

  /**
   * Serve one `GET_REQUEST_CONTEXT`.
   *
   * This runs **outside the Job model on purpose**: it takes no Job slot, it is
   * answered while a script Job is RUNNING, and it never touches `currentJob` or
   * the derived state. A context request is a read of browser facts, not work the
   * operator's page has to wait for.
   */
  async function serveRequestContext(message, deliveredOn) {
    const reply = (outgoing) => {
      sendToOrigin(deliveredOn, outgoing.requestId, outgoing);
    };

    const reason = contextNotReadyReason();
    if (reason !== null) {
      reply(
        createRequestContextError(
          message.requestId,
          CONTEXT_ERROR_CODES.NOT_READY,
          `Bridge 当前无法提供请求上下文（${reason}）。`,
        ),
      );
      return;
    }

    // The tab this context is sampled from, remembered so the answer can be checked
    // against the binding it was taken under.
    const sampledTabId = workTab.tabId;

    let outcome;
    try {
      outcome = await requestContext.read({
        tabId: workTab.tabId,
        targetUrl: message.targetUrl,
        scope: message.scope,
        topLevelSite: message.topLevelSite,
        hasCrossSiteAncestor: message.hasCrossSiteAncestor,
      });
    } catch (error) {
      reply(
        createRequestContextError(
          message.requestId,
          CONTEXT_ERROR_CODES.CONTEXT_FAILED,
          `读取请求上下文时出现意外错误：${describeError(error)}`,
        ),
      );
      return;
    }

    // Reading cookies and page facts is asynchronous, and the tab set can change
    // while it runs: a second ordinary tab makes Bridge NOT_READY for exactly this
    // request. Answering anyway would disclose a context sampled from a tab it can
    // no longer identify — data the Service could not have obtained a moment later.
    //
    // A refresh may still be in flight (the manager deliberately keeps the previous
    // binding visible until its `tabs.query()` answers), so the current snapshot is
    // awaited first; otherwise this check would read the stale binding it is meant
    // to catch.
    if (typeof workTab.settled === 'function') {
      try {
        await workTab.settled();
      } catch (error) {
        logger.warn?.('[bridge] waiting for the work tab snapshot failed', error);
      }
    }
    if (!workTab.isBound || workTab.tabId !== sampledTabId) {
      reply(
        createRequestContextError(
          message.requestId,
          CONTEXT_ERROR_CODES.NOT_READY,
          `Work Tab 绑定在采样期间发生了变化（${workTab.reason ?? 'UNKNOWN'}）。`,
        ),
      );
      return;
    }

    if (!outcome || outcome.ok !== true) {
      reply(
        createRequestContextError(
          message.requestId,
          outcome?.code ?? CONTEXT_ERROR_CODES.CONTEXT_FAILED,
          outcome?.message ?? '读取请求上下文失败。',
        ),
      );
      return;
    }

    // `buildRequestContext` copies every field by whitelist, so this is a guard
    // against a future field rather than against today's shape — the same reason
    // the EXECUTE path checks its return value instead of trusting it.
    if (!isJsonCompatible(outcome.context)) {
      reply(
        createRequestContextError(
          message.requestId,
          CONTEXT_ERROR_CODES.CONTEXT_FAILED,
          '上下文不是 JSON-compatible，拒绝静默改写后返回。',
        ),
      );
      return;
    }

    reply(createRequestContextOk(message.requestId, outcome.context));
    logger.info?.(
      `[bridge] request context for ${outcome.context.targetOrigin}: ${outcome.context.cookieCount} cookie(s), ${outcome.context.httpOnlyCookieCount} httpOnly, user agent from ${outcome.context.userAgentSource}`,
    );
  }

  async function runJob(job) {
    currentJob = job;
    announceState();

    const fail = (message) => {
      currentJob = null;
      sendResultFor(job, createResultError(job.jobId, ERROR_CODES.SCRIPT_EXECUTION_FAILED, message));
      announceState();
    };

    try {
      let data;
      try {
        data = await executor.execute({ tabId: job.tabId, script: job.script, input: job.input });
      } catch (error) {
        fail(describeError(error));
        return;
      }

      // A missing return value has an obvious JSON spelling, so it maps to null;
      // anything else must survive the trip unchanged.
      const result = data === undefined ? null : data;
      if (!isJsonCompatible(result)) {
        fail(
          '返回值不是 JSON-compatible（只支持 null/boolean/有限 number/string/array/plain object），拒绝静默改写后返回。',
        );
        return;
      }

      currentJob = null;
      sendResultFor(job, createResultOk(job.jobId, result));
      announceState();
    } catch (error) {
      // Nothing may leave the Job registered: a stuck RUNNING state would answer
      // every later EXECUTE with BUSY and never deliver this one's RESULT.
      fail(`处理返回值时出现意外错误：${describeError(error)}`);
    }
  }

  /**
   * Handle one inbound frame.
   *
   * Never rejects and never throws: whatever a Service sends, the connection
   * handler must survive it.
   *
   * @param {unknown} raw
   * @param {{deliveredOn?: string}} [options] the endpoint that delivered the
   *   frame, captured when it arrived. Handling can be deferred (waiting for the
   *   first Work Tab evaluation), and a frame must not be answered on an endpoint
   *   that has replaced the one it came in on.
   */
  async function handleMessage(raw, options = {}) {
    const deliveredOn = options.deliveredOn === undefined ? connection.url : options.deliveredOn;
    if (deliveredOn !== connection.url) {
      logger.warn?.('[bridge] dropping a frame delivered by a previous endpoint');
      return;
    }

    const parsed = parseServiceMessage(raw);

    if (!parsed.ok) {
      logger.warn?.(`[bridge] ignoring inbound frame (${parsed.failure}): ${parsed.error}`);
      // There is no ERROR message type in V1, so a rejected request that still
      // carried a usable jobId is answered with the RESULT the Service is
      // waiting for, using the one code that says "this job did not run". A
      // context request gets the same treatment with its own envelope, so a
      // malformed frame never leaves the Service waiting for an answer.
      if (parsed.jobId !== null) {
        send(
          createResultError(parsed.jobId, ERROR_CODES.SCRIPT_EXECUTION_FAILED, parsed.error),
        );
      } else if (parsed.requestId !== null && parsed.requestId !== undefined) {
        send(
          createRequestContextError(parsed.requestId, CONTEXT_ERROR_CODES.INVALID_TARGET_URL, parsed.error),
        );
      }
      return;
    }

    const message = parsed.message;

    if (message.type === SERVICE_MESSAGE_TYPES.GET_STATUS) {
      send(statusMessage());
      return;
    }

    if (message.type === SERVICE_MESSAGE_TYPES.GET_REQUEST_CONTEXT) {
      // Before the BUSY check, and never through `runJob`: a context request is
      // not a Job, so a running Job neither blocks it nor is disturbed by it.
      await serveRequestContext(message, deliveredOn);
      return;
    }

    // The only remaining valid type is EXECUTE.
    if (state() === BRIDGE_STATES.RUNNING) {
      // No queue and no pre-emption: the first Job keeps running untouched.
      send(createResultError(message.jobId, ERROR_CODES.BUSY, `Bridge 正在执行 ${currentJob.jobId}。`));
      return;
    }

    const reason = notReadyReason();
    if (reason !== null) {
      send(createResultError(message.jobId, ERROR_CODES.NOT_READY, `Bridge 当前不可用（${reason}）。`));
      return;
    }

    await runJob({
      jobId: message.jobId,
      script: message.script,
      input: message.input,
      tabId: workTab.tabId,
      // Remembered so the RESULT goes back to the Service that asked, even if the
      // operator repoints the endpoint while the Job runs.
      originUrl: connection.url,
    });
  }

  return {
    get state() {
      return state();
    },
    get currentJobId() {
      return currentJob ? currentJob.jobId : null;
    },
    get notReadyReason() {
      return state() === BRIDGE_STATES.NOT_READY ? notReadyReason() : null;
    },
    /** Only for diagnostics; the Service learns state through STATUS. */
    get statusMessage() {
      return statusMessage();
    },
    handleMessage,
  };
}
