/**
 * Request context: what a Service needs to replay one request for a target URL.
 *
 * Kept free of `chrome.*` so `node --test` can drive every decision without a
 * browser; `request-context-source.js` is the thin, injectable layer that talks
 * to the browser APIs.
 *
 * The question this module answers is narrow on purpose: given a *target URL*
 * and the cookie objects the browser reports for exactly that URL, what is the
 * minimal context a Node client needs to replay one request for that URL?
 *
 * Two properties matter more than the shape of the payload:
 *
 * - **Nothing here is site-aware.** There is no hostname, no domain suffix list,
 *   no platform. Scope is decided by comparing origins, which is a statement
 *   about URLs, not about websites.
 * - **Cookie values never leave through a side channel.** Only `buildCookieHeader`
 *   returns values, and it returns them in the single field the Service must
 *   have; every diagnostic path goes through `maskCookieHeader`, which keeps
 *   names and drops values.
 */

/** How far a context request may reach beyond the Work Tab. */
export const TARGET_SCOPES = Object.freeze({
  /**
   * Default: the target must be same-origin with the Work Tab. Generic (an
   * origin comparison), and the only scope in which "the page the operator is
   * looking at" justifies handing out its cookies.
   */
  WORK_TAB_ORIGIN: 'WORK_TAB_ORIGIN',
  /**
   * Explicit opt-in: any http(s) target is accepted, and the disclosed set is
   * still only what the browser would send to *that* URL — never the whole jar.
   * Needed for cross-origin media hosts; the report explains why it is not the
   * default.
   */
  TARGET_ONLY: 'TARGET_ONLY',
});

/**
 * The error codes a context request can answer with. Separate from V1's
 * `ERROR_CODES` on purpose: that set belongs to a Job's RESULT, and widening it
 * would change what a Service has to handle for EXECUTE.
 */
export const CONTEXT_ERROR_CODES = Object.freeze({
  NOT_READY: 'NOT_READY',
  INVALID_TARGET_URL: 'INVALID_TARGET_URL',
  INVALID_SCOPE: 'INVALID_SCOPE',
  INVALID_PARTITION: 'INVALID_PARTITION',
  TARGET_OUT_OF_SCOPE: 'TARGET_OUT_OF_SCOPE',
  CONTEXT_FAILED: 'CONTEXT_FAILED',
});

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Accept only an absolute http(s) URL without embedded credentials.
 *
 * The fragment is dropped because it is never sent in a request, so keeping it
 * would only make two identical contexts look different. Credentials in the URL
 * are refused rather than stripped: silently rewriting what the Service asked
 * about is worse than telling it the URL is unusable.
 *
 * @param {unknown} raw
 * @returns {{ok: true, url: string} | {ok: false, reason: string}}
 */
export function normalizeTargetUrl(raw) {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, reason: 'targetUrl 必须是非空字符串。' };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'targetUrl 不是绝对 URL。' };
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, reason: `targetUrl 的 scheme 必须是 http/https，收到 ${parsed.protocol}` };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'targetUrl 不得内嵌凭据。' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

/**
 * Resolve the requested scope, defaulting to the strict one.
 *
 * An unknown scope is refused rather than coerced: quietly treating `"ANY"` as
 * `WORK_TAB_ORIGIN` would hand the Service a different answer than it asked for.
 *
 * @param {unknown} raw
 * @returns {{ok: true, scope: string} | {ok: false, reason: string}}
 */
export function normalizeScope(raw) {
  if (raw === undefined || raw === null) return { ok: true, scope: TARGET_SCOPES.WORK_TAB_ORIGIN };
  if (raw === TARGET_SCOPES.WORK_TAB_ORIGIN || raw === TARGET_SCOPES.TARGET_ONLY) {
    return { ok: true, scope: raw };
  }
  return {
    ok: false,
    reason: `scope 只能是 ${TARGET_SCOPES.WORK_TAB_ORIGIN} 或 ${TARGET_SCOPES.TARGET_ONLY}。`,
  };
}

/**
 * @param {string} a absolute URL
 * @param {string} b absolute URL
 */
export function isSameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Build the `Cookie` request header from `chrome.cookies.getAll({url})` objects.
 *
 * The set is already the browser's own answer to "what applies to this URL", so
 * the only ordering question is which cookie wins when two share a name. RFC 6265
 * sends longer paths first, so the sort key is path length only, and the sort is
 * *stable*: within one path length the order `chrome.cookies` returned is kept.
 * Measured against Chrome for Testing 153, that order is the order the browser
 * itself sends (`sid, theme, strict` in the POC run) — sorting by name instead
 * would silently reorder a header the Service is trying to reproduce.
 *
 * @param {Array<{name?: unknown, value?: unknown, path?: unknown}>} cookies
 */
