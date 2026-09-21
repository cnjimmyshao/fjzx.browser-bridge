import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildRequestContext,
  describeError,
  isSameOrigin,
  mergeCookieSets,
  normalizeScope,
  normalizeTargetUrl,
  resolvePartitionKey,
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
  /** The Work Tab page's own navigator — the only source this module produces. */
  PAGE: 'work-tab-page',
  /**
   * The extension worker's own navigator. Kept as a value because a context can
   * legitimately be *described* with it (and the field documents which navigator
   * answered), but `read()` no longer degrades to it: an unreadable page is an
   * error, not a context with the wrong user agent.
   */
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
      return {
        cookies: options.cookies,
        tabs: options.tabs,
        scripting: options.scripting,
        permissions: Object.hasOwn(options, 'permissions') ? options.permissions : undefined,
      };
    }
    return {
      cookies: globalThis.chrome?.cookies,
      tabs: globalThis.chrome?.tabs,
      scripting: globalThis.chrome?.scripting,
      permissions: globalThis.chrome?.permissions,
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

  /**
   * Does the extension still have access to this origin?
   *
   * `chrome.cookies.getAll` filters **silently** by host permission, so with site
   * access withheld it answers "no cookies" instead of failing — and for a
   * cross-origin target the Work Tab's own access says nothing about the target's.
   * Asking explicitly is the only way to tell "this URL has no cookies" from "we
   * are not allowed to see them". When the API is not injected the check is skipped
   * and the answer says nothing about access.
   */
  async function hasHostAccess(origin) {
    const { permissions } = resolveApis();
    if (typeof permissions?.contains !== 'function') return { ok: true, verified: false };
    try {
      const granted = await permissions.contains({ origins: [`${origin}/*`] });
      return { ok: granted === true, verified: true };
    } catch (error) {
      return { ok: false, verified: true, reason: describeError(error) };
    }
  }

  /**
   * Read the page's own facts, or say why they are not available.
   *
   * A failure here is **not** degraded to the worker's own user agent any more: the
   * usual cause is that the operator restricted the extension's access to this
   * site, and host access is shared with `chrome.cookies` — an answer built from
   * the worker's navigator would look complete while the cookie set behind it is
   * silently filtered. Reporting the failure is the only honest option.
   */
  async function readPageFacts(tabId) {
    const { scripting } = resolveApis();
    try {
      const results = await scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: readPageFactsInPage,
      });
      const value = results?.[0]?.result;
      if (value && typeof value.userAgent === 'string' && value.userAgent !== '') {
        return { ok: true, facts: value };
      }
      return { ok: false, reason: '页面没有返回可用的信息。' };
    } catch (error) {
      const reason = `扩展无法在此页面执行脚本（通常是用户限制了该站点的访问权限）：${describeError(error)}`;
      logger.warn?.(`[bridge] page facts unavailable: ${reason}`);
      return { ok: false, reason };
    }
  }

  /**
   * Take one consistent sample of the Work Tab.
   *
   * Returns `{retry: true}` when the page moved under us: the URL read before the
   * cookie queries and the page facts read after them must describe the same page,
   * or the answer would mix one origin's cookies and Referer with another origin's
   * user agent and referrer.
   */
  async function sample(request, target, scope) {
    const workTab = await readWorkTabUrl(request.tabId);
    if (!workTab.ok) return fail(CONTEXT_ERROR_CODES.NOT_READY, workTab.reason);

    if (scope.scope === TARGET_SCOPES.WORK_TAB_ORIGIN && !isSameOrigin(target.url, workTab.url)) {
      return fail(
        CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE,
        `targetUrl 与 Work Tab 不同源（${new URL(target.url).origin} ≠ ${new URL(workTab.url).origin}）；跨源必须显式使用 scope=${TARGET_SCOPES.TARGET_ONLY}。`,
      );
    }

    // Partitioned (CHIPS) cookies are invisible to a `url`-only query, so the
    // partition has to be named — and named exactly, see `resolvePartitionKey`.
    const partition = resolvePartitionKey({
      targetUrl: target.url,
      workTabUrl: workTab.url,
      topLevelSite: request.topLevelSite,
      hasCrossSiteAncestor: request.hasCrossSiteAncestor,
    });
    if (!partition.ok) return fail(CONTEXT_ERROR_CODES.INVALID_PARTITION, partition.reason);

    // Access is per origin, so a cross-origin target needs its own check: the Work
    // Tab being scriptable says nothing about whether the CDN's cookies are visible.
    const targetOrigin = new URL(target.url).origin;
    const access = await hasHostAccess(targetOrigin);
    if (!access.ok) {
      return fail(
        CONTEXT_ERROR_CODES.CONTEXT_FAILED,
        `扩展对目标站点没有访问权限（${targetOrigin}），无法保证 cookie 集合完整${access.reason === undefined ? '。' : `：${access.reason}`}`,
      );
    }

    const { cookies } = resolveApis();
    let all;
    try {
      const unpartitioned = await cookies.getAll({ url: target.url });
      const partitioned =
        partition.partitionKey === null
          ? []
          : await cookies.getAll({ url: target.url, partitionKey: partition.partitionKey });
      all = mergeCookieSets(unpartitioned, partitioned);
    } catch (error) {
      return fail(CONTEXT_ERROR_CODES.CONTEXT_FAILED, `chrome.cookies 读取失败：${describeError(error)}`);
    }

    const facts = await readPageFacts(request.tabId);
    if (!facts.ok) return fail(CONTEXT_ERROR_CODES.CONTEXT_FAILED, `无法读取 Work Tab 页面：${facts.reason}`);
    const pageFacts = facts.facts;

    // The *document* the facts came from must be the document the cookies were read
    // for. Comparing origins alone would accept a same-origin navigation
    // (`/feed` → `/account`) and then answer with the old URL as the suggested
    // Referer while the facts describe the new page. A mismatch is not an error the
    // Service can act on — it is a race — so the caller retries once.
    const factsPage = normalizeTargetUrl(pageFacts.pageUrl);
    if (factsPage.ok && factsPage.url !== workTab.url) return { retry: true };
    const after = await readWorkTabUrl(request.tabId);
    if (!after.ok || after.url !== workTab.url) return { retry: true };

    const context = buildRequestContext({
      targetUrl: target.url,
      scope: scope.scope,
      workTabUrl: workTab.url,
      cookies: all,
      userAgent: pageFacts.userAgent,
      userAgentSource: USER_AGENT_SOURCES.PAGE,
      observedAt: new Date().toISOString(),
      documentReferrer: pageFacts.documentReferrer ?? null,
      referrerPolicy: pageFacts.referrerPolicy ?? null,
      serviceWorkerUserAgent: navigator.userAgent,
    });

    return { ok: true, context };
  }

  /**
   * @param {{
   *   tabId: number,
   *   targetUrl: unknown,
   *   scope?: unknown,
   *   topLevelSite?: unknown,
   *   hasCrossSiteAncestor?: unknown,
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

    // Two attempts: one to notice a navigation that happened mid-sample, one to
    // answer from the page the tab settled on. A tab that keeps moving is reported
    // rather than answered with a mixture.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await sample(request, target, scope);
      if (outcome.retry !== true) return outcome;
    }
    return fail(CONTEXT_ERROR_CODES.CONTEXT_FAILED, 'Work Tab 在采样期间发生了导航，无法给出同一页面的上下文。');
  }

  return { isAvailable, read };
}
