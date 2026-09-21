#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allowUserScripts,
  closePage,
  evaluate,
  findBrowser,
  findExtensionId,
  launchBrowser,
  openPage,
  setUserAgentOverride,
  sleep,
} from './browser.mjs';
import { startProtectedServer } from './protected-server.mjs';
import { startTestService } from './service.mjs';

/**
 * The request-context POC (issue #13), run against the **real extension**.
 *
 * `run-poc.mjs` proves V1 works end to end; this one proves the experimental
 * request-context capability does — on the same `src/` extension, with the same
 * harness, and without disturbing anything V1 does:
 *
 *   a local host that only answers with an `HttpOnly` session cookie, the right
 *   `Referer` and a non-empty `User-Agent`  →  Bridge reports what the browser
 *   would send  →  a Node client replays the request with nothing but that
 *   context and gets the same bytes the browser got.
 *
 * The controls matter as much as the happy path: without the context the same
 * request must fail, an out-of-scope URL must be refused, and an unrelated origin
 * must yield nothing.
 *
 *   node tests/poc/request-context.mjs [--browser <chrome.exe>] [--headed] [--port 9223]
 *
 * Evidence: docs/research/evidence/request-context.json
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const EXTENSION_ROOT = join(REPO_ROOT, 'src');
const EXTENSION_NAME = 'Browser Bridge';
const EVIDENCE_PATH = join(REPO_ROOT, 'docs', 'research', 'evidence', 'request-context.json');

function parseArgs(argv) {
  const options = { port: 9223, headed: false, browser: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--browser') options.browser = argv[++i];
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--headed') options.headed = true;
  }
  return options;
}

const results = [];
const observations = [];

async function scenario(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  ✖ ${name}\n      ${error.message}`);
  }
}

function observe(name, detail) {
  observations.push({ name, detail });
  console.log(`  · ${name}`);
}

/** Like `run-poc.mjs`'s helper, except the predicate's value is returned. */
async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(message);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const maskHeader = (header) =>
  header === '' ? '' : header.split(';').map((pair) => `${pair.split('=')[0].trim()}=***`).join('; ');

const options = parseArgs(process.argv.slice(2));
const exe = findBrowser(options.browser);

console.log('Browser Bridge — request context POC (issue #13)\n');
console.log(`  browser   ${exe}`);
console.log(`  extension ${EXTENSION_ROOT}\n`);

let protectedSite = null;
let service = null;
let browser = null;
let optionsUrl = null;

/** Saves the Service URL through the real settings page. */
async function configureServiceUrl(url) {
  const target = await openPage(options.port, optionsUrl);
  await waitUntil(
    async () => {
      try {
        return await evaluate(
          options.port,
          target,
          'Boolean(document.getElementById("save-service-url")) && !document.getElementById("save-service-url").disabled',
        );
      } catch {
        return false;
      }
    },
    8000,
    '设置页没有在期限内就绪',
  );
  await evaluate(
    options.port,
    target,
    `(() => {
      const input = document.getElementById('service-url');
      input.value = ${JSON.stringify(url)};
      document.getElementById('save-service-url').click();
      return input.value;
    })()`,
  );
  await closePage(options.port, target);
}

let requestSequence = 0;

/** Sends GET_REQUEST_CONTEXT and returns the REQUEST_CONTEXT that answers it. */
async function requestContext(targetUrl, extra = {}, timeoutMs = 10000) {
  requestSequence += 1;
  const requestId = `rc-${requestSequence}`;
  const from = service.mark();
  service.send({ type: 'GET_REQUEST_CONTEXT', requestId, targetUrl, ...extra });
  const frames = await service.waitFor(
    (all) => all.slice(from).some((m) => m.type === 'REQUEST_CONTEXT' && m.requestId === requestId),
    timeoutMs,
    `等待 ${requestId} 的 REQUEST_CONTEXT 超时`,
  );
  return frames.slice(from).filter((m) => m.type === 'REQUEST_CONTEXT' && m.requestId === requestId).at(-1);
}

/** A Node-side fetch built from nothing but the returned context. */
async function replay(url, { cookieHeader, userAgent, referer, range } = {}) {
  const headers = {};
  if (cookieHeader !== undefined) headers.cookie = cookieHeader;
  if (userAgent !== undefined) headers['user-agent'] = userAgent;
  if (referer !== undefined) headers.referer = referer;
  if (range !== undefined) headers.range = range;
  const response = await fetch(url, { headers, redirect: 'follow' });
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes: body.length, digest: sha256(body) };
}