export function buildCookieHeader(cookies) {
  if (!Array.isArray(cookies)) return '';

  return cookies
    .filter((cookie) => cookie && typeof cookie.name === 'string')
    .map((cookie) => ({
      name: cookie.name,
      value: typeof cookie.value === 'string' ? cookie.value : '',
      path: typeof cookie.path === 'string' ? cookie.path : '/',
    }))
    // A nameless cookie with a value is a legacy form Chrome can hold and send as
    // `=value`; dropping it would leave the header short of a cookie the browser
    // sends while `describeCookies` still counted it. Only a pair that is empty on
    // both sides carries nothing.
    .filter((cookie) => cookie.name !== '' || cookie.value !== '')
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Which top-level site a partitioned cookie belongs to.
 *
 * CHIPS keys a cookie by the site of the top-level document. Bridge can only
 * answer "what would apply to this URL" once it is told which partition to look
 * in — measured: without it, `chrome.cookies.getAll({url})` returns nothing at
 * all for a `Partitioned` cookie that the browser does send on a real request.
 *
 * @param {unknown} raw
 * @returns {{ok: true, topLevelSite: string} | {ok: false, reason: string}}
 */
export function normalizeTopLevelSite(raw) {
  const normalized = normalizeTargetUrl(raw);
  if (!normalized.ok) return { ok: false, reason: `topLevelSite 无效：${normalized.reason}` };
  return { ok: true, topLevelSite: new URL(normalized.url).origin };
}

/**
 * Merge the unpartitioned and partitioned answers for one target URL.
 *
 * `chrome.cookies.getAll` returns unpartitioned cookies when no `partitionKey` is
 * given and the cookies of the named partition when one is, so a complete answer
 * needs both queries. Duplicates cannot occur: a cookie is either partitioned or
 * not, and `chrome.cookies` reports which.
 *
 * @param {Array<object>} unpartitioned
 * @param {Array<object>} partitioned
 */
export function mergeCookieSets(unpartitioned, partitioned) {
  const left = Array.isArray(unpartitioned) ? unpartitioned : [];
  const right = Array.isArray(partitioned) ? partitioned : [];
  return [...left, ...right];
}

/**
 * The host that identifies a "site" for scheme-and-site comparisons.
 *
 * A registrable domain needs a public suffix list, which Bridge deliberately does
 * not carry: the last two labels are a good approximation for ordinary domains
 * (`www.example.com` and `cdn.example.com` → `example.com`) and exact for IP
 * literals and single-label hosts (`127.0.0.1`, `localhost`). The approximation is
 * wrong for multi-label public suffixes (`a.co.uk` and `b.co.uk` are different
 * sites), which is exactly why the caller can override the ancestor bit.
 */
function siteHost(hostname) {
  if (hostname.includes(':')) return hostname; // IPv6 literal
  if (/^\d+(\.\d+){3}$/.test(hostname)) return hostname; // IPv4 literal
  const labels = hostname.split('.');
  return labels.length <= 2 ? hostname : labels.slice(-2).join('.');
}

/**
 * Are two URLs the same **schemeful site** (scheme + registrable domain)?
 *
 * Ports are ignored, which is the point: a site is not an origin. See `siteHost`
 * for what "registrable domain" costs here.
 */
export function isSameSite(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol && siteHost(left.hostname) === siteHost(right.hostname);
  } catch {
    return false;
  }
}

/**
 * The match pattern for a URL's **origin**, without its port.
 *
 * Chrome match patterns have no port component, so `https://example.com:8443/*` is
 * malformed and `permissions.contains()` rejects it. The sensible pattern is
 * `https://example.com/*`.
 *
 * Host permissions are checked per *cookie*, so this pattern alone cannot prove that
 * a parent-domain cookie (`Domain=.example.com` matching `app.example.com`) is
 * visible. Deciding that in general needs a public suffix list, which Bridge does not
 * carry and which a "last two labels" guess gets wrong for `co.uk`, `github.io` and
 * friends — so the question is asked as "is the blanket grant still in place?"
 * instead, and anything narrower is reported as narrower rather than refused.
 *
 * @param {string} url
 */
export function originMatchPattern(url) {
  const { protocol, hostname } = new URL(url);
  return `${protocol}//${hostname}/*`;
}

/**
 * Pick the **one** CHIPS partition a replayed request belongs to.
 *
 * A partition key is not just the top-level site: since Chrome 130 it also carries
 * `hasCrossSiteAncestor`, and `{ topLevelSite }` alone matches *both* values of that
 * bit. Returning both would disclose — and let a Service replay — a cookie from a
 * partition the request is not in, and a duplicate name would silently produce a
 * wrong `Cookie` header.
 *
 * The bit says whether the request is cross-site relative to the top-level site,
 * so the default is derived from the two **schemeful sites** — not from origins
 * (a sibling subdomain or another port is still the same site) and not as a
 * constant (a cross-site target from the top-level document really does use the
 * cross-site partition; measured). An explicit value always wins, which is the
 * escape hatch for the cases the PSL-free approximation gets wrong.
 *
 * @param {{
 *   targetUrl: string,
 *   workTabUrl: string,
 *   topLevelSite?: unknown,
 *   hasCrossSiteAncestor?: unknown,
 *   supportsAncestorBit?: boolean,
 * }} input
 * @returns {{ok: true, partitionKey: object | null} | {ok: false, reason: string}}
 */
