import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_STATES, USER_SCRIPTS_UNAVAILABLE, createBridgeState } from '../src/lib/bridge-state.js';
import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildCookieHeader,
  buildRequestContext,
  describeCookies,
  findAmbiguousCookieNames,
  isSameOrigin,
  isSameSite,
  maskCookieHeader,
  mergeCookieSets,
  normalizeScope,
  normalizeTargetUrl,
  normalizeTopLevelSite,
  originMatchPattern,
  resolvePartitionKey,
} from '../src/lib/request-context.js';
import { USER_AGENT_SOURCES, createRequestContextSource, supportsAncestorBit } from '../src/lib/request-context-source.js';
import { parseServiceMessage } from '../src/lib/protocol.js';

/**
 * The experimental request-context capability.
 *
 * Three layers are exercised separately, because each can fail on its own:
 * the pure decisions (no browser), the injectable browser adapter (stub
 * `chrome.*`), and the state machine's short path (stub connection).
 *
 * The browser APIs themselves are covered end to end by
 * `tests/poc/request-context.mjs`, which drives the real extension.
 */

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

test('normalizeTargetUrl accepts http(s) and drops the fragment', () => {
  assert.deepEqual(normalizeTargetUrl('https://example.test/a/b?c=1#frag'), {
    ok: true,
    url: 'https://example.test/a/b?c=1',
  });
  assert.deepEqual(normalizeTargetUrl('http://127.0.0.1:8080/x#one'), normalizeTargetUrl('http://127.0.0.1:8080/x#two'));
});

