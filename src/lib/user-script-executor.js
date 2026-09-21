/**
 * Execute Service JavaScript in the Work Tab through Chrome's userScripts API.
 *
 * Everything here exists because of how `chrome.userScripts.execute()` actually
 * behaves (verified against Chrome for Testing 153.0.8010.52 — see the notes on
 * `wrapScript` and `execute` below). In particular a script that throws, and a
 * script that does not even parse, both come back as a *resolved* call whose
 * `result` is `null`. That is indistinguishable from a script that returned
 * `null`, so the outcome has to be reported from inside the page rather than
 * inferred from the API's return value.
 *
 * The API and the world are injected so `node --test` can exercise the whole
 * mapping without a browser.
 */

/** The only world V1 is allowed to use. MAIN is deliberately never requested. */
export const USER_SCRIPT_WORLD = 'USER_SCRIPT';

/**
 * Marks the envelope the injected wrapper returns. A result without it means the
 * wrapper never completed — the code did not compile, or the frame never ran it —
 * which the API reports as a plain `null` result.
 */
const ENVELOPE_MARKER = '__browserBridgeEnvelope';

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
 * `input` arrives as that function's parameter. The envelope is built outside the
 * script, so a script value that happens to contain these keys cannot be mistaken
 * for the envelope itself.
 *
 * @param {string} script
 * @param {unknown} input
 */
export function wrapScript(script, input) {
  // U+2028/U+2029 are legal in JSON strings but were line terminators in older
  // JavaScript, so they are escaped rather than pasted into the source.
  const inputJson = JSON.stringify(input === undefined ? null : input)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `(async (input) => {
  const envelope = (payload) => Object.assign({ ${ENVELOPE_MARKER}: true }, payload);
  const describe = (error) => {
    try {
      return { name: String(error && error.name), message: String(error && error.message) };
    } catch {
      return { name: 'Error', message: '无法读取脚本抛出的错误信息' };
    }
  };
  try {
    const value = await (async () => {
${script}
    })();
    // The architecture allows only stable JSON values. A DOM node, the window or
    // a function would otherwise be silently flattened by the structured clone
    // (a DOM element arrives as {}), which would look like a successful result.
    const type = typeof value;
    if (type === 'function' || type === 'symbol' || type === 'bigint') {
      return envelope({ ok: false, error: { name: 'TypeError', message: '返回值类型不受支持：' + type } });
    }
    if (value !== null && type === 'object') {
      if (value === globalThis) {
        return envelope({ ok: false, error: { name: 'TypeError', message: '不能返回 window 本身' } });
      }
      if (typeof Node !== 'undefined' && value instanceof Node) {
        return envelope({ ok: false, error: { name: 'TypeError', message: '不能返回 DOM 节点' } });
      }
    }
    return envelope({ ok: true, value: value === undefined ? null : value });
  } catch (error) {
    return envelope({ ok: false, error: describe(error) });
  }
})(${inputJson})`;
}

/**
 * @param {{
 *   api?: {execute?: Function},
 *   logger?: {info?: Function, warn?: Function},
 * }} [options]
 */
export function createUserScriptExecutor(options = {}) {
  const { api: injectedApi, logger = {} } = options;
  const hasInjectedApi = Object.hasOwn(options, 'api');

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
