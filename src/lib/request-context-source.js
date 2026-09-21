import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildRequestContext,
  describeError,
  isSameOrigin,
  mergeCookieSets,
  normalizeScope,
  normalizeTargetUrl,
  normalizeTopLevelSite,
} from './request-context.js';

/**
 * The browser side of a context request: read the Work Tab's own facts, ask
 * `chrome.cookies` what applies to one target URL, and assemble the answer.
 *
 * Everything here is injectable and resolved lazily, exactly like
 * `user-script-executor.js`: a permission-gated API is simply absent until the
 * operator grants it, so capturing `chrome.cookies` at construction time would
 * freeze "unavailable" into a worker that might live for hours. Failures are
 * returned as values, never thrown, so the caller always has something to answer
 * with.
 *
 * Two security-shaped decisions live here rather than in the caller:
 *
 * - **Exactly two cookie queries happen, both scoped to `targetUrl`.** There is
 *   no `getAll({})` and no `getAll({domain})` anywhere in this file: those would
 *   hand over a cookie store this extension has `<all_urls>` access to.
 * - **The work tab URL is read at request time.** V1 never stores it, so a page
 *   that navigated between two requests cannot leave a stale Referer behind.
 */

/** Where the reported user agent came from. Part of the answer, not a detail. */
export const USER_AGENT_SOURCES = Object.freeze({
  PAGE: 'work-tab-page',
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
 */
function readPageFactsInPage() {
  const uaData = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    brands: uaData ? uaData.brands.map((brand) => `${brand.brand}/${brand.version}`) : null,
    mobile: uaData ? uaData.mobile : null,
    platform: uaData ? uaData.platform : null,
    documentReferrer: document.referrer,
    // Measured on Chrome 153: this property is `undefined` in a page, so the
    // effective policy can only be assumed by the Service.
    referrerPolicy: typeof document.referrerPolicy === 'string' ? document.referrerPolicy : null,
    pageUrl: location.href,
  };
}

/**
 * @param {{
 *   cookies?: object,
 *   tabs?: object,
 *   scripting?: object,
 *   logger?: {info?: Function, warn?: Function},
 * }} [options]
 */
export function createRequestContextSource(options = {}) {
  const { logger = {} } = options;
  const injected = ['cookies', 'tabs', 'scripting'].some((key) => Object.hasOwn(options, key));

  function resolveApis() {
    if (injected) {
      return { cookies: options.cookies, tabs: options.tabs, scripting: options.scripting };
    }
    return {
      cookies: globalThis.chrome?.cookies,
      tabs: globalThis.chrome?.tabs,
      scripting: globalThis.chrome?.scripting,
    };
  }

  function isAvailable() {
    const { cookies, tabs, scripting } = resolveApis();
    return Boolean(cookies?.getAll && tabs?.get && scripting?.executeScript);
  }

  const fail = (code, message) => ({ ok: false, code, message });

  async function readWorkTabUrl(tabId) {
    const { tabs } = resolveApis();
    try {
      const tab = await tabs.get(tabId);
      const url = normalizeTargetUrl(tab?.url);
      if (!url.ok) return { ok: false, reason: 'Work Tab 已不在普通网页上。' };
      return { ok: true, url: url.url };
    } catch (error) {
      return { ok: false, reason: `Work Tab 已不可读：${describeError(error)}` };
    }
  }

  async function readPageFacts(tabId) {
    const { scripting } = resolveApis();
    try {
      const results = await scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: readPageFactsInPage,
      });
      const value = results?.[0]?.result;
      if (value && typeof value.userAgent === 'string' && value.userAgent !== '') return value;
      return null;
    } catch (error) {
      // A page the extension may not script yet must not fail the whole request:
      // the worker's own user agent is a fallback, and the answer says which one
      // was used.
      logger.warn?.(`[bridge] page facts unavailable: ${describeError(error)}`);
      return null;
    }
  }

  /**
   * @param {{
   *   tabId: number,
   *   targetUrl: unknown,
   *   scope?: unknown,
   *   topLevelSite?: unknown,
   * }} request
   * @returns {Promise<{ok: true, context: object} | {ok: false, code: string, message: string}>}
   */
  async function read(request) {
    if (!isAvailable()) {
      return fail(
        CONTEXT_ERROR_CODES.NOT_READY,
        'chrome.cookies / chrome.tabs / chrome.scripting 不可用：扩展缺少 cookies 或 scripting 权限。',
      );
    }

    const target = normalizeTargetUrl(request?.targetUrl);
    if (!target.ok) return fail(CONTEXT_ERROR_CODES.INVALID_TARGET_URL, target.reason);

    const scope = normalizeScope(request?.scope);
    if (!scope.ok) return fail(CONTEXT_ERROR_CODES.INVALID_SCOPE, scope.reason);

    const workTab = await readWorkTabUrl(request.tabId);
    if (!workTab.ok) return fail(CONTEXT_ERROR_CODES.NOT_READY, workTab.reason);

    if (scope.scope === TARGET_SCOPES.WORK_TAB_ORIGIN && !isSameOrigin(target.url, workTab.url)) {
      return fail(
        CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE,
        `targetUrl 与 Work Tab 不同源（${new URL(target.url).origin} ≠ ${new URL(workTab.url).origin}）；跨源必须显式使用 scope=${TARGET_SCOPES.TARGET_ONLY}。`,
      );
    }

    // Partitioned (CHIPS) cookies are invisible to a `url`-only query, so the
    // partition has to be named. A subresource of the Work Tab lives in the Work
    // Tab's own partition, which makes its origin the only useful default;
    // `null` opts out of the extra query entirely.
    let partitionQuery = null;
    if (request?.topLevelSite === null) {
      partitionQuery = null;
    } else if (request?.topLevelSite === undefined) {
      partitionQuery = new URL(workTab.url).origin;
    } else {
      const topLevelSite = normalizeTopLevelSite(request.topLevelSite);
      if (!topLevelSite.ok) return fail(CONTEXT_ERROR_CODES.INVALID_TARGET_URL, topLevelSite.reason);
      partitionQuery = topLevelSite.topLevelSite;
    }

    const { cookies } = resolveApis();
    let all;
    try {
      const unpartitioned = await cookies.getAll({ url: target.url });
      const partitioned =
        partitionQuery === null
          ? []
          : await cookies.getAll({ url: target.url, partitionKey: { topLevelSite: partitionQuery } });
      all = mergeCookieSets(unpartitioned, partitioned);
    } catch (error) {
      return fail(CONTEXT_ERROR_CODES.CONTEXT_FAILED, `chrome.cookies 读取失败：${describeError(error)}`);
    }

    const pageFacts = await readPageFacts(request.tabId);
    const context = buildRequestContext({
      targetUrl: target.url,
      scope: scope.scope,
      workTabUrl: workTab.url,
      cookies: all,
      userAgent: pageFacts?.userAgent ?? navigator.userAgent,
      userAgentSource: pageFacts ? USER_AGENT_SOURCES.PAGE : USER_AGENT_SOURCES.SERVICE_WORKER,
      observedAt: new Date().toISOString(),
      documentReferrer: pageFacts?.documentReferrer ?? null,
      referrerPolicy: pageFacts?.referrerPolicy ?? null,
      serviceWorkerUserAgent: navigator.userAgent,
    });

    return { ok: true, context };
  }

  return { isAvailable, read };
}