export function resolvePartitionKey(input) {
  // Validated before the opt-out: a malformed request must be rejected, not
  // reinterpreted as "no partition lookup" just because the site was omitted.
  if (input.hasCrossSiteAncestor !== undefined && typeof input.hasCrossSiteAncestor !== 'boolean') {
    return { ok: false, reason: 'hasCrossSiteAncestor 必须是 boolean 或省略。' };
  }

  if (input.topLevelSite === null) return { ok: true, partitionKey: null };

  // A context describes a request the Work Tab could itself make, so the partition can
  // only be that page's own top-level site. A supplied site that is *not* that site
  // would combine a foreign partition's cookies with this page's Referer and user
  // agent — a combination Chrome would never send — so it is refused rather than
  // honoured. Comparing schemeful sites (not origins) matches what a partition key
  // holds, and lets a caller name the site explicitly for clarity.
  if (input.topLevelSite !== undefined && !isSameSite(input.topLevelSite, input.workTabUrl)) {
    return {
      ok: false,
      reason: `topLevelSite 必须是 Work Tab 所在站点（${new URL(input.workTabUrl).origin}），不能指定其它站点的分区。`,
    };
  }

  const site = normalizeTopLevelSite(
    input.topLevelSite === undefined ? input.workTabUrl : input.topLevelSite,
  );
  if (!site.ok) return { ok: false, reason: site.reason };

  const topLevelSite = site.topLevelSite;

  // The bit itself only exists from Chrome 130. On anything older the field would
  // make `getAll` reject the whole query — including the ordinary reads of targets
  // that have no partitioned cookies at all — so it is left out there and the answer
  // says the partition was chosen by site only.
  if (input.supportsAncestorBit === false) return { ok: true, partitionKey: { topLevelSite } };

  return {
    ok: true,
    partitionKey: {
      topLevelSite,
      hasCrossSiteAncestor:
        input.hasCrossSiteAncestor ?? !isSameSite(input.targetUrl, topLevelSite),
    },
  };
}

/**
 * Names whose ordering Bridge cannot reproduce.
 *
 * A partitioned cookie and an unpartitioned one are different cookies, so they can
 * share a name and a path; both match a request and Chrome sends both, ordered by
 * path length and then by creation time — which `chrome.cookies` does not expose.
 *
 * Only a tie that **spans the two queries** is ambiguous. Within one `getAll`
 * result the API returns the browser's own order (measured), and the stable sort
 * keeps it, so two same-named cookies from the same query — on different domains,
 * say `sid` on `.example.com` and on `app.example.com` — are ordered exactly as
 * Chrome ordered them and must not be reported. What the merge loses is only the
 * relative order *between* the two responses.
 *
 * @param {{unpartitioned?: Array<object>, partitioned?: Array<object>}} [groups]
 * @returns {string[]} sorted, unique
 */
export function findAmbiguousCookieNames(groups = {}) {
  const key = (cookie) => {
    const path = typeof cookie.path === 'string' ? cookie.path : '/';
    return `${cookie.name}\u0000${path.length}`;
  };
  const from = (group) =>
    new Set(
      (Array.isArray(group) ? group : [])
        .filter((cookie) => cookie && typeof cookie.name === 'string')
        .map(key),
    );

  const unpartitioned = from(groups.unpartitioned);
  const partitioned = from(groups.partitioned);
  const ambiguous = [...unpartitioned].filter((candidate) => partitioned.has(candidate));
  return [...new Set(ambiguous.map((candidate) => candidate.slice(0, candidate.indexOf('\u0000'))))].sort();
}

/**
 * Cookie metadata without a single value: what a Service (or a log) may see
 * about *why* a header looks the way it does.
 *
 * A whitelist copy is not just tidiness. `chrome.cookies.Cookie` is not a plain
 * object, so `isJsonCompatible` would refuse the value as-is; and copying by
 * field means a future field on the browser's object cannot silently travel to
 * the Service.
 *
 * @param {Array<object>} cookies
 */
