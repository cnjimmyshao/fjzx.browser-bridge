import {
  PAGE_CONTEXT_REASONS,
  buildPageContext,
  unavailablePageContext,
} from './page-context.js';

/**
 * The browser side of "what is the Work Tab right now", and the two shared pieces
 * both context readers are built from.
 *
 * Everything here is injectable and resolved lazily, exactly like
 * `user-script-executor.js`: a permission-gated API is simply absent until the
 * operator grants it, so capturing `chrome.scripting` at construction time would
 * freeze "unavailable" into a worker that might live for hours. Failures are
 * returned as values, never thrown, so the caller always has something to answer
 * with.
 *
 * One read is one document. Every field of a page context comes from a *single*
 * injection, so `location.href`, `navigator.userAgent`, `document.referrer` and
 * the browser's `documentId` cannot belong to different documents — there is no
 * window in between in which the page could be replaced. A navigation that
 * happens before or after that injection changes which document is described, not
 * whether the description is self-consistent.
 *
 * Failure reporting follows one rule: an error raised by an API that was handed a
 * URL or a page is reported by its *kind* only — Chrome's text can quote the full
 * page URL, query string and signature included. Errors that cannot carry a URL (a
 * tab lookup echoing a tab id) keep their text, because that is where the useful
 * diagnostic is.
 */

/** Where a reported user agent came from. Part of the answer, not a detail. */
export const USER_AGENT_SOURCES = Object.freeze({
  /** The Work Tab page's own navigator — the only source these readers produce. */
  PAGE: 'work-tab-page',
  /** The extension worker's own navigator, reported only for comparison. */
  SERVICE_WORKER: 'extension-service-worker',
});

/**
 * Runs *in the page*, so it must be self-contained: no closure over this file.
 *
 * These are the Work Tab's own answers, and they can differ from what the
 * extension service worker sees:
 *
 * - `navigator.userAgent` reflects a page-level override (device emulation) that
 *   the worker's own navigator knows nothing about;
 * - `document.referrer` is the page's view of where it came from, which is the
 *   fact a subresource's `Referer` is derived from.
 *
 * `referrerPolicy` is carried best-effort and is `null` on Chrome 153, where the
 * page-side `document.referrerPolicy` property is `undefined` (measured). The
 * effective policy therefore cannot be reported, only assumed.
 */
function readPageFactsInPage() {
  return {
    userAgent: navigator.userAgent,
    documentReferrer: document.referrer,
    referrerPolicy: typeof document.referrerPolicy === 'string' ? document.referrerPolicy : null,
    pageUrl: location.href,
  };
}

/** Describe any failure value without ever throwing. */
export function describeError(error) {
  try {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return String(error);
  } catch {
    return '（无法描述的失败值）';
  }
}

/**
 * The *kind* of a failure, never its text.
 *
 * Browser error messages are not safe to forward verbatim: `chrome.scripting`
 * rejections can embed the whole page URL, query string and signature included, and
 * the same is true of anything that quotes the target. Everything that reports or
 * logs a browser API failure therefore uses the name only.
 */
export function describeErrorKind(error) {
  try {
    if (error && typeof error === 'object' && typeof error.name === 'string' && error.name !== '') {
      return error.name;
    }
    return 'Error';
  } catch {
    return 'Error';
  }
}

/**
 * Read the Work Tab's own page facts.
 *
 * `documentId` names the document the facts came from. A reload keeps the URL
 * identical, so it is the only way to tell that the page was replaced.
 *
 * @param {{
 *   scripting?: object,
 *   logger?: {info?: Function, warn?: Function},
 * }} [options]
 */
export function createPageFactsReader(options = {}) {
  const { logger = {} } = options;
  const injected = Object.hasOwn(options, 'scripting');
  const resolveScripting = () => (injected ? options.scripting : globalThis.chrome?.scripting);

  function isAvailable() {
    return typeof resolveScripting()?.executeScript === 'function';
  }

  /**
   * @param {number} tabId
   * @returns {Promise<{ok: true, facts: object} | {ok: false, reason: string}>}
   */
  async function read(tabId) {
    const scripting = resolveScripting();
    if (typeof scripting?.executeScript !== 'function') {
      return { ok: false, reason: '扩展没有 scripting 权限，无法读取 Work Tab 页面。' };
    }

    try {
      const results = await scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: readPageFactsInPage,
      });
      const value = results?.[0]?.result;
      if (value && typeof value.userAgent === 'string' && value.userAgent !== '') {
        return { ok: true, facts: { ...value, documentId: results[0].documentId ?? null } };
      }
      return { ok: false, reason: '页面没有返回可用的信息。' };
    } catch (error) {
      const kind = describeErrorKind(error);
      logger.warn?.(`[bridge] page facts unavailable for tab ${tabId} (${kind})`);
      return { ok: false, reason: `扩展无法在此页面执行脚本（通常是用户限制了该站点的访问权限；${kind}）` };
    }
  }

  return { isAvailable, read };
}

/**
 * @param {{
 *   scripting?: object,
 *   logger?: {info?: Function, warn?: Function},
 * }} [options]
 */
export function createPageContextSource(options = {}) {
  const reader = createPageFactsReader(options);

  return {
    isAvailable: () => reader.isAvailable(),
    /**
     * Always resolves to a page context, never to a rejection: a Job that ran did
     * run, and a page that could not be read is reported as such instead of
     * failing the Job.
     *
     * @param {{tabId: number}} request
     */
    async read(request) {
      let outcome;
      try {
        outcome = await reader.read(request?.tabId);
      } catch {
        // `read` returns values rather than throwing, so this is a guard against a
        // future implementation instead of against today's one.
        return unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE);
      }
      if (outcome.ok !== true) {
        return unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE);
      }
      return buildPageContext({
        workTabUrl: outcome.facts.pageUrl,
        userAgent: outcome.facts.userAgent,
        documentReferrer: outcome.facts.documentReferrer,
        documentId: outcome.facts.documentId,
      });
    },
  };
}
