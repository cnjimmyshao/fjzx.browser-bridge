/**
 * POC runner — the Service half of issue #13.
 *
 * It plays the flow the issue asks to prove, end to end, on a local origin that
 * behaves like a session-protected host:
 *
 *   browser logged in → the page/Runtime learns a resource URL → the Service asks
 *   the extension for that URL's minimal request context → the extension answers
 *   → a Node client replays the request and gets the same bytes the browser got.
 *
 * Everything it proves is a *check* in the evidence file, including the controls
 * that make the claim falsifiable: the same download without the context must
 * fail, an unrelated origin must yield nothing, and an out-of-scope URL must be
 * refused. Cookie values are never written to the console or to the evidence:
 * the runner logs masked headers and hashes.
 *
 * Run: node poc/service/run-poc.mjs
 * (optional) CHROMIUM_EXECUTABLE=<path> / POC_HEADLESS=0 / POC_KEEP_BROWSER=1
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser } from './browser.mjs';
import { startPocServer } from './poc-server.mjs';
import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  maskCookieHeader,
} from '../extension/lib/request-context.js';
import { startTestWebSocketServer } from '../../tests/helpers/ws-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const extensionDir = path.join(repoRoot, 'poc', 'extension');
const evidenceDir = path.join(repoRoot, 'poc', 'evidence');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const checks = [];
const observations = [];

function check(id, ok, detail) {
  checks.push({ id, ok: ok === true, detail });
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${id}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
  return ok === true;
}

function observe(id, detail) {
  observations.push({ id, detail });
  console.log(`NOTE  ${id}  ${JSON.stringify(detail)}`);
}

async function waitFor(describe, predicate, { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${describe}（最后结果 ${JSON.stringify(last)}）`);
}

/** Send one request and wait for the matching reply. */
async function ask(connection, message, predicate, timeoutMs = 20000) {
  connection.send(JSON.stringify(message));
  const text = await connection.waitForMessage((candidate) => {
    try {
      return predicate(JSON.parse(candidate));
    } catch {
      return false;
    }
  }, timeoutMs);
  return JSON.parse(text);
}