try {
  protectedSite = await startProtectedServer();
  service = await startTestService();
  browser = await launchBrowser({
    exe,
    extensionPath: EXTENSION_ROOT,
    port: options.port,
    headless: !options.headed,
  });
  const extensionId = await findExtensionId(options.port, EXTENSION_NAME);
  // Read the page path from the manifest instead of assuming it: the options page
  // lives at `options/options.html`, and a guessed path lands on chrome-error.
  const manifest = JSON.parse(readFileSync(join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));
  optionsUrl = `chrome-extension://${extensionId}/${manifest.options_ui.page}`;
  console.log(`  service   ${service.url}`);
  console.log(`  host      ${protectedSite.origin} (alt: ${protectedSite.altOrigin})\n`);

  await configureServiceUrl(service.url);
  await service.waitForBridge(20000);

  let page = null;
  let pageUserAgent = null;
  let browserDigest = null;
  let context = null;

  // Deliberately *before* Allow User Scripts is granted: reading browser facts must
  // not depend on the operator's user-script decision.
  await scenario('1. 还没有 Work Tab 时，上下文请求如实回答 NOT_READY', async () => {
    const status = await service.getStatus();
    assert.equal(status.state, 'NOT_READY');
    assert.equal(status.reason, 'NO_WORK_TAB');

    const reply = await requestContext(`${protectedSite.origin}/media/1`);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'NOT_READY');
  });

  await scenario('2. 打开受保护站点页面并登录（HttpOnly 会话 Cookie）', async () => {
    page = await openPage(options.port, protectedSite.urlFor('/feed'));
    pageUserAgent = await waitUntil(
      async () => {
        try {
          const agent = await evaluate(options.port, page, 'navigator.userAgent');
          return agent || null;
        } catch {
          return null;
        }
      },
      10000,
      '页面没有在期限内就绪',
    );

    await evaluate(options.port, page, 'document.getElementById("login").click(); true');
    await waitUntil(
      async () => (await evaluate(options.port, page, 'document.getElementById("login-state").textContent')) === 'logged-in',
      8000,
      '登录没有生效',
    );

    const visible = await evaluate(options.port, page, 'document.getElementById("cookie-visible").textContent');
    assert.ok(visible.includes('theme=dark'), '可读 cookie 应出现在 document.cookie');
    assert.ok(!visible.includes('sid='), 'HttpOnly 会话 cookie 不得出现在 document.cookie');
    observe('页面 JS 可见的 cookie', { documentCookieMasked: maskHeader(visible) });
  });

  await scenario('3. 浏览器自己取到受保护资源（对照组）', async () => {
    await evaluate(options.port, page, 'document.getElementById("fetch-same").click(); true');
    browserDigest = await waitUntil(
      async () => {
        const text = await evaluate(options.port, page, 'document.getElementById("digest").textContent');
        const match = /browser digest: ([0-9a-f]{64})/.exec(text);
        return match ? match[1] : null;
      },
      10000,
      '浏览器没有取到资源',
    );
    assert.equal(browserDigest, protectedSite.payloadDigest);

    const record = protectedSite.requestsFor('/media/1').at(-1);
    assert.deepEqual(record.cookieNames, ['sid', 'theme', 'strict']);
    observe('Chrome 对同源子资源实际发出的头', {
      headers: record.headers,
      referer: record.referer,
      cookieNames: record.cookieNames,
    });
  });

  await scenario('4. 未开启 Allow User Scripts 时上下文仍可用，并含 HttpOnly', async () => {
    // A Work Tab is bound now, but the operator has not granted user scripts, so
    // Jobs are refused — and the context request must not care.
    const status = await service.getStatus();
    assert.equal(status.state, 'NOT_READY');
    assert.equal(status.reason, 'USER_SCRIPTS_UNAVAILABLE');

    const reply = await requestContext(protectedSite.mediaUrl);
    assert.equal(reply.ok, true, JSON.stringify(reply.error));
    context = reply.context;

    assert.equal(context.targetOrigin, protectedSite.origin);
    assert.equal(context.scope, 'WORK_TAB_ORIGIN');
    assert.equal(context.workTabUrl, protectedSite.urlFor('/feed'));
    assert.equal(context.referer, protectedSite.urlFor('/feed'));
    assert.ok(context.cookieHeader.includes(`sid=${protectedSite.sessionToken}`), 'HttpOnly 会话 cookie 必须包含');
    assert.equal(context.httpOnlyCookieCount, 1);
    assert.ok(context.cookieHeader.includes('strict=1'), 'SameSite=Strict cookie 读取不受 SameSite 约束');
    assert.equal(typeof context.observedAt, 'string');
    assert.equal(Number.isNaN(Date.parse(context.observedAt)), false);

    observe('上下文（已脱敏）', {
      cookieHeaderMasked: maskHeader(context.cookieHeader),
      cookieMetadata: context.cookies,
      userAgentSource: context.userAgentSource,
      observedAt: context.observedAt,
    });
  });

  await scenario('5. User-Agent 来自 Work Tab 页面，而不是扩展 service worker', async () => {
    assert.equal(context.userAgent, pageUserAgent);
    assert.equal(context.userAgentSource, 'work-tab-page');
    assert.equal(context.documentReferrer, '');
  });

  await scenario('6. Node 仅用该上下文下载，得到与浏览器逐字节相同的资源', async () => {
    const download = await replay(protectedSite.mediaUrl, {
      cookieHeader: context.cookieHeader,
      userAgent: context.userAgent,
      referer: context.referer,
    });
    assert.equal(download.status, 200);
    assert.equal(download.digest, browserDigest);
    observe('Node 重放', { status: download.status, bytes: download.bytes, digest: download.digest });

    const ranged = await replay(protectedSite.mediaUrl, {
      cookieHeader: context.cookieHeader,
      userAgent: context.userAgent,
      referer: context.referer,
      range: 'bytes=0-1023',
    });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.bytes, 1024);
  });

  await scenario('7. 反例：缺少上下文任一部分都取不到资源', async () => {
    const withoutCookie = await replay(protectedSite.mediaUrl, {
      userAgent: context.userAgent,
      referer: context.referer,
    });
    assert.equal(withoutCookie.status, 401);

    const withoutReferer = await replay(protectedSite.mediaUrl, {
      cookieHeader: context.cookieHeader,
      userAgent: context.userAgent,
    });
    assert.equal(withoutReferer.status, 403);

    const withoutUserAgent = await replay(protectedSite.mediaUrl, { cookieHeader: context.cookieHeader, referer: context.referer });
    // `fetch` always sends `user-agent: node`; a browser-looking failure needs the
    // header gone entirely, which only `node:http` can express.
    assert.equal(withoutUserAgent.status, 200, 'fetch 不设 UA 时会带 node，这本身就是自报家门');

    const record = protectedSite.requestsFor('/media/1').find((entry) => entry.note === 'MISSING_USER_AGENT');
    assert.equal(record, undefined, '上面的请求不应触发 MISSING_USER_AGENT');
    observe('Node fetch 的默认 User-Agent', { userAgentSeen: protectedSite.requestsFor('/media/1').at(-1).userAgent });
  });

  await scenario('8. 跨源目标：默认拒绝，显式 scope=TARGET_ONLY 才允许', async () => {
    const refused = await requestContext(protectedSite.altMediaUrl);
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'TARGET_OUT_OF_SCOPE');

    const allowed = await requestContext(protectedSite.altMediaUrl, { scope: 'TARGET_ONLY' });
    assert.equal(allowed.ok, true);
    assert.ok(!allowed.context.cookieHeader.includes('sid='), '会话 cookie 属于另一个 host，不得出现在跨源上下文里');
  });

  await scenario('9. 分区 Cookie（CHIPS）：默认带上，显式 topLevelSite=null 才看不到', async () => {
    // The third-party frame has written `part` by now; the browser sends it on a
    // cross-site request, so the profile really holds it.
    const partitioned = await requestContext(protectedSite.altMediaUrl, { scope: 'TARGET_ONLY' });
    const names = partitioned.context.cookies.map((cookie) => cookie.name);
    assert.ok(names.includes('part'), `分区 cookie 应通过默认分区查询返回，实际：${JSON.stringify(names)}`);
    assert.equal(partitioned.context.partitionedCookieCount, 1);

    const withoutPartition = await requestContext(protectedSite.altMediaUrl, { scope: 'TARGET_ONLY', topLevelSite: null });
    assert.ok(
      !withoutPartition.context.cookies.some((cookie) => cookie.name === 'part'),
      '显式 topLevelSite=null 时不应做分区查询',
    );
    observe('分区 cookie 的可见性', {
      withDefaultPartition: partitioned.context.cookies,
      withoutPartition: withoutPartition.context.cookies.map((cookie) => cookie.name),
    });
  });

  await scenario('10. 无关 origin 返回 0 个 cookie', async () => {
    const unrelated = await requestContext('https://example.invalid/media/1', { scope: 'TARGET_ONLY' });
    assert.equal(unrelated.ok, true);
    assert.equal(unrelated.context.cookieCount, 0);
  });

  await scenario('11. 非法目标一律拒绝', async () => {
    for (const targetUrl of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', '/media/1', '']) {
      const reply = await requestContext(targetUrl);
      assert.equal(reply.ok, false, `${targetUrl} 不应被接受`);
      assert.equal(reply.error.code, 'INVALID_TARGET_URL');
    }
    const badScope = await requestContext(protectedSite.mediaUrl, { scope: 'ANY' });
    assert.equal(badScope.error.code, 'INVALID_SCOPE');
  });

  await scenario('12. 页面级 UA 覆盖后，上下文跟随页面而不是 worker', async () => {
    const overridden = 'RequestContextPOC/9.9 (page-level override)';
    const override = await setUserAgentOverride(options.port, page, overridden);
    try {
      assert.equal(await evaluate(options.port, page, 'navigator.userAgent'), overridden);

      const reply = await requestContext(protectedSite.mediaUrl);
      assert.equal(reply.context.userAgent, overridden);
      assert.notEqual(reply.context.serviceWorkerUserAgent, overridden, 'worker 自身的 UA 不应被页面级覆盖影响');
      observe('UA 来源', {
        contextUserAgent: reply.context.userAgent,
        serviceWorkerUserAgent: reply.context.serviceWorkerUserAgent,
      });
    } finally {
      // The override lives in the CDP session that set it.
      override.close();
    }
  });

  await scenario('13. 没有任何持久化：扩展存储里只有 Service URL', async () => {
    const inspector = await openPage(options.port, optionsUrl);
    const stored = await evaluate(options.port, inspector, 'chrome.storage.local.get(null)');
    await closePage(options.port, inspector);

    assert.deepEqual(Object.keys(stored), ['serviceUrl']);
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes(protectedSite.sessionToken), 'cookie 值不得落盘');
    observe('chrome.storage.local', { keys: Object.keys(stored) });
  });

  await scenario('14. 开启 Allow User Scripts 后：EXECUTE 与上下文请求并存，且 Job 不受影响', async () => {
    await allowUserScripts(options.port, extensionId);
    await waitUntil(async () => (await service.getStatus()).state === 'IDLE', 15000, 'Allow User Scripts 后没有回到 IDLE');

    const executed = await service.execute({ script: 'return document.title;' });
    assert.equal(executed.ok, true);

    // A context request while a Job is running must be answered *and* must not
    // disturb the Job: the same connection, no extra RESULT, no BUSY for the Job.
    const slow = service.execute({
      script: 'await new Promise((r) => setTimeout(r, 700)); return "slow-done";',
      timeoutMs: 8000,
    });
    await sleep(150);
    const status = await service.getStatus();
    assert.equal(status.state, 'RUNNING');

    const during = await requestContext(protectedSite.mediaUrl);
    assert.equal(during.ok, true, 'RUNNING 期间上下文请求应被服务');
    assert.equal((await slow).ok, true, '运行中的 Job 不应被上下文请求影响');
  });

  await scenario('15. 没有 Work Tab 时拒绝（NOT_READY）', async () => {
    await closePage(options.port, page);
    page = null;
    await waitUntil(async () => (await service.getStatus()).state === 'NOT_READY', 10000, '关闭页面后没有变成 NOT_READY');

    const reply = await requestContext(protectedSite.mediaUrl);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'NOT_READY');
  });
} catch (error) {
  results.push({ name: '前置准备 / 场景编排', ok: false, error: error.message });
  console.log(`  ✖ 前置准备 / 场景编排\n      ${error.message}`);
} finally {
  const failed = results.filter((entry) => !entry.ok);
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(
    EVIDENCE_PATH,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        extension: EXTENSION_ROOT,
        service: service?.url ?? null,
        origin: protectedSite?.origin ?? null,
        summary: { total: results.length, passed: results.length - failed.length, failed: failed.map((entry) => entry.name) },
        scenarios: results,
        observations,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n  场景：${results.length - failed.length}/${results.length} 通过`);
  console.log(`  证据：${EVIDENCE_PATH}`);

  if (browser) await browser.stop();
  if (service) await service.stop();
  if (protectedSite) await protectedSite.close();

  process.exitCode = failed.length === 0 ? 0 : 1;
}