test('normalizeTargetUrl refuses everything that is not an absolute http(s) URL', () => {
  for (const raw of ['', 'media/1', '/media/1', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/plain,x', 'chrome://settings', 42, null, undefined]) {
    const result = normalizeTargetUrl(raw);
    assert.equal(result.ok, false, `${String(raw)} 不应被接受`);
    assert.equal(typeof result.reason, 'string');
  }
});

test('normalizeTargetUrl refuses embedded credentials instead of rewriting them', () => {
  assert.equal(normalizeTargetUrl('https://user:secret@example.test/media').ok, false);
});

test('normalizeScope defaults to the strict scope and refuses anything else', () => {
  assert.deepEqual(normalizeScope(undefined), { ok: true, scope: TARGET_SCOPES.WORK_TAB_ORIGIN });
  assert.deepEqual(normalizeScope(null), { ok: true, scope: TARGET_SCOPES.WORK_TAB_ORIGIN });
  assert.deepEqual(normalizeScope(TARGET_SCOPES.TARGET_ONLY), { ok: true, scope: TARGET_SCOPES.TARGET_ONLY });
  // Coercing "ANY" to the strict scope would answer a different question than the
  // Service asked, so an unknown value is an error.
  for (const raw of ['ANY', 'work_tab_origin', 42, {}]) {
    assert.equal(normalizeScope(raw).ok, false, `${String(raw)} 不应被接受`);
  }
});

test('isSameOrigin compares origins, never site names', () => {
  assert.equal(isSameOrigin('https://a.test/x', 'https://a.test/y?z'), true);
  assert.equal(isSameOrigin('https://a.test/x', 'https://b.a.test/x'), false);
  assert.equal(isSameOrigin('https://a.test/x', 'http://a.test/x'), false);
  assert.equal(isSameOrigin('https://a.test:443/x', 'https://a.test/y'), true);
  assert.equal(isSameOrigin('not a url', 'https://a.test'), false);
});

test('buildCookieHeader orders longer paths first but keeps the browser order within a path', () => {
  assert.equal(
    buildCookieHeader([
      { name: 'b', value: '1', path: '/' },
      { name: 'a', value: '2', path: '/deep/path' },
      { name: 'c', value: '3', path: '/deep' },
    ]),
    'a=2; c=3; b=1',
  );
  // Measured on Chrome for Testing 153: `chrome.cookies.getAll({url})` returns
  // cookies in the order the browser itself sends them, and the API exposes no
  // creation time to reproduce that order any other way. Sorting by name would
  // change a header the Service is trying to reproduce byte for byte.
  assert.equal(
    buildCookieHeader([
      { name: 'sid', value: '1', path: '/' },
      { name: 'theme', value: '2', path: '/' },
      { name: 'strict', value: '3', path: '/' },
    ]),
    'sid=1; theme=2; strict=3',
  );
});

test('buildCookieHeader is total, keeps nameless cookies, and never invents a value', () => {
  assert.equal(buildCookieHeader(undefined), '');
  assert.equal(buildCookieHeader([null, {}, { name: '' }, { name: 'ok' }]), 'ok=');
  // A nameless cookie with a value is a legacy form Chrome can hold and send; the
  // metadata counts it, so the header must carry it too.
  assert.equal(buildCookieHeader([{ name: '', value: 'legacy', path: '/' }]), '=legacy');
  assert.equal(buildCookieHeader([{ name: '', value: '' }]), '', '两边都空才是真的什么都没有');
});

test('duplicate cookie names are surfaced instead of silently ordered', () => {
  // A partitioned cookie and an unpartitioned one are different cookies, so they
  // can share a name and a path; both match a request and Chrome sends both, ordered
  // by path length then creation time — which the API does not expose. What the
  // *merge* loses is the relative order between the two responses, and only that.
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
    workTabUrl: WORK_TAB_URL,
    cookies: [
      { name: 'sid', value: 'unpartitioned', path: '/' },
      { name: 'sid', value: 'partitioned', path: '/', partitionKey: { topLevelSite: WORK_TAB_ORIGIN } },
      { name: 'theme', value: 'dark', path: '/' },
    ],
    duplicateCookieNames: findAmbiguousCookieNames({
      unpartitioned: [{ name: 'sid', path: '/' }, { name: 'theme', path: '/' }],
      partitioned: [{ name: 'sid', path: '/' }],
    }),
    userAgent: 'UA/1.0',
    userAgentSource: USER_AGENT_SOURCES.PAGE,
    observedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(context.cookieHeader, 'sid=unpartitioned; sid=partitioned; theme=dark');
  assert.deepEqual(context.duplicateCookieNames, ['sid']);
  assert.equal(context.cookies.find((cookie) => cookie.value !== undefined), undefined, '元数据里没有值');
  assert.deepEqual(context.cookies.map((cookie) => cookie.partitioned), [false, true, false]);

  // Without a computed ambiguity the field stays empty rather than guessed.
  assert.deepEqual(
    buildRequestContext({
      targetUrl: 'https://cdn.test/media/1',
      scope: TARGET_SCOPES.TARGET_ONLY,
      workTabUrl: WORK_TAB_URL,
      cookies: [{ name: 'sid', value: 'v', path: '/' }],
      userAgent: 'UA/1.0',
      userAgentSource: USER_AGENT_SOURCES.PAGE,
      observedAt: '2026-01-01T00:00:00.000Z',
    }).duplicateCookieNames,
    [],
  );
});

test('findAmbiguousCookieNames only reports ties between the two queries', () => {
  // Within one `getAll` response the API returns Chrome's own order and the stable
  // sort keeps it, so a repeated name from a single query — two matching domains
  // carrying the same name, say — is not ambiguous.
  assert.deepEqual(
    findAmbiguousCookieNames({
      unpartitioned: [
        { name: 'sid', path: '/' },
        { name: 'sid', path: '/' },
      ],
      partitioned: [],
    }),
    [],
  );

  // Across the two responses the relative order is lost: that is the ambiguous case.
  assert.deepEqual(
    findAmbiguousCookieNames({
      unpartitioned: [{ name: 'sid', path: '/' }],
      partitioned: [{ name: 'sid', path: '/' }],
    }),
    ['sid'],
  );

  // Different path lengths are ordered deterministically (longest first) in either
  // response, so they are never a tie — even across the two.
  assert.deepEqual(
    findAmbiguousCookieNames({
      unpartitioned: [
        { name: 'sid', path: '/media' },
        { name: 'sid', path: '/' },
      ],
      partitioned: [{ name: 'sid', path: '/deep/media' }],
    }),
    [],
  );

  // A partition query that was skipped (or returned nothing) cannot create a tie.
  assert.deepEqual(findAmbiguousCookieNames({ unpartitioned: [{ name: 'sid', path: '/' }] }), []);
  assert.deepEqual(findAmbiguousCookieNames(), []);

  // Same length, different path: still a tie, because only the length orders them.
  assert.deepEqual(
    findAmbiguousCookieNames({
      unpartitioned: [{ name: 'sid', path: '/aa' }],
      partitioned: [{ name: 'sid', path: '/bb' }],
    }),
    ['sid'],
  );
});

test('describeCookies reports metadata, never a value, and stays JSON-compatible', () => {
  const described = describeCookies([
    {
      name: 'sid',
      value: 'super-secret',
      domain: 'example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      partitionKey: { topLevelSite: 'https://top.test' },
      // A field the browser may add later must not travel to the Service.
      futureField: 'should-not-appear',
    },
  ]);
  assert.deepEqual(described, [
    {
      name: 'sid',
      domain: 'example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      partitioned: true,
      topLevelSite: 'https://top.test',
    },
  ]);
  assert.equal(JSON.stringify(described).includes('super-secret'), false);
  assert.equal(JSON.stringify(described).includes('should-not-appear'), false);
});

test('maskCookieHeader keeps names and removes every value', () => {
  assert.equal(maskCookieHeader('sid=abc; theme=dark'), 'sid=***; theme=***');
  assert.equal(maskCookieHeader(''), '');
  assert.equal(maskCookieHeader('flag'), 'flag=***');
});

test('normalizeTopLevelSite keeps the origin, and mergeCookieSets concatenates partitions', () => {
  assert.deepEqual(normalizeTopLevelSite('https://top.test/page?x=1#frag'), {
    ok: true,
    topLevelSite: 'https://top.test',
  });
  assert.equal(normalizeTopLevelSite('file:///tmp/x').ok, false);
  assert.deepEqual(mergeCookieSets([{ name: 'sid' }], [{ name: 'part' }]).map((cookie) => cookie.name), ['sid', 'part']);
  assert.deepEqual(mergeCookieSets(undefined, undefined), []);
});

test('resolvePartitionKey always names exactly one partition', () => {
  // No partition query at all when the caller opts out.
  assert.deepEqual(resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, topLevelSite: null }), {
    ok: true,
    partitionKey: null,
  });

  // Same site (ports ignored): the request is not cross-site, so neither is the bit.
  assert.deepEqual(resolvePartitionKey({ targetUrl: `${WORK_TAB_ORIGIN}/media/1`, workTabUrl: WORK_TAB_URL }), {
    ok: true,
    partitionKey: { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: false },
  });
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://app.test:8443/x', workTabUrl: WORK_TAB_URL }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: false },
  );

  // A sibling subdomain is a different origin but the *same site* — deriving from
  // origins would wrongly look in the cross-site partition.
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://cdn.example.com/x', workTabUrl: 'https://app.example.com/feed' }).partitionKey,
    { topLevelSite: 'https://app.example.com', hasCrossSiteAncestor: false },
  );

  // A genuinely cross-site target does use the cross-site partition (measured: this
  // is the case where Chrome sends the third-party frame's cookie).
  assert.deepEqual(resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL }), {
    ok: true,
    partitionKey: { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: true },
  });

  // An explicit bit always wins — the escape hatch for the cases the PSL-free site
  // approximation cannot see (multi-label public suffixes such as `a.co.uk`).
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: `${WORK_TAB_ORIGIN}/a`, workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: true }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: true },
  );
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: false }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: false },
  );

  // An explicit site replaces the Work Tab default.
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, topLevelSite: 'https://other.test/x' }).partitionKey,
    { topLevelSite: 'https://other.test', hasCrossSiteAncestor: true },
  );

  assert.equal(resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: 'yes' }).ok, false);
  // The opt-out does not excuse a malformed bit: rejecting beats reinterpreting.
  assert.equal(
    resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, topLevelSite: null, hasCrossSiteAncestor: 'yes' }).ok,
    false,
  );
  assert.equal(resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, topLevelSite: 'nope' }).ok, false);

  // A browser older than the bit (Chrome < 130) gets a site-only key rather than a
  // query the API would reject — including for targets with no partitioned cookies.
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, supportsAncestorBit: false }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN },
  );
  assert.deepEqual(
    resolvePartitionKey({ targetUrl: 'https://cdn.test/a', workTabUrl: WORK_TAB_URL, topLevelSite: null, supportsAncestorBit: false }),
    { ok: true, partitionKey: null },
  );
});