export function describeCookies(cookies) {
  if (!Array.isArray(cookies)) return [];

  return cookies
    .filter((cookie) => cookie && typeof cookie.name === 'string')
    .map((cookie) => ({
      name: cookie.name,
      domain: typeof cookie.domain === 'string' ? cookie.domain : '',
      path: typeof cookie.path === 'string' ? cookie.path : '',
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      sameSite: typeof cookie.sameSite === 'string' ? cookie.sameSite : 'unspecified',
      session: cookie.session === true,
      partitioned: Boolean(cookie.partitionKey),
      topLevelSite: cookie.partitionKey?.topLevelSite ?? null,
    }));
}

/**
 * Keep cookie *names* and drop every value. Every log line and every error
 * message about cookies goes through here, so a leak is a missing call rather
 * than a formatting accident.
 *
 * @param {string} header
 */
export function maskCookieHeader(header) {
  if (typeof header !== 'string' || header === '') return '';
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const separator = pair.indexOf('=');
      const name = separator === -1 ? pair : pair.slice(0, separator);
      return `${name}=***`;
    })
    .join('; ');
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
 * Assemble the response body. Pure: the caller passes in what the browser APIs
 * returned, so the same inputs produce the same context in a test.
 *
 * `userAgent` is deliberately reported with its source. A per-tab override (a
 * DevTools device emulation, for example) changes what the *page* reports while
 * the extension service worker keeps the browser's own value, so "which
 * navigator produced this string" is part of the answer.
 *
 * Referer gets the same treatment for the same reason: the *fact* is
 * `document.referrer` as the page itself reports it, and `referer` is only a
 * **suggested** value derived from the Work Tab URL. A subresource's real
 * initiator need not be the current top-level page, and only the Service can
 * decide which is right — inventing a Referer here would be a business judgement
 * dressed up as browser data.
 *
 * `referrerPolicy` is carried best-effort and is `null` on Chrome 153, where the
 * page-side `document.referrerPolicy` property is `undefined` (measured). The
 * effective policy therefore cannot be reported, only assumed.
 *
 * `observedAt` is passed in rather than read from the clock here, so the module
 * stays a pure function. It matters to the Service: a signed URL ages, and a
 * context is only as fresh as the moment it was sampled.
 *
 * @param {{
 *   targetUrl: string,
 *   scope: string,
 *   workTabUrl: string,
 *   cookies: Array<object>,
 *   userAgent: string | null,
 *   userAgentSource: string,
 *   observedAt: string,
 *   documentReferrer?: string | null,
 *   referrerPolicy?: string | null,
 *   duplicateCookieNames?: string[],
 *   exactPartitionSelection?: boolean,
 *   hostAccessCoverage?: 'all' | 'origin' | 'unknown',
 *   serviceWorkerUserAgent?: string | null,
 * }} input
 */
export function buildRequestContext(input) {
  const cookies = Array.isArray(input.cookies) ? input.cookies : [];
  const cookieHeader = buildCookieHeader(cookies);
  const described = describeCookies(cookies);
  const workTabUrl = typeof input.workTabUrl === 'string' ? input.workTabUrl : '';

  return {
    targetUrl: input.targetUrl,
    targetOrigin: new URL(input.targetUrl).origin,
    scope: input.scope,
    // Sampled when the browser APIs answered, not when the frame is written.
    observedAt: input.observedAt,
    cookieHeader,
    cookieCount: described.length,
    httpOnlyCookieCount: described.filter((cookie) => cookie.httpOnly).length,
    partitionedCookieCount: described.filter((cookie) => cookie.partitioned).length,
    // False means the browser is older than the ancestor bit (Chrome 130) and the
    // partition was chosen by top-level site alone: the set may contain cookies from
    // both partitions instead of exactly one.
    exactPartitionSelection: input.exactPartitionSelection !== false,
    // 'all'  — the blanket host grant is intact, so per-cookie filtering removed nothing;
    // 'origin' — only the target origin is covered, so a parent-domain cookie may have
    //            been filtered out and the set is "what is visible", not proven complete;
    // 'unknown' — the permissions API could not be asked.
    hostAccessCoverage: input.hostAccessCoverage ?? 'unknown',
    // Non-empty means the header carries the same name twice in a way Bridge cannot
    // order (the merge of two queries); `cookies` says which entry belongs to which
    // partition. Computed by the caller, which is where the two query results exist.
    duplicateCookieNames: Array.isArray(input.duplicateCookieNames) ? input.duplicateCookieNames : [],
    cookies: described,
    userAgent: input.userAgent ?? null,
    userAgentSource: input.userAgentSource,
    serviceWorkerUserAgent: input.serviceWorkerUserAgent ?? null,
    // Suggested `Referer`. The Work Tab URL is the only page identity Bridge has;
    // the fragment cannot appear in a Referer. The page's own view is reported
    // separately so the Service can weigh both.
    referer: workTabUrl,
    workTabUrl,
    documentReferrer: input.documentReferrer ?? null,
    referrerPolicy: input.referrerPolicy ?? null,
  };
}