async function main() {
  const server = await startPocServer();
  const ws = await startTestWebSocketServer({ connectTimeoutMs: 30000 });
  const profileDir = await mkdtemp(path.join(tmpdir(), 'bridge-request-context-poc-'));
  const startedAt = new Date().toISOString();

  let browser = null;
  let pageTargetId = null;
  let connection = null;
  let requestSequence = 0;

  const nodeFetch = async (url, { cookieHeader, userAgent, referer, range } = {}) => {
    const headers = {};
    if (cookieHeader !== undefined) headers.cookie = cookieHeader;
    if (userAgent !== undefined) headers['user-agent'] = userAgent;
    if (referer !== undefined) headers.referer = referer;
    if (range !== undefined) headers.range = range;
    const response = await fetch(url, { headers, redirect: 'follow' });
    const buffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes: buffer.length, digest: sha256(buffer) };
  };

  /**
   * A request with no `User-Agent` at all.
   *
   * `fetch` cannot express this: undici always sends one (`user-agent: node`),
   * which is itself worth knowing — a Service that forgets to set the browser's
   * UA does not send "nothing", it sends a bot signature. `node:http` omits the
   * header unless asked, so the control uses it.
   */
  const nodeFetchWithoutUserAgent = (url, { cookieHeader, referer } = {}) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        url,
        { method: 'GET', headers: { cookie: cookieHeader, referer } },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, bytes: Buffer.concat(chunks).length }));
        },
      );
      request.on('error', reject);
      request.end();
    });

  const contextOf = async (targetUrl, scope, topLevelSite) => {
    await ensureConnection();
    requestSequence += 1;
    const requestId = `rc-${requestSequence}`;
    const reply = await ask(
      connection,
      {
        type: 'GET_REQUEST_CONTEXT',
        requestId,
        targetUrl,
        ...(scope === undefined ? {} : { scope }),
        ...(topLevelSite === undefined ? {} : { topLevelSite }),
      },
      (message) => message.type === 'REQUEST_CONTEXT' && message.requestId === requestId,
    );
    return reply;
  };

  /** A suspended MV3 worker drops its socket; any tab event wakes it and it re-dials. */
  async function ensureConnection() {
    if (connection !== null && connection.closed !== true) return connection;
    const accepted = ws.totalAccepted();
    const wake = await browser.newPage('about:blank');
    await browser.client.send('Target.closeTarget', { targetId: wake.targetId }).catch(() => {});
    connection = await waitFor('扩展重新连接 Service', async () => {
      if (ws.totalAccepted() > accepted) return ws.connections[ws.totalAccepted() - 1];
      return null;
    });
    return connection;
  }

  try {
    // 1. Transport preflight: Node must be able to set the three headers the
    //    context consists of. A browser forbids `Cookie` and `Referer`; Node does
    //    not, and that asymmetry is the whole point of the POC.
    const preflight = await nodeFetch(server.mediaUrl, {
      cookieHeader: `sid=${server.sessionToken}`,
      userAgent: 'RequestContextPOC/preflight',
      referer: `${server.feedUrl}`,
    });
    const preflightRecord = server.requestsFor('/media/1').at(-1);
    check('transport.node-can-set-cookie-useragent-referer', preflight.status === 200 && preflight.digest === server.payloadDigest, {
      status: preflight.status,
      cookieNamesServerSaw: preflightRecord.cookieNames,
      refererServerSaw: preflightRecord.referer,
      userAgentServerSaw: preflightRecord.userAgent,
    });

    // 2. A disposable profile with the POC extension loaded.
    browser = await launchBrowser({
      extensionDir,
      profileDir,
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      headless: process.env.POC_HEADLESS !== '0',
    });
    const version = await browser.client.send('Browser.getVersion');
    const worker = await browser.waitForExtensionWorker();
    const extensionId = new URL(worker.url).host;
    console.log(`浏览器：${browser.executable}`);
    console.log(`版本：${version.product} (${version.protocolVersion})，扩展 ${extensionId}`);

    // 3. Wire the extension to this Service exactly like V1: the URL is stored,
    //    the worker dials it, and the Service never reaches into the browser.
    await browser.evaluate(worker.targetId, (url) => chrome.storage.local.set({ pocServiceUrl: url }), ws.url);
    connection = await ws.waitForConnections(1, 30000);
    check('bridge.connects-to-service', connection !== undefined, { serviceUrl: ws.url });

    // 4. The page: this is the "Runtime" side. It logs in and the *page* gets the
    //    resource URL, which is the situation the issue starts from.
    const page = await browser.newPage(server.feedUrl);
    pageTargetId = page.targetId;
    await browser.waitForLoad(pageTargetId);
    const pageUserAgent = await browser.evaluate(pageTargetId, () => navigator.userAgent);

    await browser.evaluate(pageTargetId, () => {
      document.getElementById('login').click();
      return true;
    });
    await waitFor('页面登录完成', async () =>
      (await browser.evaluate(pageTargetId, () => document.getElementById('login-state').textContent)) === 'logged-in',
    );

    const cookieVisible = await browser.evaluate(pageTargetId, () => document.getElementById('cookie-visible').textContent);
    check('page.javascript-cannot-read-httponly-cookie', cookieVisible.includes('theme=dark') && !cookieVisible.includes('sid='), {
      documentCookieMasked: cookieVisible.replace(/=([^;]*)/g, '=***'),
    });

    // 5. The browser itself fetches the protected resource: the reference bytes.
    await browser.evaluate(pageTargetId, () => {
      document.getElementById('fetch-same').click();
      return true;
    });
    const browserDigest = await waitFor('浏览器同源 fetch 完成', async () => {
      const text = await browser.evaluate(pageTargetId, () => document.getElementById('digest').textContent);
      const match = /browser digest: ([0-9a-f]{64})/.exec(text);
      return match ? match[1] : null;
    });
    const browserMediaRecord = server.requestsFor('/media/1').at(-1);
    check('page.browser-can-fetch-media', browserDigest === server.payloadDigest, {
      digest: browserDigest,
      serverDigest: server.payloadDigest,
      cookieNamesServerSaw: browserMediaRecord.cookieNames,
      userAgentServerSaw: browserMediaRecord.userAgent,
    });

    // What a real Chrome 153 subresource request actually looked like. The replay
    // table in the report is built from this, not from documentation.
    observe('browser.request-headers-for-same-origin-media', {
      headers: browserMediaRecord.headers,
      cookieNames: browserMediaRecord.cookieNames,
      referer: browserMediaRecord.referer,
      secFetchSite: browserMediaRecord.secFetchSite,
    });

    // 6. SameSite control: a cross-site request from the page must not carry the
    //    session cookie, even though the cookie is still in the profile.
    await browser.evaluate(pageTargetId, () => {
      document.getElementById('fetch-cross').click();
      return true;
    });
    await sleep(1000);
    const crossSiteRequests = server.log.filter((entry) => entry.host?.startsWith('localhost'));
    observe('samesite.cross-site-request-from-page', {
      requests: crossSiteRequests.map((entry) => ({
        path: entry.path,
        secFetchSite: entry.secFetchSite,
        cookieNames: entry.cookieNames,
        hasStrictCookie: entry.hasStrict,
        status: entry.status,
        headers: entry.headers,
      })),
    });

    // 7. Partitioned (CHIPS) control: a third-party frame sets a Partitioned
    //    cookie. What `chrome.cookies` reports for it is research output, so this
    //    is recorded rather than asserted.
    await sleep(1500);
    observe('chips.third-party-frame-login-partitioned', {
      requests: server.requestsFor('/login-partitioned').map((entry) => ({
        host: entry.host,
        status: entry.status,
        secFetchSite: entry.secFetchSite,
        cookieNames: entry.cookieNames,
      })),
      notes: 'Set-Cookie 是否被接受由第 10 步的 getAll 结果间接反映。',
    });

    const statusReply = await ask(connection, { type: 'GET_STATUS', requestId: 'status-1' }, (message) => message.type === 'STATUS');
    check('bridge.reports-work-tab', statusReply.state === 'IDLE' && statusReply.workTabUrl === server.feedUrl, {
      state: statusReply.state,
      workTabUrl: statusReply.workTabUrl,
    });

    // 8. The request this whole issue is about.
    const contextReply = await contextOf(server.mediaUrl);
    const context = contextReply.context;
    const maskedHeader = maskCookieHeader(context?.cookieHeader ?? '');
    check('context.same-origin-request-succeeds', contextReply.ok === true, {
      scope: context?.scope,
      targetOrigin: context?.targetOrigin,
      cookieCount: context?.cookieCount,
      cookieHeaderMasked: maskedHeader,
      userAgentSource: context?.userAgentSource,
    });

    check('context.includes-httponly-session-cookie', (context?.cookieHeader ?? '').includes(`sid=${server.sessionToken}`), {
      cookieCount: context?.cookieCount,
      httpOnlyCookieCount: context?.httpOnlyCookieCount,
      cookieMetadata: context?.cookies,
    });

    check('context.same-site-cookie-returned-despite-samesite', (context?.cookieHeader ?? '').includes('strict=1'), {
      note: 'SameSite 只约束浏览器发送，不约束 chrome.cookies 读取。',
      cookieHeaderMasked: maskedHeader,
    });

    check('context.user-agent-comes-from-the-work-tab-page', context?.userAgent === pageUserAgent && context?.userAgentSource === 'work-tab-page', {
      userAgent: context?.userAgent,
      pageUserAgent,
    });

    check('context.referer-is-the-work-tab-url', context?.referer === server.feedUrl && context?.workTabUrl === server.feedUrl, {
      referer: context?.referer,
    });

    // The page's own referrer rules travel as facts, separately from Bridge's
    // suggested value: a subresource's real initiator need not be this page.
    // The property under test is *agreement with the page*, not a fixed string —
    // a document that declares no policy reports an empty one.
    const pageReferrerFacts = await browser.evaluate(pageTargetId, () => ({
      referrer: document.referrer,
      referrerPolicy: typeof document.referrerPolicy === 'string' ? document.referrerPolicy : null,
      policyType: typeof document.referrerPolicy,
      pageUrl: location.href,
    }));
    check(
      'context.reports-page-self-reported-referrer-facts',
      context?.documentReferrer === pageReferrerFacts.referrer && context?.referrerPolicy === pageReferrerFacts.referrerPolicy,
      {
        documentReferrer: context?.documentReferrer,
        referrerPolicy: context?.referrerPolicy,
        pageReferrerFacts,
        note: 'document.referrer 为空（页面由 CDP 新建标签页打开）；实测 Chrome 153 页面里 document.referrerPolicy 是 undefined，所以该字段只能为 null——生效策略只能由 Service 按浏览器默认值或响应头推断。',
      },
    );

    check('context.carries-observed-at', typeof context?.observedAt === 'string' && !Number.isNaN(Date.parse(context.observedAt)), {
      observedAt: context?.observedAt,
    });

    // 9. The payoff: the Service downloads with nothing but the returned context.
    const download = await nodeFetch(server.mediaUrl, {
      cookieHeader: context.cookieHeader,
      userAgent: context.userAgent,
      referer: context.referer,
    });
    check('service.downloads-protected-resource-with-context', download.status === 200 && download.digest === server.payloadDigest, {
      status: download.status,
      bytes: download.bytes,
      digest: download.digest,
      browserDigest,
    });

    const ranged = await nodeFetch(server.mediaUrl, {
      cookieHeader: context.cookieHeader,
      userAgent: context.userAgent,
      referer: context.referer,
      range: 'bytes=0-1023',
    });
    check('service.supports-range-replay', ranged.status === 206 && ranged.bytes === 1024, {
      status: ranged.status,
      bytes: ranged.bytes,
    });

    // Controls: the context is necessary, not decorative.
    const withoutCookie = await nodeFetch(server.mediaUrl, { userAgent: context.userAgent, referer: context.referer });
    const withoutReferer = await nodeFetch(server.mediaUrl, { cookieHeader: context.cookieHeader, userAgent: context.userAgent });
    const withoutUserAgent = await nodeFetchWithoutUserAgent(server.mediaUrl, {
      cookieHeader: context.cookieHeader,
      referer: context.referer,
    });
    const defaultNodeUserAgent = await nodeFetch(server.mediaUrl, { cookieHeader: context.cookieHeader, referer: context.referer });
    check('control.without-cookie-is-rejected', withoutCookie.status === 401, { status: withoutCookie.status });
    check('control.without-referer-is-rejected', withoutReferer.status === 403, { status: withoutReferer.status });
    check('control.without-user-agent-is-rejected', withoutUserAgent.status === 403, { status: withoutUserAgent.status });
    observe('transport.node-fetch-default-user-agent', {
      userAgentServerSaw: server.requestsFor('/media/1').at(-1).userAgent,
      note: `未显式设置时 fetch 发送 "${defaultNodeUserAgent.status === 200 ? server.requestsFor('/media/1').at(-1).userAgent : '?'}"；不带任何 User-Agent 需要 node:http。`,
    });

    // 10. Cross-origin behaviour, which is where every real media host lives.
    const crossOriginDefault = await contextOf(server.altMediaUrl);
    check('scope.cross-origin-refused-by-default', crossOriginDefault.ok === false && crossOriginDefault.error?.code === CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE, {
      code: crossOriginDefault.error?.code,
      message: crossOriginDefault.error?.message,
    });

    const crossOriginExplicit = await contextOf(server.altMediaUrl, TARGET_SCOPES.TARGET_ONLY);
    check('scope.cross-origin-allowed-when-explicit', crossOriginExplicit.ok === true, {
      cookieCount: crossOriginExplicit.context?.cookieCount,
      cookieHeaderMasked: maskCookieHeader(crossOriginExplicit.context?.cookieHeader ?? ''),
      cookieMetadata: crossOriginExplicit.context?.cookies,
    });
    check('scope.cross-origin-returns-only-that-hosts-cookies', !(crossOriginExplicit.context?.cookieHeader ?? '').includes('sid='), {
      note: 'Session cookie 是 127.0.0.1 的 host-only cookie，绝不应出现在 localhost 的上下文里。',
    });

    // CHIPS: the third-party frame's `Partitioned` cookie is really in the
    // profile (the browser sent it on a cross-site request), yet a `url`-only
    // getAll does not see it. Naming the partition does — which is why a context
    // request has to be able to carry the top-level site.
    const partitionedContext = await contextOf(server.altMediaUrl, TARGET_SCOPES.TARGET_ONLY, server.origin);
    const partitionedCookie = (partitionedContext.context?.cookies ?? []).find((cookie) => cookie.name === 'part');
    observe('chips.partitioned-cookie-visibility', {
      targetUrl: server.altMediaUrl,
      cookiesReturnedWithoutPartition: crossOriginExplicit.context?.cookies ?? [],
      cookiesReturnedWithPartition: partitionedContext.context?.cookies ?? [],
      browserSentThePartitionedCookie: server.log.some((entry) => entry.hasPartitioned),
    });
    check('chips.partitioned-cookie-needs-a-partition-query', (crossOriginExplicit.context?.cookieCount ?? -1) === 0 && partitionedCookie !== undefined, {
      partitionedCookieFound: partitionedCookie ?? null,
      note: '同一 URL：不指定 partitionKey 时 0 个 cookie；指定 topLevelSite 后才看得到 Partitioned cookie。',
    });

    const unrelated = await contextOf('https://example.invalid/media/1', TARGET_SCOPES.TARGET_ONLY);
    check('scope.unrelated-origin-yields-nothing', unrelated.ok === true && unrelated.context.cookieCount === 0, {
      cookieCount: unrelated.context?.cookieCount,
    });
    observe('security.enumeration-surface', {
      note: 'scope=TARGET_ONLY 时任何 http(s) URL 都可询问；此例返回 0 个 cookie 只因该 origin 本就没有 cookie。',
    });

    const invalidTargets = ['file:///C:/Windows/win.ini', 'javascript:alert(1)', '/media/1', ''];
    const invalidReplies = [];
    for (const targetUrl of invalidTargets) {
      const reply = await contextOf(targetUrl);
      invalidReplies.push({ targetUrl, ok: reply.ok, code: reply.error?.code });
    }
    check('scope.non-http-targets-refused', invalidReplies.every((reply) => reply.ok === false && reply.code === CONTEXT_ERROR_CODES.INVALID_TARGET_URL), {
      replies: invalidReplies,
    });

    // 11. Which user agent is authoritative? A per-tab override changes what the
    //     page reports while the service worker keeps the browser's own value, so
    //     a context sampled in the worker would be wrong.
    const overriddenUserAgent = 'RequestContextPOC/9.9 (page-level override)';
    await browser.setUserAgentOverride(pageTargetId, overriddenUserAgent);
    const pageUserAgentAfterOverride = await browser.evaluate(pageTargetId, () => navigator.userAgent);
    const overriddenContext = await contextOf(server.mediaUrl);
    check('user-agent.page-override-is-what-the-page-uses', pageUserAgentAfterOverride === overriddenUserAgent, {
      pageUserAgentAfterOverride,
    });
    check('user-agent.context-follows-the-page-not-the-worker', overriddenContext.context?.userAgent === overriddenUserAgent && overriddenContext.context?.serviceWorkerUserAgent !== overriddenUserAgent, {
      contextUserAgent: overriddenContext.context?.userAgent,
      serviceWorkerUserAgent: overriddenContext.context?.serviceWorkerUserAgent,
    });

    // 12. Nothing may be persisted: the only storage key is the Service URL.
    const storage = await browser.evaluate(worker.targetId, async () => JSON.stringify(await chrome.storage.local.get(null)));
    check('security.nothing-persisted', !storage.includes(server.sessionToken) && !storage.includes('sid=') && !storage.includes('part='), {
      storageKeys: Object.keys(JSON.parse(storage)),
    });

    // 13. No Work Tab, no context: the same NOT_READY rule V1 already has.
    await browser.client.send('Target.closeTarget', { targetId: pageTargetId }).catch(() => {});
    pageTargetId = null;
    await sleep(500);
    const noTab = await contextOf(server.mediaUrl);
    check('bridge.refuses-when-no-work-tab', noTab.ok === false && noTab.error?.code === CONTEXT_ERROR_CODES.NOT_READY, {
      code: noTab.error?.code,
      message: noTab.error?.message,
    });

    // 14. Every request the local origin saw, with cookie names only.
    observe('server.request-log', {
      entries: server.log.map((entry) => ({
        path: entry.path,
        host: entry.host,
        cookieNames: entry.cookieNames,
        secFetchSite: entry.secFetchSite,
        status: entry.status,
        note: entry.note,
      })),
    });
  } finally {
    if (browser !== null && process.env.POC_KEEP_BROWSER !== '1') await browser.close().catch(() => {});
    await server.close();
    await ws.close();
    if (process.env.POC_KEEP_PROFILE !== '1') await rm(profileDir, { recursive: true, force: true });
  }

  const failed = checks.filter((entry) => entry.ok !== true);
  const evidence = {
    at: startedAt,
    finishedAt: new Date().toISOString(),
    poc: 'issue #13 minimal request context',
    browser: browser === null ? null : { executable: browser.executable, headless: browser.headless },
    origin: { feedUrl: server.feedUrl, mediaUrl: server.mediaUrl, altMediaUrl: server.altMediaUrl, payloadBytes: server.payloadBytes, payloadDigest: server.payloadDigest },
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.map((entry) => entry.id) },
    checks,
    observations,
  };

  // One stable path, overwritten by every run: the run time lives inside the
  // file, and a directory of timestamped copies is noise in review.
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, 'request-context.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  console.log('');
  console.log(`检查：${evidence.summary.passed}/${evidence.summary.total} 通过`);
  console.log(`证据：poc/evidence/request-context.json`);
  if (failed.length > 0) {
    console.log(`失败：${failed.map((entry) => entry.id).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