test('the ancestor bit is only sent to browsers that have it', () => {
  assert.equal(supportsAncestorBit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36'), true);
  assert.equal(supportsAncestorBit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36'), true);
  assert.equal(supportsAncestorBit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'), true);
  assert.equal(supportsAncestorBit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'), false);
  assert.equal(supportsAncestorBit('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), false);
  // Unknown is treated as unsupported: leaving the field out works everywhere,
  // sending it to an old browser breaks every read.
  assert.equal(supportsAncestorBit('something else'), false);
  assert.equal(supportsAncestorBit(''), false);
});

test('isSameSite compares scheme and registrable host, not origins', () => {
  assert.equal(isSameSite('https://app.test:8443/a', 'https://app.test/b'), true, '端口不构成不同站点');
  assert.equal(isSameSite('https://cdn.example.com/a', 'https://app.example.com/b'), true, '同注册域的子域同站');
  assert.equal(isSameSite('http://app.test/a', 'https://app.test/b'), false, 'schemeful site');
  assert.equal(isSameSite('http://127.0.0.1:8080/a', 'http://localhost:8080/b'), false, 'IP 与主机名不同站');
  assert.equal(isSameSite('http://127.0.0.1:8080/a', 'http://127.0.0.1:9090/b'), true, 'IP 字面量按自身比较');
  assert.equal(isSameSite('not a url', 'https://app.test'), false);
  // Documented limitation: without a public suffix list, two registrable domains
  // under a multi-label suffix look like one site. An explicit bit is the escape.
  assert.equal(isSameSite('https://a.co.uk/x', 'https://b.co.uk/y'), true);
});


test('buildRequestContext separates the suggested referer from the page-reported fact', () => {
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1?sign=a',
    scope: TARGET_SCOPES.WORK_TAB_ORIGIN,
    workTabUrl: 'https://cdn.test/feed#top',
    cookies: [
      { name: 'sid', value: 'v1', path: '/', httpOnly: true, sameSite: 'lax' },
      { name: 'theme', value: 'dark', path: '/', httpOnly: false },
    ],
    userAgent: 'UA/1.0',
    userAgentSource: USER_AGENT_SOURCES.PAGE,
    observedAt: '2026-01-01T00:00:00.000Z',
    documentReferrer: 'https://other.test/from',
    referrerPolicy: null,
    serviceWorkerUserAgent: 'UA/1.0',
  });

  assert.equal(context.cookieHeader, 'sid=v1; theme=dark');
  assert.equal(context.targetOrigin, 'https://cdn.test');
  assert.equal(context.httpOnlyCookieCount, 1);
  assert.equal(context.observedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(context.referer, 'https://cdn.test/feed#top');
  assert.equal(context.workTabUrl, 'https://cdn.test/feed#top');
  assert.equal(context.documentReferrer, 'https://other.test/from');
  assert.equal(context.referrerPolicy, null);
});

test('buildRequestContext refuses to invent a work tab URL or a user agent', () => {
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
    workTabUrl: undefined,
    cookies: [],
    userAgent: null,
    userAgentSource: USER_AGENT_SOURCES.SERVICE_WORKER,
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(context.referer, '');
  assert.equal(context.cookieHeader, '');
  assert.equal(context.userAgent, null);
  assert.equal(context.documentReferrer, null);
  assert.equal(context.referrerPolicy, null);
});

// ---------------------------------------------------------------------------
// The injectable browser adapter
// ---------------------------------------------------------------------------

const WORK_TAB_URL = 'https://app.test/feed';
const WORK_TAB_ORIGIN = 'https://app.test';

function createStubChrome({
  cookies = [],
  partitioned = [],
  tabUrl = WORK_TAB_URL,
  tabUrls = null,
  pageFacts = { userAgent: 'PageUA/1.0', documentReferrer: '', referrerPolicy: null, pageUrl: WORK_TAB_URL },
  documentIds = null,
  failCookies = false,
  failScripting = false,
  tabMissing = false,
  denyTargetAccess = false,
  withPermissionsApi = true,
  grantedOrigins = null,
  revokeAllUrlsAfterFirst = false,
  cookieStores = [{ id: '0', tabIds: [1] }],
  failCookieStores = false,
} = {}) {
  const calls = { getAll: [], executeScript: [], get: [], contains: [], getAllCookieStores: [] };
  let tabReads = 0;
  let factReads = 0;
  let allUrlsQueries = 0;
  const stub = {
    calls,
    cookies: {
      async getAll(details) {
        calls.getAll.push(details);
        if (failCookies) throw new Error('cookies boom');
        return details.partitionKey ? partitioned : cookies;
      },
      async getAllCookieStores() {
        calls.getAllCookieStores.push(true);
        if (failCookieStores) throw new Error('stores boom');
        return cookieStores;
      },
    },
    tabs: {
      async get(tabId) {
        calls.get.push(tabId);
        if (tabMissing) throw new Error('No tab with id');
        // `tabUrls` models a page that navigates between two reads of the tab.
        const url = tabUrls === null ? tabUrl : tabUrls[Math.min(tabReads, tabUrls.length - 1)];
        tabReads += 1;
        return { id: tabId, url };
      },
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push(details);
        if (failScripting) throw new Error('cannot script this page');
        // `pageFacts` may be one object or one per read, so a test can make the
        // page and the tab disagree on the first attempt only. `documentIds` names the
        // document each read came from, which is how a same-URL reload is noticed.
        const facts = Array.isArray(pageFacts) ? pageFacts[Math.min(factReads, pageFacts.length - 1)] : pageFacts;
        const documentId = documentIds === null ? undefined : documentIds[Math.min(factReads, documentIds.length - 1)];
        factReads += 1;
        return [{ result: facts, ...(documentId === undefined ? {} : { documentId }) }];
      },
    },
  };
  if (withPermissionsApi) {
    stub.permissions = {
      async contains({ origins }) {
        calls.contains.push(origins);
        if (denyTargetAccess) return false;
        if (origins[0] === '<all_urls>') {
          allUrlsQueries += 1;
          // Models an operator narrowing access while the reads are in flight.
          if (revokeAllUrlsAfterFirst && allUrlsQueries > 1) return false;
        }
        // `grantedOrigins` models a user who allowed some sites only; by default the
        // extension's `<all_urls>` grant answers yes to everything asked.
        if (grantedOrigins === null) return true;
        return origins.every((pattern) => grantedOrigins.includes(pattern));
      },
    };
  }
  return stub;
}

/** The POC runs on modern Chrome, so the ancestor bit is available unless a test says otherwise. */
function createSource(stub, { ancestorBitSupport = () => true } = {}) {
  return createRequestContextSource({
    cookies: stub.cookies,
    tabs: stub.tabs,
    scripting: stub.scripting,
    ...(stub.permissions === undefined ? {} : { permissions: stub.permissions }),
    ancestorBitSupport,
    logger: {},
  });
}

test('available only when all three browser APIs are present', () => {
  const stub = createStubChrome();
  assert.equal(createSource(stub).isAvailable(), true);
  // No injection at all: in Node there is no `chrome`, so the answer is "no" and
  // `read` reports NOT_READY instead of throwing.
  assert.equal(createRequestContextSource({}).isAvailable(), false);
  assert.equal(
    createRequestContextSource({ cookies: stub.cookies, tabs: stub.tabs, scripting: {} }).isAvailable(),
    false,
  );
});

test('reads cookies for exactly the target URL and includes HttpOnly ones', async () => {
  const stub = createStubChrome({
    cookies: [
      { name: 'sid', value: 'secret', path: '/', httpOnly: true, sameSite: 'lax' },
      { name: 'theme', value: 'dark', path: '/', httpOnly: false, sameSite: 'lax' },
    ],
  });
  const outcome = await createSource(stub).read({ tabId: 7, targetUrl: `${WORK_TAB_ORIGIN}/media/1?sign=x` });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.context.cookieHeader, 'sid=secret; theme=dark');
  assert.equal(outcome.context.httpOnlyCookieCount, 1);
  assert.equal(outcome.context.referer, WORK_TAB_URL);
  assert.equal(outcome.context.userAgent, 'PageUA/1.0');
  assert.equal(outcome.context.userAgentSource, USER_AGENT_SOURCES.PAGE);

  // Every query is scoped to the target URL: there is no `getAll({})` and no
  // `getAll({domain})` that could hand over the whole cookie store.
  assert.equal(stub.calls.getAll.length, 2, '未分区查询 + 默认分区查询');
  for (const details of stub.calls.getAll) {
    assert.equal(details.url, `${WORK_TAB_ORIGIN}/media/1?sign=x`);
    assert.equal('domain' in details, false);
  }
  // The default partition is the Work Tab's own origin plus the exact ancestor
  // bit, because a subresource of that page lives in exactly one partition.
  assert.deepEqual(stub.calls.getAll[1].partitionKey, {
    topLevelSite: WORK_TAB_ORIGIN,
    hasCrossSiteAncestor: false,
  });
  assert.deepEqual(stub.calls.get, [7, 7], '采样前读一次、页面事实之后再确认一次');
});

test('partitioned cookies are merged in, and an explicit null skips the partition query', async () => {
  const stub = createStubChrome({
    cookies: [{ name: 'sid', value: 's', path: '/' }],
    partitioned: [{ name: 'part', value: 'p', path: '/', partitionKey: { topLevelSite: WORK_TAB_ORIGIN } }],
  });
  const source = createSource(stub);

  const withDefault = await source.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.deepEqual(withDefault.context.cookies.map((cookie) => cookie.name), ['sid', 'part']);
  assert.equal(withDefault.context.partitionedCookieCount, 1);

  const skipped = await source.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1`, topLevelSite: null });
  assert.deepEqual(skipped.context.cookies.map((cookie) => cookie.name), ['sid']);
  assert.equal(stub.calls.getAll.filter((details) => 'partitionKey' in details).length, 1);

  const named = await source.read({
    tabId: 1,
    targetUrl: `${WORK_TAB_ORIGIN}/media/1`,
    topLevelSite: 'https://top.test/page',
  });
  assert.equal(named.ok, true);
  // The target is cross-site relative to the named top-level site, so the derived
  // bit is true — the same rule as the default, applied to the caller's site.
  assert.deepEqual(stub.calls.getAll.at(-1).partitionKey, {
    topLevelSite: 'https://top.test',
    hasCrossSiteAncestor: true,
  });

  // A cross-site target keeps its own (cross-site) partition: deriving the bit from
  // the two sites is what makes this land in the partition Chrome uses.
  const crossOrigin = await source.read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(crossOrigin.ok, true);
  assert.deepEqual(stub.calls.getAll.at(-1).partitionKey, {
    topLevelSite: WORK_TAB_ORIGIN,
    hasCrossSiteAncestor: true,
  });
});

test('the default scope refuses a cross-origin target, TARGET_ONLY allows it', async () => {
  const stub = createStubChrome({ cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const source = createSource(stub);

  const refused = await source.read({ tabId: 1, targetUrl: 'https://cdn.test/media/1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE);
  assert.equal(stub.calls.getAll.length, 0, '越界请求不得触碰 cookie API');

  const allowed = await source.read({ tabId: 1, targetUrl: 'https://cdn.test/media/1', scope: TARGET_SCOPES.TARGET_ONLY });
  assert.equal(allowed.ok, true);
  assert.equal(stub.calls.getAll[0].url, 'https://cdn.test/media/1');
});

test('refuses a bad target, a bad scope and a bad partition without touching the browser', async () => {
  const stub = createStubChrome();
  const source = createSource(stub);

  const badTarget = await source.read({ tabId: 1, targetUrl: 'file:///etc/passwd' });
  assert.equal(badTarget.code, CONTEXT_ERROR_CODES.INVALID_TARGET_URL);

  const badScope = await source.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1`, scope: 'ANY' });
  assert.equal(badScope.code, CONTEXT_ERROR_CODES.INVALID_SCOPE);

  const badPartition = await source.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1`, topLevelSite: 'nope' });
  assert.equal(badPartition.code, CONTEXT_ERROR_CODES.INVALID_PARTITION);

  const badBit = await source.read({
    tabId: 1,
    targetUrl: `${WORK_TAB_ORIGIN}/media/1`,
    hasCrossSiteAncestor: 'yes',
  });
  assert.equal(badBit.code, CONTEXT_ERROR_CODES.INVALID_PARTITION);

  assert.deepEqual(stub.calls.getAll, []);
  assert.deepEqual(stub.calls.executeScript, []);
});

test('a navigation during the sample is retried, and never answered with a mixture', async () => {
  // Attempt 1 sees the old tab URL and the new page's facts — the race the retry
  // exists for. Attempt 2 sees a settled page and answers from it.
  const newPage = 'https://moved.test/feed';
  const newFacts = { userAgent: 'NewUA/1.0', documentReferrer: '', referrerPolicy: null, pageUrl: newPage };
  const retried = createStubChrome({
    tabUrls: [WORK_TAB_URL, newPage, newPage],
    pageFacts: [newFacts],
    cookies: [{ name: 'sid', value: 's', path: '/' }],
  });
  const outcome = await createSource(retried).read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.context.userAgent, 'NewUA/1.0');
  assert.equal(outcome.context.workTabUrl, newPage, '重试后必须以新页面为准');
  assert.equal(outcome.context.referer, newPage);
  assert.equal(retried.calls.getAll.length, 4, '两次采样，每次两个查询');
  // The partition follows the page the answer actually describes.
  assert.deepEqual(retried.calls.getAll.at(-1).partitionKey, {
    topLevelSite: 'https://moved.test',
    hasCrossSiteAncestor: true,
  });

  // With the strict scope the same race ends in a refusal, not in a mixture: the
  // page the caller asked about is no longer the page the tab is on.
  const strict = createStubChrome({
    tabUrls: [WORK_TAB_URL, newPage, newPage],
    pageFacts: [newFacts],
    cookies: [{ name: 'sid', value: 's', path: '/' }],
  });
  const refused = await createSource(strict).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE);

  // A tab whose URL and page facts never agree must not produce a mixture either.
  const alwaysMoving = createStubChrome({
    tabUrls: [WORK_TAB_URL, WORK_TAB_URL],
    pageFacts: [newFacts],
  });
  const mixed = await createSource(alwaysMoving).read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(mixed.message, /导航/);
});

test('a name shared across the two queries is reported as ambiguous', async () => {
  // Two `getAll` responses are merged, and only the merge loses ordering: the same
  // name and path length in both means the header's order is Bridge's choice, not
  // Chrome's. Within one response the API's order is kept, so that case is silent.
  const stub = createStubChrome({
    cookies: [{ name: 'sid', value: 'unpartitioned', path: '/' }],
    partitioned: [{ name: 'sid', value: 'partitioned', path: '/', partitionKey: { topLevelSite: WORK_TAB_ORIGIN } }],
  });
  const outcome = await createSource(stub).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.context.cookieHeader, 'sid=unpartitioned; sid=partitioned');
  assert.deepEqual(outcome.context.duplicateCookieNames, ['sid']);

  // Only one of the two queries returned it: no tie, nothing to report.
  const single = createStubChrome({ cookies: [{ name: 'sid', value: 'only', path: '/' }] });
  const alone = await createSource(single).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.deepEqual(alone.context.duplicateCookieNames, []);
});

test('a browser without the ancestor bit still gets a context, marked as site-only', async () => {
  // Chrome 119–129 would reject the whole query for an unsupported field — including
  // reads of targets that have no partitioned cookies at all — so the bit is left out
  // there and the answer says the partition was chosen by site alone.
  const stub = createStubChrome({ cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const outcome = await createSource(stub, { ancestorBitSupport: () => false }).read({
    tabId: 1,
    targetUrl: `${WORK_TAB_ORIGIN}/media/1`,
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(stub.calls.getAll[1].partitionKey, { topLevelSite: WORK_TAB_ORIGIN });
  assert.equal(outcome.context.exactPartitionSelection, false);

  // On a supported browser the bit is present and the answer says the partition is exact.
  const modern = createStubChrome({ cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const exact = await createSource(modern).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.deepEqual(modern.calls.getAll[1].partitionKey, {
    topLevelSite: WORK_TAB_ORIGIN,
    hasCrossSiteAncestor: false,
  });
  assert.equal(exact.context.exactPartitionSelection, true);
});

test('reads the cookie store the Work Tab actually lives in', async () => {
  // Incognito is a separate store, and `getAll` without `storeId` would answer from
  // the worker's own (regular-profile) store — omitting the incognito session and
  // handing back regular cookies in its place.
  const stub = createStubChrome({
    cookies: [{ name: 'sid', value: 's', path: '/' }],
    partitioned: [{ name: 'part', value: 'p', path: '/' }],
    cookieStores: [
      { id: '0', tabIds: [7] },
      { id: '1', tabIds: [1] },
    ],
  });
  const outcome = await createSource(stub).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(outcome.ok, true);
  assert.equal(stub.calls.getAll.length, 2);
  for (const details of stub.calls.getAll) {
    assert.equal(details.storeId, '1', '两个查询都必须落在 Work Tab 自己的 store 上');
  }

  // A tab no store claims keeps the default rather than guessing one.
  const orphan = createStubChrome({ cookieStores: [{ id: '0', tabIds: [99] }] });
  assert.equal((await createSource(orphan).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` })).ok, true);
  for (const details of orphan.calls.getAll) {
    assert.equal('storeId' in details, false);
  }

  // Failing to enumerate stores is reported instead of silently using the default.
  const failing = createStubChrome({ failCookieStores: true });
  const refused = await createSource(failing).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(refused.message, /store/);
  assert.deepEqual(failing.calls.getAll, []);
});

