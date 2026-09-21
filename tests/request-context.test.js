import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_STATES, USER_SCRIPTS_UNAVAILABLE, createBridgeState } from '../src/lib/bridge-state.js';
import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildCookieHeader,
  buildRequestContext,
  describeCookies,
  findDuplicateCookieNames,
  isSameOrigin,
  maskCookieHeader,
  mergeCookieSets,
  normalizeScope,
  normalizeTargetUrl,
  normalizeTopLevelSite,
  resolvePartitionKey,
} from '../src/lib/request-context.js';
import { USER_AGENT_SOURCES, createRequestContextSource } from '../src/lib/request-context-source.js';
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

test('buildCookieHeader is total and never invents a value', () => {
  assert.equal(buildCookieHeader(undefined), '');
  assert.equal(buildCookieHeader([null, {}, { name: '' }, { name: 'ok' }]), 'ok=');
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
  assert.deepEqual(resolvePartitionKey({ workTabUrl: WORK_TAB_URL, topLevelSite: null }), {
    ok: true,
    partitionKey: null,
  });

  // The default describes a request the Work Tab's own document makes, and by
  // design the top-level context is never a cross-site ancestor — whether or not
  // the target is on another site. Deriving it from the target's site would get
  // sibling subdomains and cross-site CDNs wrong in opposite directions.
  assert.deepEqual(resolvePartitionKey({ workTabUrl: WORK_TAB_URL }), {
    ok: true,
    partitionKey: { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: false },
  });

  // A request made from a third-party frame carries the bit.
  assert.deepEqual(
    resolvePartitionKey({ workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: true }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: true },
  );
  // An explicit false is honoured too (it is not nullish).
  assert.deepEqual(
    resolvePartitionKey({ workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: false }).partitionKey,
    { topLevelSite: WORK_TAB_ORIGIN, hasCrossSiteAncestor: false },
  );

  // An explicit site replaces the Work Tab default.
  assert.deepEqual(
    resolvePartitionKey({ workTabUrl: WORK_TAB_URL, topLevelSite: 'https://other.test/x' }).partitionKey,
    { topLevelSite: 'https://other.test', hasCrossSiteAncestor: false },
  );

  assert.equal(resolvePartitionKey({ workTabUrl: WORK_TAB_URL, hasCrossSiteAncestor: 'yes' }).ok, false);
  assert.equal(resolvePartitionKey({ workTabUrl: WORK_TAB_URL, topLevelSite: 'nope' }).ok, false);
});

test('duplicate cookie names are surfaced instead of silently ordered', () => {
  // A partitioned cookie and an unpartitioned one are different cookies, so they
  // can share a name and a path. Chrome sends both, ordered by path then creation
  // time — and the API exposes no creation time, so within one path length the
  // order cannot be reproduced. Saying so beats guessing.
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
    workTabUrl: WORK_TAB_URL,
    cookies: [
      { name: 'sid', value: 'unpartitioned', path: '/' },
      { name: 'sid', value: 'partitioned', path: '/', partitionKey: { topLevelSite: WORK_TAB_ORIGIN } },
      { name: 'theme', value: 'dark', path: '/' },
    ],
    userAgent: 'UA/1.0',
    userAgentSource: USER_AGENT_SOURCES.PAGE,
    observedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(context.cookieHeader, 'sid=unpartitioned; sid=partitioned; theme=dark');
  assert.deepEqual(context.duplicateCookieNames, ['sid']);
  assert.equal(context.cookies.find((cookie) => cookie.value !== undefined), undefined, '元数据里没有值');
  assert.deepEqual(context.cookies.map((cookie) => cookie.partitioned), [false, true, false]);

  assert.deepEqual(findDuplicateCookieNames([{ name: 'a' }, { name: 'b' }]), []);
  assert.deepEqual(findDuplicateCookieNames(undefined), []);
  assert.deepEqual(findDuplicateCookieNames([{ name: 'a' }, { name: 'a' }, { name: 'b' }, { name: 'b' }]), ['a', 'b']);
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
  failCookies = false,
  failScripting = false,
  tabMissing = false,
} = {}) {
  const calls = { getAll: [], executeScript: [], get: [] };
  let tabReads = 0;
  let factReads = 0;
  return {
    calls,
    cookies: {
      async getAll(details) {
        calls.getAll.push(details);
        if (failCookies) throw new Error('cookies boom');
        return details.partitionKey ? partitioned : cookies;
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
        // page and the tab disagree on the first attempt only.
        const facts = Array.isArray(pageFacts) ? pageFacts[Math.min(factReads, pageFacts.length - 1)] : pageFacts;
        factReads += 1;
        return [{ result: facts }];
      },
    },
  };
}

function createSource(stub) {
  return createRequestContextSource({ cookies: stub.cookies, tabs: stub.tabs, scripting: stub.scripting, logger: {} });
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
  assert.deepEqual(stub.calls.getAll.at(-1).partitionKey, {
    topLevelSite: 'https://top.test',
    hasCrossSiteAncestor: false,
  });

  // A cross-site target keeps the top-level bit: the request still comes from the
  // Work Tab's own document, and it is the caller that says otherwise.
  const crossOrigin = await source.read({
    tabId: 1,
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
  });
  assert.equal(crossOrigin.ok, true);
  assert.deepEqual(stub.calls.getAll.at(-1).partitionKey, {
    topLevelSite: WORK_TAB_ORIGIN,
    hasCrossSiteAncestor: false,
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
    hasCrossSiteAncestor: false,
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

test('an unscriptable page still answers, and says which user agent it used', async () => {
  const stub = createStubChrome({ failScripting: true, cookies: [{ name: 'sid', value: 's', path: '/' }] });
  const outcome = await createSource(stub).read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.context.userAgentSource, USER_AGENT_SOURCES.SERVICE_WORKER);
  assert.equal(outcome.context.documentReferrer, null);
});

test('reports NOT_READY and CONTEXT_FAILED instead of throwing', async () => {
  const missingTab = createSource(createStubChrome({ tabMissing: true }));
  const noTab = await missingTab.read({ tabId: 9, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(noTab.code, CONTEXT_ERROR_CODES.NOT_READY);

  // A Work Tab that navigated to a browser page is not a context source either.
  const notAPage = createSource(createStubChrome({ tabUrl: 'chrome://settings' }));
  assert.equal((await notAPage.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` })).code, CONTEXT_ERROR_CODES.NOT_READY);

  const failing = createSource(createStubChrome({ failCookies: true }));
  const failed = await failing.read({ tabId: 1, targetUrl: `${WORK_TAB_ORIGIN}/media/1` });
  assert.equal(failed.code, CONTEXT_ERROR_CODES.CONTEXT_FAILED);
  assert.match(failed.message, /cookies boom/);

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
