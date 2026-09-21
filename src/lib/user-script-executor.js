import { createJsonCompatibilityCheck } from './protocol.js';

/**
 * Execute Service JavaScript in the Work Tab through Chrome's userScripts API.
 *
 * Everything here exists because of how `chrome.userScripts.execute()` actually
 * behaves (verified against Chrome for Testing 153.0.8010.52). In particular a
 * script that throws, and a script that does not even parse, both come back as a
 * *resolved* call whose `result` is `null` — indistinguishable from a script that
 * returned `null`. The outcome therefore has to be reported from inside the page
 * rather than inferred from the API's return value.
 *
 * The API is injected so `node --test` can exercise the whole mapping without a
 * browser.
 */

/** The only world V1 is allowed to use. MAIN is deliberately never requested. */
export const USER_SCRIPT_WORLD = 'USER_SCRIPT';

/**
 * Marks the envelope the injected wrapper returns. A result without it means the
 * wrapper never completed — the code did not compile, or the frame never ran it —
 * which the API reports as a plain `null` result.
 */
const ENVELOPE_MARKER = '__browserBridgeEnvelope';

/** Turn JSON text into a JavaScript string literal, U+2028/U+2029 included. */
function toSourceLiteral(text) {
  return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/**
 * Build the code that is actually injected.
 *
 * The Service script becomes the body of an async function, so it may use `return`
 * and `await`:
 *
 * ```js
 * return document.querySelector('h1').textContent;
 * ```
 *
 * Three details are deliberate:
 *
 * - **`input` is a real parameter of the function holding the Service body.** A
 *   nested zero-argument function that merely closed over it would break a body
 *   as ordinary as `var input = input || {};`, which would hoist a fresh, empty
 *   binding and silently discard the Service's input.
 * - **The JSON is parsed in the page, not pasted as a literal.** Written as an
 *   object literal, a `__proto__` key sets the prototype instead of creating the
 *   own property `JSON.parse` would produce, so the script would receive something
 *   other than what the Service sent.
 * - **The value is checked recursively before it leaves the page**, using the very
 *   same `isJsonCompatible` the Bridge applies. The browser's structured clone
 *   silently rewrites what JSON cannot carry (a DOM node becomes `{}`), and once
 *   that has happened the check has nothing left to reject.
 *
 * The envelope is built outside the Service script, so a script value containing
 * the marker key cannot be mistaken for the envelope itself.
 *
 * @param {string} script
 * @param {unknown} input
 */
export function wrapScript(script, input) {
  const inputJson = JSON.stringify(input === undefined ? null : input);
  const marker = toSourceLiteral(ENVELOPE_MARKER);

  return `(async (input) => {
  // Built before the Service body runs, so the body cannot swap out the intrinsics
  // the check reads. From here on the body shares this world with the check, and
  // rebuilding it afterwards would let a body validate itself.
  const isJsonCompatible = (${createJsonCompatibilityCheck.toString()})();
  // Object literals, not Object.assign: the body shares this world and could
  // replace that helper, which would let it forge the envelope it is judged by.
  const okEnvelope = (value) => ({ ${marker}: true, ok: true, value });
  const errorEnvelope = (error) => ({ ${marker}: true, ok: false, error });
  const describe = (error) => {
    try {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        const name = error.name;
        const message = error.message;
        if (name !== undefined || message !== undefined) {
          return {
            name: String(name === undefined ? 'Error' : name),
            message: String(message === undefined ? '' : message),
          };
        }
      }
      // A primitive rejection such as throwing a bare string has no name or
      // message, and message is the protocol's only diagnostic.
      return { name: 'Error', message: String(error) };
    } catch {
      return { name: 'Error', message: '无法读取脚本抛出的错误信息' };
    }
  };
  try {
    const value = await (async (input) => {
${script}
    })(input);
    // A script that returns nothing has an obvious JSON spelling.
    const delivered = value === undefined ? null : value;
    if (!isJsonCompatible(delivered)) {
      return errorEnvelope({
        name: 'TypeError',
        message: '返回值不是 JSON-compatible：只支持 null / boolean / 有限 number / string / array / plain object，且不含 DOM 节点、函数、访问器、空洞或循环引用。',
      });
    }
    return okEnvelope(delivered);
  } catch (error) {
    return errorEnvelope(describe(error));
  }
})(${`JSON.parse(${toSourceLiteral(inputJson)})`})`;
}

/**
 * @param {{
 *   api?: {execute?: Function},
 *   logger?: {info?: Function, warn?: Function},
 * }} [options]
 */
export function createUserScriptExecutor(options = {}) {
  const { logger = {} } = options;
  const hasInjectedApi = Object.hasOwn(options, 'api');
  const injectedApi = options.api;

  /**
   * Resolved on every use rather than captured once.
   *
   * `chrome.userScripts` is absent until an operator allows user scripts, and that
   * decision can be made while this worker is already running. Capturing the
   * property at construction would leave Bridge reporting USER_SCRIPTS_UNAVAILABLE
   * until the worker happened to restart.
   */
  function resolveApi() {
    return hasInjectedApi ? injectedApi : globalThis.chrome?.userScripts;
  }

  function isAvailable() {
    return typeof resolveApi()?.execute === 'function';
  }

  return {
    isAvailable,

    /**
     * Run one script in the Work Tab's main frame.
     *
     * Rejects with an Error when the script failed, when the call itself failed
     * (no such tab, a page the extension may not touch) or when the result could
     * not be understood. The caller turns any of those into
     * SCRIPT_EXECUTION_FAILED.
     *
     * @param {{tabId: number, script: string, input: unknown}} job
     * @returns {Promise<unknown>} the script's JSON value
     */
    async execute({ tabId, script, input }) {
      if (!isAvailable()) {
        throw new Error(
          'chrome.userScripts 不可用：该扩展尚未被允许运行用户脚本（Chrome 138+ 需要在扩展详情页开启 “Allow User Scripts”）。',
        );
      }
      if (typeof script !== 'string') {
        throw new Error('script 必须是字符串。');
      }

      const results = await resolveApi().execute({
        target: { tabId, frameIds: [0] },
        js: [{ code: wrapScript(script, input) }],
        world: USER_SCRIPT_WORLD,
      });

      if (!Array.isArray(results) || results.length === 0) {
        throw new Error('userScripts.execute() 没有返回任何结果。');
      }

      const [first] = results;
      const envelope = first?.result;

      if (!envelope || typeof envelope !== 'object' || envelope[ENVELOPE_MARKER] !== true) {
        // The API resolves with `null` here both for a script that threw and for
        // code that never compiled; either way the wrapper did not finish.
        throw new Error('脚本没有完成执行（语法错误，或该帧未能运行脚本）。');
      }

      if (envelope.ok !== true) {
        const detail = envelope.error ?? {};
        throw new Error(`${detail.name ?? 'Error'}: ${detail.message ?? '脚本执行失败'}`);
      }

      logger.info?.(`[bridge] script finished in frame ${first.frameId}`);
      return envelope.value;
    },
  };
}
