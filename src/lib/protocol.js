/**
 * The V1 wire protocol: four message types, three error codes, nothing else.
 *
 * `docs/architecture-v1.md` freezes this set. There is deliberately no separate
 * ERROR message, no ACK, no heartbeat and no job-created/job-finished
 * notification, so everything the Service needs to learn arrives as either
 * RESULT (about the job that just ran) or STATUS (about Bridge right now).
 *
 * Parsing and building are pure functions of plain data, so the whole contract is
 * exercised by `node --test` without a socket.
 */

/** Messages the Service may send to Bridge. */
export const SERVICE_MESSAGE_TYPES = Object.freeze({
  EXECUTE: 'EXECUTE',
  GET_STATUS: 'GET_STATUS',
});

/** Messages Bridge may send to the Service. */
export const BRIDGE_MESSAGE_TYPES = Object.freeze({
  RESULT: 'RESULT',
  STATUS: 'STATUS',
});

/** The only V1 error codes. A new code needs a Service that must machine-differentiate. */
export const ERROR_CODES = Object.freeze({
  BUSY: 'BUSY',
  NOT_READY: 'NOT_READY',
  SCRIPT_EXECUTION_FAILED: 'SCRIPT_EXECUTION_FAILED',
});

/** Why a frame could not be turned into a V1 request. Diagnostic only. */
export const PARSE_FAILURES = Object.freeze({
  NOT_TEXT: 'NOT_TEXT',
  INVALID_JSON: 'INVALID_JSON',
  NOT_AN_OBJECT: 'NOT_AN_OBJECT',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  MISSING_JOB_ID: 'MISSING_JOB_ID',
  MISSING_SCRIPT: 'MISSING_SCRIPT',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one inbound frame.
 *
 * Never throws: a Service that sends anything at all must not be able to break
 * the connection handler. A failure reports whether the frame still carried a
 * usable `jobId`, because that is what decides whether Bridge can answer with a
 * RESULT or has to stay silent — there is no ERROR message to fall back on.
 *
 * @param {unknown} raw frame payload as received
 * @returns {{
 *   ok: true,
 *   message: {type: string, jobId?: string, script?: string, input?: unknown, metadata?: unknown},
 * } | {
 *   ok: false,
 *   failure: string,
 *   error: string,
 *   jobId: string | null,
 * }}
 */
export function parseServiceMessage(raw) {
  const fail = (failure, error, jobId = null) => ({ ok: false, failure, error, jobId });

  if (typeof raw !== 'string') {
    return fail(PARSE_FAILURES.NOT_TEXT, 'Bridge 只接受文本帧。');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(PARSE_FAILURES.INVALID_JSON, '不是合法的 JSON。');
  }

  if (!isPlainObject(parsed)) {
    return fail(PARSE_FAILURES.NOT_AN_OBJECT, '消息必须是一个 JSON 对象。');
  }

  // A jobId is echoed verbatim, so it is reported whenever it is usable even if
  // the rest of the message is rejected.
  const jobId =
    typeof parsed.jobId === 'string' && parsed.jobId !== '' ? parsed.jobId : null;

  if (parsed.type === SERVICE_MESSAGE_TYPES.GET_STATUS) {
    return { ok: true, message: { type: SERVICE_MESSAGE_TYPES.GET_STATUS } };
  }

  if (parsed.type !== SERVICE_MESSAGE_TYPES.EXECUTE) {
    return fail(
      PARSE_FAILURES.UNKNOWN_TYPE,
      `未知消息类型：${typeof parsed.type === 'string' ? parsed.type : typeof parsed.type}`,
      jobId,
    );
  }

  if (jobId === null) {
    return fail(PARSE_FAILURES.MISSING_JOB_ID, 'EXECUTE 缺少非空字符串 jobId。');
  }

  if (typeof parsed.script !== 'string') {
    return fail(PARSE_FAILURES.MISSING_SCRIPT, 'EXECUTE 缺少字符串 script。', jobId);
  }

  const message = { type: SERVICE_MESSAGE_TYPES.EXECUTE, jobId, script: parsed.script };

  // `input` and `metadata` are carried through untouched and never interpreted:
  // giving them meaning would put Service business semantics inside Bridge.
  if ('input' in parsed) message.input = parsed.input;
  if ('metadata' in parsed) message.metadata = parsed.metadata;

  return { ok: true, message };
}

/**
 * @param {string} jobId
 * @param {unknown} data JSON-compatible script return value
 */
export function createResultOk(jobId, data) {
  return {
    type: BRIDGE_MESSAGE_TYPES.RESULT,
    jobId,
    ok: true,
    data: data === undefined ? null : data,
  };
}

/**
 * @param {string} jobId
 * @param {string} code one of `ERROR_CODES`
 * @param {string} message diagnostic; Bridge never invents business meaning here
 */
export function createResultError(jobId, code, message) {
  return {
    type: BRIDGE_MESSAGE_TYPES.RESULT,
    jobId,
    ok: false,
    error: { code, message },
  };
}

/**
 * Is this value something the wire format can carry without changing it?
 *
 * `JSON.stringify` succeeding is not the same test: it quietly turns `NaN` and
 * `Infinity` into `null`, drops `undefined`, function-valued, symbol-keyed and
 * non-enumerable properties, flattens a `Map` to `{}` and fills array holes with
 * `null`. Emitting `ok: true` with data the script never returned would be worse
 * than reporting a failure, so the supported types are checked explicitly
 * against what the architecture allows: null, boolean, number, string, array and
 * plain object.
 *
 * Total by construction: reading a property can run a getter that throws, and a
 * predicate that throws would escape as an unhandled failure instead of a
 * verdict.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isJsonCompatible(value) {
  try {
    return checkJsonCompatible(value, new Set());
  } catch {
    // A value whose contents cannot even be inspected is not one Bridge can
    // promise to deliver unchanged.
    return false;
  }
}

/**
 * @param {unknown} value
 * @param {Set<object>} path objects on the current branch, to detect cycles
 *   without rejecting a value that merely appears twice
 */
function checkJsonCompatible(value, path) {
  if (value === null) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      // NaN and Infinity have no JSON spelling; they would silently become null.
      return Number.isFinite(value);
    case 'object':
      break;
    default:
      // undefined, function, symbol, bigint
      return false;
  }

  if (path.has(value)) return false; // a cycle cannot be serialized
  path.add(value);
  try {
    if (Array.isArray(value)) {
      // `every` skips holes, yet they leave as null, and a stray property is
      // dropped entirely.
      if (value.length !== Object.keys(value).length) return false;
      return value.every((item) => checkJsonCompatible(item, path));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      // Date, Map, Set, RegExp, typed arrays: all of them change shape on the way
      // out, so none of them is "the value the script returned".
      return false;
    }

    // JSON keeps only own enumerable string-keyed properties, so anything else
    // would be dropped without the Service being able to tell.
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false;
      if (!checkJsonCompatible(value[key], path)) return false;
    }
    return true;
  } finally {
    path.delete(value);
  }
}

/**
 * @param {string} state one of IDLE / RUNNING / NOT_READY
 * @param {{jobId?: string, reason?: string}} [details]
 */
export function createStatus(state, details = {}) {
  const status = { type: BRIDGE_MESSAGE_TYPES.STATUS, state };
  if (state === 'RUNNING' && details.jobId !== undefined) {
    status.jobId = details.jobId;
  }
  if (state === 'NOT_READY' && details.reason !== undefined) {
    status.reason = details.reason;
  }
  return status;
}