test('withheld access to a cross-origin target is reported, not answered with an empty set', async () => {
  // Site access is per origin: the Work Tab stays scriptable while the CDN's cookies
  // are filtered out silently, so "no cookies" and "not allowed to look" are
  // indistinguishable from the result alone.
  const denied = createStubChrome({ denyTargetAccess: true, cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const refused = await createSource(denied).read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(refused.message, /没有访问权限/);
  // The blanket grant is asked first, then the target's own origin (no port).
  assert.deepEqual(denied.calls.contains, [['<all_urls>'], ['https://cdn.test/*']]);
  assert.deepEqual(denied.calls.getAll, [], '越权时不应再读 cookie');

  // The normal case: the manifest's blanket grant is intact, so nothing can have
  // been filtered per cookie and the set is complete.
  const granted = createStubChrome({ cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const allowed = await createSource(granted).read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(allowed.ok, true);
  // Asked once before the reads and once after them, so a revocation in between
  // cannot leave a stale completeness claim.
  assert.deepEqual(granted.calls.contains, [['<all_urls>'], ['<all_urls>']]);
  assert.equal(allowed.context.hostAccessCoverage, 'all');

  // Without the API the check is skipped rather than guessed, and the answer says so.
  const noApi = createStubChrome({ withPermissionsApi: false });
  const skipped = await createSource(noApi).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.context.hostAccessCoverage, 'unknown');
});

test('a narrower grant still answers, but marks the set as origin-only', async () => {
  // Site access restricted to the target origin: cookies whose Domain is a parent
  // domain may have been filtered out, and only a public suffix list could tell
  // whether one existed. Refusing a valid target would be wrong for `co.uk`-style
  // hosts, so the answer carries what could be established.
  const pageFacts = { userAgent: 'PageUA/1.0', documentReferrer: '', referrerPolicy: null, pageUrl: 'https://app.example.com/feed' };
  const stub = createStubChrome({
    cookies: [{ name: 'sid', value: 's', path: '/' }],
    grantedOrigins: ['https://app.example.com/*'],
    tabUrl: 'https://app.example.com/feed',
    pageFacts,
  });
  const outcome = await createSource(stub).read({ tabId: 1, targetUrl: 'https://app.example.com/media/1' });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.context.hostAccessCoverage, 'origin');
  // First check, then the same two questions again as the post-read revalidation.
  assert.deepEqual(stub.calls.contains, [
    ['<all_urls>'],
    ['https://app.example.com/*'],
    ['<all_urls>'],
    ['https://app.example.com/*'],
  ]);

  // The same narrow grant, but for a different origin: nothing is visible, so the
  // request is refused instead of answered with an empty header.
  const elsewhere = createStubChrome({ grantedOrigins: ['https://other.test/*'] });
  const refused = await createSource(elsewhere).read({
    tabId: 1,
    targetUrl: 'https://app.example.com/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.deepEqual(elsewhere.calls.getAll, []);
});

test('a coverage change during the reads is refused, not answered with a stale claim', async () => {
  // The blanket grant is intact when the request starts and gone by the time the
  // cookies have been read: `getAll` would have filtered silently, so the answer must
  // not still say 'all'.
  const stub = createStubChrome({
    cookies: [{ name: 'sid', value: 's', path: '/' }],
    revokeAllUrlsAfterFirst: true,
  });
  const refused = await createSource(stub).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(refused.message, /访问权限在采样期间发生了变化/);
  // 第一次问整块授权、第二次复核它，第三次确认目标 origin 仍然可见。
  assert.deepEqual(stub.calls.contains, [['<all_urls>'], ['<all_urls>'], ['https://app.test/*']]);
});

test('a reload that keeps the URL is detected by document identity', async () => {
  // Attempt 1: the document is swapped between the two reads while the URL stays the
  // same, so the cookie set and the page facts describe different documents. Attempt 2
  // reads a settled document and answers from it.
  const reloaded = createStubChrome({
    documentIds: ['doc-1', 'doc-2', 'doc-2', 'doc-2'],
    pageFacts: { userAgent: 'ReloadedUA/1.0', documentReferrer: '', referrerPolicy: null, pageUrl: WORK_TAB_URL },
    cookies: [{ name: 'sid', value: 'rotated', path: '/' }],
  });
  const outcome = await createSource(reloaded).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.context.userAgent, 'ReloadedUA/1.0');
  // Two reads per attempt: one to identify the document, one after the cookies.
  assert.equal(reloaded.calls.executeScript.length, 4);

  // A page that reloads on every read never yields a consistent sample.
  const alwaysReloading = createStubChrome({
    documentIds: ['doc-1', 'doc-2', 'doc-3', 'doc-4'],
    cookies: [{ name: 'sid', value: 'rotated', path: '/' }],
  });
  const refused = await createSource(alwaysReloading).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(refused.message, /导航/);

  // Browsers that do not report a document id keep the URL-only guard.
  const noDocumentId = createStubChrome({ cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const fallback = await createSource(noDocumentId).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(fallback.ok, true);
  // One identifying read plus one after the cookies.
  assert.equal(noDocumentId.calls.executeScript.length, 2);
});

test('originMatchPattern drops the port, which match patterns do not support', () => {
  // `https://example.com:8443/*` is malformed and `permissions.contains()` rejects
  // it, which would turn every request for a non-default port into "no access".
  assert.equal(originMatchPattern('https://example.com:8443/media/1?sign=x'), 'https://example.com/*');
  assert.equal(originMatchPattern('http://127.0.0.1:8080/x'), 'http://127.0.0.1/*');
  assert.equal(originMatchPattern('https://app.example.com/x'), 'https://app.example.com/*');
  assert.equal(originMatchPattern('http://localhost:3000/x'), 'http://localhost/*');
});

test('an unscriptable page is an error, not a context with the worker user agent', async () => {
  // The usual cause is that the operator restricted the extension's access to this
  // site — and host access is shared with `chrome.cookies`, so the cookie set would
  // be silently filtered too. Answering `ok: true` would look complete while being
  // wrong about both the user agent and the cookies.
  const stub = createStubChrome({ failScripting: true, cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const outcome = await createSource(stub).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(outcome.message, /无法读取 Work Tab 页面/);
  // Chrome's rejection text can quote the whole page URL (query string included), so
  // neither the log nor the answer repeats it.
  assert.equal(outcome.message.includes('http'), false, '错误消息不得带上浏览器给的 URL');
});

test('reports NOT_READY and CONTEXT_FAILED instead of throwing', async () => {
  const missingTab = createSource(createStubChrome({ tabMissing: true }));
  const noTab = await missingTab.read({ tabId: 9, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(noTab.code, CONTEXT_ERROR_CODES.NOT_READY);

  // A Work Tab that navigated to a browser page is not a context source either.
  const notAPage = createSource(createStubChrome({ tabUrl: 'chrome://settings' }));
  assert.equal((await notAPage.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` })).code, CONTEXT_ERROR_CODES.NOT_READY);

  const failing = createSource(createStubChrome({ failCookies: true }));
  const failed = await failing.read({
    tabId: 1,
    targetUrl: `${WORK_TAB_ORIGIN}/media/1?sign=very-secret`,
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(failed.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  // The browser's own text is not forwarded: it can quote the URL it was handed,
  // signature and all. Only the error's kind and the query-free origin travel.
  assert.match(failed.message, /读取失败（Error/);
  assert.equal(failed.message.includes('very-secret'), false, '错误消息不得带上 URL 的查询串');

  const unavailable = await createRequestContextSource({}).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(unavailable.code, CONTEXT_ERROR_CODES.NOT_READY);
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test('parses GET_REQUEST_CONTEXT and carries scope and partition through', () => {
  const parsed = parseServiceMessage(
    JSON.stringify({
      type: 'GET_REQUEST_CONTEXT',
      requestId: 'rc-1',
      targetUrl: 'https://cdn.test/media/1',
      scope: TARGET_SCOPES.TARGET_ONLY,
      topLevelSite: 'https://app.test',
    }),
  );

  assert.deepEqual(parsed, {
    ok: true,
    message: {
      type: 'GET_REQUEST_CONTEXT',
      requestId: 'rc-1',
      targetUrl: 'https://cdn.test/media/1',
      scope: TARGET_SCOPES.TARGET_ONLY,
      topLevelSite: 'https://app.test',
    },
  });

  // Omitted optional fields stay omitted rather than becoming null: "not asked"
  // and "asked for the default" are different requests.
  const minimal = parseServiceMessage(JSON.stringify({ type: 'GET_REQUEST_CONTEXT', requestId: 'rc-2', targetUrl: 'https://a.test/x' }));
  assert.equal('scope' in minimal.message, false);
  assert.equal('topLevelSite' in minimal.message, false);
});

test('a malformed context frame reports the requestId so an answer can be sent', () => {
  const noTarget = parseServiceMessage(JSON.stringify({ type: 'GET_REQUEST_CONTEXT', requestId: 'rc-3' }));
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.failure, 'MISSING_TARGET_URL');
  assert.equal(noTarget.requestId, 'rc-3');
  assert.equal(noTarget.jobId, null);

  const noRequestId = parseServiceMessage(JSON.stringify({ type: 'GET_REQUEST_CONTEXT', targetUrl: 'https://a.test/x' }));
  assert.equal(noRequestId.failure, 'MISSING_REQUEST_ID');
  assert.equal(noRequestId.requestId, null, '不可用的 requestId 不得被报出');

  // The existing four messages keep reporting no requestId at all.
  const existing = parseServiceMessage(JSON.stringify({ type: 'EXECUTE', jobId: 'job-1' }));
  assert.equal(existing.requestId, null);
});

// ---------------------------------------------------------------------------
// The state machine's short path
// ---------------------------------------------------------------------------

function createFakeConnection({ url = 'ws://service.test' } = {}) {
  const sent = [];
  const state = { url };
  return {
    sent,
    get url() {
      return state.url;
    },
    repoint(nextUrl) {
      state.url = nextUrl;
    },
    send(text) {
      sent.push(JSON.parse(text));
      return true;
    },
  };
}

function createFakeWorkTab(initial = {}) {
  const state = { isBound: true, tabId: 42, reason: null, ...initial };
  return {
    /** Set by a test that wants the manager's snapshot to land during a read. */
    settle: null,
    get isBound() {
      return state.isBound;
    },
    get tabId() {
      return state.tabId;
    },
    get reason() {
      return state.reason;
    },
    set(next) {
      Object.assign(state, next);
    },
    async settled() {
      // Models `createWorkTabManager.settled()`: a pending refresh lands here.
      if (typeof this.settle === 'function') await this.settle();
    },
  };
}

/** Executor whose completion the test decides, so RUNNING is observable. */
function createControlledExecutor({ available = true } = {}) {
  let pending = null;
  return {
    isAvailable: () => available,
    execute() {
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    async settle(data) {
      pending.resolve(data);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

function createContextProvider({ available = true, outcome } = {}) {
  const requests = [];
  return {
    requests,
    isAvailable: () => available,
    async read(request) {
      requests.push(request);
      return outcome ?? {
        ok: true,
        context: {
          targetUrl: request.targetUrl,
          targetOrigin: 'https://app.test',
          cookieCount: 1,
          httpOnlyCookieCount: 1,
          userAgentSource: USER_AGENT_SOURCES.PAGE,
        },
      };
    },
  };
}

function createContextHarness({ workTab = createFakeWorkTab(), executor = createControlledExecutor(), requestContext } = {}) {
  const connection = createFakeConnection();
  const bridge = createBridgeState({
    connection,
    workTab,
    executor,
    ...(requestContext === undefined ? {} : { requestContext }),
  });
  return { bridge, connection, workTab, executor };
}

const askContext = (requestId, extra = {}) =>
  JSON.stringify({ type: 'GET_REQUEST_CONTEXT', requestId, targetUrl: 'https://app.test/media/1', ...extra });

test('answers a context request without touching the Job slot', async () => {
  const provider = createContextProvider();
  const h = createContextHarness({ requestContext: provider });

  await h.bridge.handleMessage(askContext('rc-1'));

  assert.deepEqual(h.connection.sent, [
    {
      type: 'REQUEST_CONTEXT',
      requestId: 'rc-1',
      ok: true,
      context: {
        targetUrl: 'https://app.test/media/1',
        targetOrigin: 'https://app.test',
        cookieCount: 1,
        httpOnlyCookieCount: 1,
        userAgentSource: USER_AGENT_SOURCES.PAGE,
      },
    },
  ]);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
  assert.equal(h.bridge.currentJobId, null, '上下文请求不得占用 Job 槽');
  assert.deepEqual(provider.requests, [
    {
      tabId: 42,
      targetUrl: 'https://app.test/media/1',
      scope: undefined,
      topLevelSite: undefined,
      hasCrossSiteAncestor: undefined,
    },
  ]);
});

test('serves a context request while a Job is RUNNING without disturbing it', async () => {
  const provider = createContextProvider();
  const h = createContextHarness({ requestContext: provider });

  const job = h.bridge.handleMessage(JSON.stringify({ type: 'EXECUTE', jobId: 'job-1', script: 'return 1;' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.bridge.state, BRIDGE_STATES.RUNNING);

  await h.bridge.handleMessage(askContext('rc-2'));
  assert.equal(h.connection.sent.at(-1).type, 'REQUEST_CONTEXT');
  assert.equal(h.connection.sent.at(-1).ok, true);

  // The Job model itself is unchanged: a second EXECUTE is still refused.
  await h.bridge.handleMessage(JSON.stringify({ type: 'EXECUTE', jobId: 'job-2', script: 'return 2;' }));
  assert.equal(h.connection.sent.at(-1).error.code, 'BUSY');
  assert.equal(h.bridge.currentJobId, 'job-1');

  await h.executor.settle('done');
  await job;
  assert.equal(h.connection.sent.at(-1).jobId, 'job-1');
  assert.equal(h.connection.sent.at(-1).ok, true);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
});

test('user scripts being unavailable does not block a context request', async () => {
  const h = createContextHarness({
    executor: createControlledExecutor({ available: false }),
    requestContext: createContextProvider(),
  });

  // The platform state says NOT_READY for Jobs...
  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.equal(h.connection.sent.at(-1).state, BRIDGE_STATES.NOT_READY);
  assert.equal(h.connection.sent.at(-1).reason, USER_SCRIPTS_UNAVAILABLE);

  // ...but reading cookies never runs Service JavaScript, so it still answers.
  await h.bridge.handleMessage(askContext('rc-3'));
  assert.equal(h.connection.sent.at(-1).type, 'REQUEST_CONTEXT');
  assert.equal(h.connection.sent.at(-1).ok, true);
});

test('reports NOT_READY when there is no Work Tab or no context provider', async () => {
  const unbound = createContextHarness({
    workTab: createFakeWorkTab({ isBound: false, tabId: null, reason: 'NO_WORK_TAB' }),
    requestContext: createContextProvider(),
  });
  await unbound.bridge.handleMessage(askContext('rc-4'));
  assert.equal(unbound.connection.sent.at(-1).error.code, CONTEXT_ERROR_CODES.NOT_READY);
  assert.match(unbound.connection.sent.at(-1).error.message, /NO_WORK_TAB/);

  const noProvider = createContextHarness();
  await noProvider.bridge.handleMessage(askContext('rc-5'));
  assert.equal(noProvider.connection.sent.at(-1).error.code, CONTEXT_ERROR_CODES.NOT_READY);

  const unavailable = createContextHarness({ requestContext: createContextProvider({ available: false }) });
  await unavailable.bridge.handleMessage(askContext('rc-6'));
  assert.equal(unavailable.connection.sent.at(-1).error.code, CONTEXT_ERROR_CODES.NOT_READY);
});

test('forwards the provider error and refuses a context JSON would rewrite', async () => {
  const refused = createContextHarness({
    requestContext: createContextProvider({
      outcome: { ok: false, code: CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE, message: '不同源。' },
    }),
  });
  await refused.bridge.handleMessage(askContext('rc-7'));
  assert.deepEqual(refused.connection.sent.at(-1).error, {
    code: CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE,
    message: '不同源。',
  });

  const unserializable = createContextHarness({
    requestContext: createContextProvider({ outcome: { ok: true, context: { bad: () => {} } } }),
  });
  await unserializable.bridge.handleMessage(askContext('rc-8'));
  assert.equal(unserializable.connection.sent.at(-1).ok, false);
  assert.equal(unserializable.connection.sent.at(-1).error.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
});

test('waits for a pending Work Tab snapshot before revalidating the binding', async () => {
  const workTab = createFakeWorkTab();
  // The refresh that discovers the second tab only lands when someone awaits it —
  // exactly the window the revalidation has to close.
  workTab.settle = () => workTab.set({ isBound: false, tabId: null, reason: 'MULTIPLE_TABS' });

  const connection = createFakeConnection();
  const bridge = createBridgeState({
    connection,
    workTab,
    executor: createControlledExecutor(),
    requestContext: createContextProvider(),
  });

  await bridge.handleMessage(askContext('rc-12'));

  const reply = connection.sent.at(-1);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, CONTEXT_ERROR_CODES.NOT_READY);
  assert.match(reply.error.message, /MULTIPLE_TABS/);
});

test('a context is not disclosed when the Work Tab binding changed while it was read', async () => {
  const workTab = createFakeWorkTab();
  const connection = createFakeConnection();
  const slow = {
    isAvailable: () => true,
    async read() {
      // A second ordinary tab opens while cookies and page facts are being read, so
      // Bridge becomes NOT_READY for exactly this request.
      workTab.set({ isBound: false, tabId: null, reason: 'MULTIPLE_TABS' });
      return { ok: true, context: { targetUrl: 'https://app.test/media/1' } };
    },
  };
  const bridge = createBridgeState({
    connection,
    workTab,
    executor: createControlledExecutor(),
    requestContext: slow,
  });

  await bridge.handleMessage(askContext('rc-11'));

  assert.equal(connection.sent.at(-1).type, 'REQUEST_CONTEXT');
  assert.equal(connection.sent.at(-1).ok, false);
  assert.equal(connection.sent.at(-1).error.code, CONTEXT_ERROR_CODES.NOT_READY);
  assert.match(connection.sent.at(-1).error.message, /MULTIPLE_TABS/);
});

test('a context reply is dropped when the endpoint changed while it was served', async () => {
  const slow = {
    isAvailable: () => true,
    async read() {
      connection.repoint('ws://other.test');
      return { ok: true, context: { targetUrl: 'https://app.test/media/1' } };
    },
  };
  const connection = createFakeConnection();
  const bridge = createBridgeState({
    connection,
    workTab: createFakeWorkTab(),
    executor: createControlledExecutor(),
    requestContext: slow,
  });

  await bridge.handleMessage(askContext('rc-9'), { deliveredOn: 'ws://service.test' });
  assert.deepEqual(connection.sent, [], '换了端点的回答不得发出');
});

test('a malformed context frame is answered instead of ignored', async () => {
  const h = createContextHarness({ requestContext: createContextProvider() });

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_REQUEST_CONTEXT', requestId: 'rc-10' }));
  assert.equal(h.connection.sent.length, 1);
  assert.equal(h.connection.sent[0].type, 'REQUEST_CONTEXT');
  assert.equal(h.connection.sent[0].requestId, 'rc-10');
  assert.equal(h.connection.sent[0].ok, false);

  // Without a usable requestId there is nobody to answer, and the connection
  // handler must survive it.
  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_REQUEST_CONTEXT' }));
  assert.equal(h.connection.sent.length, 1);
});
