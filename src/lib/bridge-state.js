import {
  ERROR_CODES,
  SERVICE_MESSAGE_TYPES,
  createResultError,
  createResultOk,
  createStatus,
  parseServiceMessage,
} from './protocol.js';

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

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The architecture requires a JSON-compatible return value, so this is checked. */
function isJsonSerializable(value) {
  try {
    return JSON.stringify(value) !== undefined || value === undefined;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   connection: {send: (text: string) => boolean},
 *   workTab: {isBound: boolean, tabId: number | null, reason: string | null},
 *   executor: {execute: (job: {tabId: number, script: string, input: unknown}) => Promise<unknown>},
 *   onStateChange?: (state: string) => void,
 *   logger?: {info?: Function, warn?: Function},
 * }} options
 */
export function createBridgeState({ connection, workTab, executor, onStateChange, logger = {} }) {
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

  function state() {
    if (currentJob !== null) return BRIDGE_STATES.RUNNING;
    if (!workTab.isBound) return BRIDGE_STATES.NOT_READY;
    return BRIDGE_STATES.IDLE;
  }

  function statusMessage() {
    const current = state();
    if (current === BRIDGE_STATES.RUNNING) {
      return createStatus(current, { jobId: currentJob.jobId });
    }
    if (current === BRIDGE_STATES.NOT_READY) {
      return createStatus(current, { reason: workTab.reason });
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

  function finishError(jobId, code, message) {
    currentJob = null;
    send(createResultError(jobId, code, message));
    announceState();
  }

  async function runJob(job) {
    currentJob = job;
    announceState();

    let data;
    try {
      data = await executor.execute({ tabId: job.tabId, script: job.script, input: job.input });
    } catch (error) {
      finishError(job.jobId, ERROR_CODES.SCRIPT_EXECUTION_FAILED, describeError(error));
      return;
    }

    if (!isJsonSerializable(data)) {
      finishError(
        job.jobId,
        ERROR_CODES.SCRIPT_EXECUTION_FAILED,
        '返回值不是 JSON-compatible，无法进入 RESULT.data。',
      );
      return;
    }

    currentJob = null;
    send(createResultOk(job.jobId, data));
    announceState();
  }

  /**
   * Handle one inbound frame.
   *
   * Never rejects and never throws: whatever a Service sends, the connection
   * handler must survive it.
   *
   * @param {unknown} raw
   */
  async function handleMessage(raw) {
    const parsed = parseServiceMessage(raw);

    if (!parsed.ok) {
      logger.warn?.(`[bridge] ignoring inbound frame (${parsed.failure}): ${parsed.error}`);
      // There is no ERROR message type in V1, so a rejected request that still
      // carried a usable jobId is answered with the RESULT the Service is
      // waiting for, using the one code that says "this job did not run".
      if (parsed.jobId !== null) {
        send(
          createResultError(parsed.jobId, ERROR_CODES.SCRIPT_EXECUTION_FAILED, parsed.error),
        );
      }
      return;
    }

    const message = parsed.message;

    if (message.type === SERVICE_MESSAGE_TYPES.GET_STATUS) {
      send(statusMessage());
      return;
    }

    // The only remaining valid type is EXECUTE.
    if (state() === BRIDGE_STATES.RUNNING) {
      // No queue and no pre-emption: the first Job keeps running untouched.
      send(createResultError(message.jobId, ERROR_CODES.BUSY, `Bridge 正在执行 ${currentJob.jobId}。`));
      return;
    }

    if (!workTab.isBound) {
      send(
        createResultError(message.jobId, ERROR_CODES.NOT_READY, `没有可用的 Work Tab（${workTab.reason}）。`),
      );
      return;
    }

    await runJob({
      jobId: message.jobId,
      script: message.script,
      input: message.input,
      tabId: workTab.tabId,
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
      return state() === BRIDGE_STATES.NOT_READY ? workTab.reason : null;
    },
    /** Only for diagnostics; the Service learns state through STATUS. */
    get statusMessage() {
      return statusMessage();
    },
    handleMessage,
  };
}
