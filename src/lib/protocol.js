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
  UNSUPPORTED_INPUT: 'UNSUPPORTED_INPUT',
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
  if ('input' in parsed) {
    // Valid JSON is not automatically a JSON-compatible JS value: `1e400` parses
    // to Infinity and `-0` stays -0, and passing those on would silently change
    // what the script receives. Refusing is the honest option.
    if (!isJsonCompatible(parsed.input)) {
      return fail(
        PARSE_FAILURES.UNSUPPORTED_INPUT,
        'input 不是 JSON-compatible（只支持 null/boolean/有限 number/string/array/plain object）。',
        jobId,
      );
    }
    message.input = parsed.input;
  }
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
 * Build the check that decides whether a value is JSON-compatible.
 *
 * `JSON.stringify` succeeding is not the same test: it quietly turns `NaN` and
 * `Infinity` into `null`, drops `undefined`, function-valued, symbol-keyed and
 * non-enumerable properties, flattens a `Map` to `{}` and fills array holes with
 * `null`. Emitting `ok: true` with data the script never returned would be worse
 * than reporting a failure, so the supported types are checked explicitly against
 * what the architecture allows: null, boolean, number, string, array and plain
 * object.
 *
 * **A factory, and self-contained, on purpose.** Its source is injected into the
 * page by the executor, where it must be built *before* the Service body runs:
 * the check reads `Reflect.ownKeys`, `Object.getOwnPropertyDescriptor` and
 * friends, and the body shares that world, so a body that reassigns them
 * (`Reflect.ownKeys = () => []`) would otherwise be validating itself. Capturing
 * them here — in the extension, and in the page before the body exists — means
 * exactly one implementation decides what a JSON-compatible value is, and nothing
 * the value does can change the answer.
 *
 * @returns {(value: unknown) => boolean}
 */
export function createJsonCompatibilityCheck() {
  // Captured once, before any value being checked can run code of its own.
  const ownKeys = Reflect.ownKeys;
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototypeOf = Object.getPrototypeOf;
  const isArray = Array.isArray;
  const isFinite = Number.isFinite;
  const is = Object.is;
  const objectPrototype = Object.prototype;
  const toKey = String;
  const toNumber = Number;

  /**
   * The branch currently being walked, indexed by depth.
   *
   * An explicit depth beats `push`/`pop`/`indexOf`: those are prototype methods,
   * and a Service body shares this world, so an accidental polyfill on
   * `Array.prototype` would otherwise change what the check sees.
   */
  const branch = [];

  const check = (candidate, depth) => {
    if (candidate === null) return true;

    switch (typeof candidate) {
      case 'string':
      case 'boolean':
        return true;
      case 'number':
        // NaN and Infinity have no JSON spelling; they would silently become
        // null. -0 has one, but not through JSON.stringify, which emits 0 — so it
        // is refused rather than quietly normalized.
        return isFinite(candidate) && !is(candidate, -0);
      case 'object':
        break;
      default:
        // undefined, function, symbol, bigint
        return false;
    }

    for (let i = 0; i < depth; i += 1) {
      if (branch[i] === candidate) return false; // a cycle cannot be serialized
    }
    branch[depth] = candidate;
    const next = depth + 1;

    if (isArray(candidate)) {
      const keys = ownKeys(candidate);

      // JSON keeps exactly the canonical indices below `length`, so any other
      // own key — a hole, `"-1"`, `"NaN"`, `4294967295`, a named property, a
      // symbol key, a non-enumerable index, or a `toJSON` that JSON.stringify
      // would call instead of reading the array — changes the value on the way
      // out.
      let indexKeys = 0;
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key === 'length') continue;
        if (typeof key !== 'string') return false;
        const numeric = toNumber(key);
        if (!isFinite(numeric) || numeric < 0) return false;
        if (toKey(numeric) !== key) return false; // non-canonical, e.g. "01"
        if (numeric >= candidate.length) return false;
        indexKeys += 1;
      }
      if (indexKeys !== candidate.length) return false; // a hole

      for (let index = 0; index < candidate.length; index += 1) {
        const descriptor = getOwnPropertyDescriptor(candidate, toKey(index));
        if (descriptor === undefined) return false; // a hole
        if (!descriptor.enumerable) return false;
        // An accessor could yield a different value when it is read again, or
        // throw, after the Job has already been cleared.
        if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
        if (!check(descriptor.value, next)) return false;
      }
      return true;
    }

    const prototype = getPrototypeOf(candidate);
    if (prototype !== objectPrototype && prototype !== null) {
      // Date, Map, Set, RegExp, typed arrays, DOM nodes: all of them change
      // shape on the way out, so none of them is "the value the script returned".
      return false;
    }

    // JSON keeps only own enumerable string-keyed data properties, so anything
    // else would be dropped or re-evaluated without the Service being able to
    // tell. An accessor is rejected as well because reading it twice can yield
    // two different values: the one that was validated need not be the one that
    // gets sent.
    const keys = ownKeys(candidate);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string') return false;
      const descriptor = getOwnPropertyDescriptor(candidate, key);
      if (!descriptor.enumerable) return false;
      if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
      if (!check(descriptor.value, next)) return false;
    }
    return true;
  };

  return (value) => {
    try {
      return check(value, 0);
    } catch {
      // A value whose contents cannot even be inspected is not one Bridge can
      // promise to deliver unchanged.
      return false;
    }
  };
}

/** The check the extension uses; see `createJsonCompatibilityCheck`. */
export const isJsonCompatible = createJsonCompatibilityCheck();

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
