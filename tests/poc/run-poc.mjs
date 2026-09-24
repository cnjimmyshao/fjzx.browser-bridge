#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  allowUserScripts,
  closePage,
  evaluate,
  findBrowser,
  findExtensionId,
  httpPages,
  launchBrowser,
  openPage,
  sleep,
} from './browser.mjs';
import { startTestService } from './service.mjs';
import { startTestPageServer } from './page-server.mjs';

/**
 * The V1 end-to-end POC.
 *
 * It starts a real Service, a real local test page and a real Chrome with the
 * extension loaded, then walks the scenarios issue #7 lists. Nothing here touches
 * a third-party site, and nothing here is part of the extension.
 *
 *   node tests/poc/run-poc.mjs [--browser <chrome.exe>] [--headed] [--port 9222]
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_ROOT = join(HERE, '..', '..', 'src');
const EXTENSION_NAME = 'Browser Bridge';

function parseArgs(argv) {
  const options = { port: 9222, headed: false, browser: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--browser') options.browser = argv[++i];
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--headed') options.headed = true;
  }
  return options;
}

const results = [];

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

async function waitUntil(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(150);
  }
  throw new Error(message);
}

const options = parseArgs(process.argv.slice(2));
const exe = findBrowser(options.browser);

console.log('Browser Bridge V1 — end-to-end POC\n');
console.log(`  browser   ${exe}`);
console.log(`  extension ${EXTENSION_ROOT}\n`);

// Everything that needs cleaning up is declared before the try: launchBrowser
// spawns a *detached* browser, so a failure during setup would otherwise leave an
// orphaned Chrome holding the profile and the POC would never report why.
let pages = null;
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
        return false; // the document is not there yet
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

const soleWorkTab = async () => (await httpPages(options.port))[0]?.id;

try {
  pages = await startTestPageServer();
  service = await startTestService();
  browser = await launchBrowser({
    exe,
    extensionPath: EXTENSION_ROOT,
    port: options.port,
    headless: !options.headed,
  });
  console.log(`  service   ${service.url}`);
  console.log(`  page      ${pages.urlFor('/')}\n`);

  const extensionId = await findExtensionId(options.port, EXTENSION_NAME);
  // Read the options path from the manifest rather than assuming it: a harness that
  // guesses the extension's own layout is a harness that breaks silently.
  const manifest = JSON.parse(readFileSync(join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));
  optionsUrl = `chrome-extension://${extensionId}/${manifest.options_ui.page}`;
  await openPage(options.port, pages.urlFor('/'));

  await configureServiceUrl(service.url);
  await service.waitForBridge(20000);

  // ── extra: the platform gate, before it is lifted ────────────────────────────
  await scenario('前置：未开启 Allow User Scripts 时报 USER_SCRIPTS_UNAVAILABLE', async () => {
    const status = await service.getStatus(8000);
    assert.equal(status.state, 'NOT_READY');
    assert.equal(status.reason, 'USER_SCRIPTS_UNAVAILABLE');
  });

  assert.equal(await allowUserScripts(options.port, extensionId), true);

  // ── 1 ───────────────────────────────────────────────────────────────────────
  await scenario('1. 首次配置 Service URL 并连接', async () => {
    await service.waitForBridge(15000);
    assert.equal(service.openCount(), 1, 'Bridge 应建立唯一连接');
  });

  // ── 2 ───────────────────────────────────────────────────────────────────────
  await scenario('2. 唯一业务 Tab → IDLE；GET_STATUS → IDLE', async () => {
    const status = await service.getStatus();
    assert.deepEqual(status, { type: 'STATUS', state: 'IDLE' });
  });

  // ── 3 ───────────────────────────────────────────────────────────────────────
  await scenario('3. EXECUTE 读取 DOM → RESULT ok=true', async () => {
    const result = await service.execute({
      script:
        "return { title: document.title, heading: document.querySelector('#work-heading').textContent };",
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.heading, 'Bridge work tab');
    assert.equal(result.data.title, 'Browser Bridge test page');
  });

  // ── 4 ───────────────────────────────────────────────────────────────────────
  await scenario('4. EXECUTE 点击测试按钮并观察 DOM 变化', async () => {
    const result = await service.execute({
      script: [
        "document.getElementById('work-button').click();",
        'await new Promise((r) => setTimeout(r, 80));',
        "return document.getElementById('work-state').textContent;",
      ].join('\n'),
    });
    assert.equal(result.ok, true);
    assert.equal(result.data, 'clicked:1');

    // The change is visible to the page itself, not only to the script.
    const fromPage = await evaluate(
      options.port,
      await soleWorkTab(),
      "document.getElementById('work-state').textContent",
    );
    assert.equal(fromPage, 'clicked:1', '页面自身也应观察到变化');
  });

  // ── 5 ───────────────────────────────────────────────────────────────────────
  await scenario('5. EXECUTE 使用 input 并正确返回', async () => {
    const result = await service.execute({
      script: 'return { received: input, doubled: input.n * 2 };',
      input: { n: 21, label: 'from-service' },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { received: { n: 21, label: 'from-service' }, doubled: 42 });
  });

  // ── 附加：Page Context（issue #25）────────────────────────────────────────────
  await scenario('附加：成功 RESULT 带回与当前页面一致的 Page Context', async () => {
    const result = await service.execute({
      script: "return { title: document.title, token: document.getElementById('doc-token').textContent };",
    });
    assert.equal(result.ok, true);

    const pageContext = result.pageContext;
    assert.equal(pageContext.available, true, JSON.stringify(pageContext));

    // The page's own answers, read through a different route on purpose: the
    // scenario must not agree with Bridge just because it asked Bridge.
    const workTab = await soleWorkTab();
    assert.equal(pageContext.workTabUrl, await evaluate(options.port, workTab, 'location.href'));
    assert.equal(pageContext.userAgent, await evaluate(options.port, workTab, 'navigator.userAgent'));
    assert.equal(
      pageContext.documentReferrer,
      await evaluate(options.port, workTab, 'document.referrer'),
    );
    assert.equal(typeof pageContext.documentId, 'string');
    assert.ok(pageContext.documentId !== '', 'documentId 必须标出这次采样属于哪个文档');

    // Page facts only: no cookie and nothing target-specific may appear here.
    assert.deepEqual(Object.keys(pageContext).sort(), [
      'available',
      'documentId',
      'documentReferrer',
      'userAgent',
      'workTabUrl',
    ]);
    console.log(`      → documentId=${pageContext.documentId} token=${result.data.token}`);
  });

  await scenario('附加：同一 URL 重载后 documentId 变化，Page Context 跟随文档', async () => {
    const workTab = await soleWorkTab();
    const first = await service.execute({
      script: "return document.getElementById('doc-token').textContent;",
    });
    const firstToken = first.data;
    const firstDocumentId = first.pageContext.documentId;

    await evaluate(options.port, workTab, "location.reload(); 'go'");
    await waitUntil(
      async () =>
        (await evaluate(options.port, workTab, "document.getElementById('doc-token')?.textContent")) !==
        firstToken,
      8000,
      '页面没有在期限内重载',
    );

    const second = await service.execute({
      script: "return document.getElementById('doc-token').textContent;",
    });
    assert.notEqual(second.data, firstToken, '确实换了一个文档');
    assert.equal(second.pageContext.workTabUrl, first.pageContext.workTabUrl, 'URL 没有变');
    assert.notEqual(
      second.pageContext.documentId,
      firstDocumentId,
      'documentId 必须跟着文档换，否则重载与旧文档无法区分',
    );
  });

  await scenario('附加：导航竞争时只给同一文档的事实，或明确降级', async () => {
    const workTab = await soleWorkTab();
    const url = await evaluate(options.port, workTab, 'location.href');

    const before = await service.execute({
      script: "return document.getElementById('doc-token').textContent;",
    });
    const beforeToken = before.data;

    // The Job's own script starts the reload and returns: from here the page facts
    // are read while the document is being replaced, which is the race this
    // scenario is about.
    const raced = await service.execute({ script: "location.reload(); return 'reload-triggered';" });

    await waitUntil(
      async () =>
        (await evaluate(options.port, workTab, "document.getElementById('doc-token')?.textContent")) !==
        beforeToken,
      8000,
      '页面没有在期限内重载',
    );
    const after = await service.execute({
      script: "return document.getElementById('doc-token').textContent;",
    });

    assert.equal(raced.ok, true, JSON.stringify(raced));
    assert.equal(raced.data, 'reload-triggered');

    const pageContext = raced.pageContext;
    if (pageContext.available) {
      // Either document of this URL is a truthful answer; a mixture would not be.
      assert.equal(pageContext.workTabUrl, url);
      assert.ok(
        [before.pageContext.documentId, after.pageContext.documentId].includes(pageContext.documentId),
        `采样必须属于某一个已知文档，实际 ${pageContext.documentId}（旧 ${before.pageContext.documentId} / 新 ${after.pageContext.documentId}）`,
      );
      console.log(`      → 竞争期间取到文档 ${pageContext.documentId}`);
    } else {
      assert.ok(
        ['PAGE_FACTS_UNAVAILABLE', 'WORK_TAB_UNAVAILABLE'].includes(pageContext.reason),
        `降级原因必须是已定义的技术原因，实际 ${pageContext.reason}`,
      );
      console.log(`      → 竞争期间如实降级：${pageContext.reason}`);
    }
  });

  // ── 6 ───────────────────────────────────────────────────────────────────────
  await scenario('6. 长 Job 时 STATUS=RUNNING + 正确 jobId', async () => {
    const jobId = service.nextJobId('long');
    const from = service.mark();
    service.send({
      type: 'EXECUTE',
      jobId,
      script: 'await new Promise((r) => setTimeout(r, 1200)); return "slow-done";',
    });
    await sleep(300);

    const status = await service.getStatus();
    assert.equal(status.state, 'RUNNING');
    assert.equal(status.jobId, jobId);

    const settled = await service.waitFor(
      (all) => all.some((m) => m.type === 'RESULT' && m.jobId === jobId),
      6000,
      '长 Job 没有回 RESULT',
    );
    const result = settled.slice(from).find((m) => m.type === 'RESULT' && m.jobId === jobId);
    assert.equal(result.ok, true);
    assert.equal(result.data, 'slow-done');
  });

  // ── 7 ───────────────────────────────────────────────────────────────────────
  await scenario('7. 长 Job 时第二 EXECUTE → BUSY，且第一个 Job 不受影响', async () => {
    const first = service.nextJobId('first');
    const second = service.nextJobId('second');
    const from = service.mark();
    service.send({
      type: 'EXECUTE',
      jobId: first,
      script: 'await new Promise((r) => setTimeout(r, 1200)); return "first-done";',
    });
    await sleep(300);
    service.send({ type: 'EXECUTE', jobId: second, script: 'return "must-not-run";' });

    const frames = await service.waitFor(
      (all) => all.slice(from).some((m) => m.type === 'RESULT' && m.jobId === second),
      6000,
      '第二个 Job 没有得到答复',
    );
    const busy = frames.slice(from).find((m) => m.type === 'RESULT' && m.jobId === second);
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, 'BUSY');

    const settled = await service.waitFor(
      (all) => all.some((m) => m.type === 'RESULT' && m.jobId === first),
      6000,
      '第一个 Job 没有完成',
    );
    const done = settled.find((m) => m.type === 'RESULT' && m.jobId === first);
    assert.equal(done.ok, true);
    assert.equal(done.data, 'first-done');
  });

  // ── 8 ───────────────────────────────────────────────────────────────────────
  await scenario('8. Script 抛异常 → SCRIPT_EXECUTION_FAILED', async () => {
    const thrown = await service.execute({ script: "throw new Error('poc-boom');" });
    assert.equal(thrown.ok, false);
    assert.equal(thrown.error.code, 'SCRIPT_EXECUTION_FAILED');
    assert.match(thrown.error.message, /poc-boom/);

    const syntacticallyBroken = await service.execute({ script: 'this is not javascript' });
    assert.equal(syntacticallyBroken.ok, false);
    assert.equal(syntacticallyBroken.error.code, 'SCRIPT_EXECUTION_FAILED');
  });

  // ── 9 ───────────────────────────────────────────────────────────────────────
  await scenario('9. Work Tab 关闭 → NOT_READY', async () => {
    const target = await soleWorkTab();
    await closePage(options.port, target);
    await waitUntil(async () => (await httpPages(options.port)).length === 0, 5000, '测试页没有关闭');

    const status = await service.getStatus();
    assert.equal(status.state, 'NOT_READY');
    assert.equal(status.reason, 'WORK_TAB_CLOSED');
  });

  // ── 10 ──────────────────────────────────────────────────────────────────────
  await scenario('10. 多普通 Tab → MULTIPLE_TABS 且不任选', async () => {
    await openPage(options.port, pages.urlFor('/one'));
    await openPage(options.port, pages.urlFor('/two'));
    await sleep(600);

    const status = await service.getStatus();
    assert.equal(status.state, 'NOT_READY');
    assert.equal(status.reason, 'MULTIPLE_TABS');
    assert.equal(status.jobId, undefined, '不得任选一个 Tab');

    const refused = await service.execute({ script: 'return 1;' });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'NOT_READY');

    const [extra] = await httpPages(options.port);
    await closePage(options.port, extra.id);
    await waitUntil(
      async () => (await service.getStatus(4000)).state === 'IDLE',
      8000,
      '回到唯一 Tab 后没有重新绑定',
    );
  });

  // ── 11 ──────────────────────────────────────────────────────────────────────
  await scenario('11. Service 断开/恢复 → 自动重连', async () => {
    const servicePort = service.port;
    await service.stop();
    await sleep(1000);

    service = await startTestService({ port: servicePort });
    await service.waitForBridge(30000);
    assert.equal(service.openCount(), 1, 'Bridge 应在新 Service 上重新建立唯一连接');

    const status = await service.getStatus();
    assert.equal(status.state, 'IDLE');
  });

  // ── 12 ──────────────────────────────────────────────────────────────────────
  await scenario('12. 页面出现 captcha 文字时 Bridge 只返回数据、不产生业务状态', async () => {
    const [target] = await httpPages(options.port);
    await evaluate(options.port, target.id, "location.href = '/challenge'; 'go'");
    await sleep(800);

    const result = await service.execute({
      script: "return { text: document.getElementById('challenge').textContent };",
    });
    assert.equal(result.ok, true, 'Bridge 应正常返回脚本看到的数据');
    assert.match(result.data.text, /captcha/i);

    // Bridge's own vocabulary must never gain a business term. The page text
    // itself is expected to pass through in `data` — that is the whole point.
    const bridgeOwnWords = service.received.map((message) => ({
      type: message.type,
      state: message.state,
      reason: message.reason,
      code: message.error?.code,
    }));
    assert.doesNotMatch(
      JSON.stringify(bridgeOwnWords),
      /CAPTCHA|BLOCKED|RISK_CONTROL|LOGIN_REQUIRED/i,
    );

    const states = new Set(
      service.received
        .filter((message) => message.type === 'STATUS')
        .map((message) => message.state),
    );
    for (const state of states) {
      assert.ok(
        ['IDLE', 'RUNNING', 'NOT_READY'].includes(state),
        `出现了三态之外的 Bridge 状态：${state}`,
      );
    }

    console.log(
      '      → Service 自己的解释：页面文本含 captcha 字样（这是 Service 的判断，Bridge 只回传数据）',
    );
  });

  // ── extra: world isolation and robustness ───────────────────────────────────
  await scenario('附加：脚本在隔离世界运行，看不到页面 world 的变量', async () => {
    const result = await service.execute({
      script: 'return { pageSecret: typeof window.__pageSecret, hasDocument: typeof document };',
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.pageSecret, 'undefined', '页面 world 的变量必须不可见');
    assert.equal(result.data.hasDocument, 'object', '但 DOM 必须可操作');
  });

  await scenario('附加：非法帧不打断连接', async () => {
    service.send({ type: 'NOPE', jobId: 'junk-1' });
    await sleep(200);
    const status = await service.getStatus();
    assert.ok(['IDLE', 'RUNNING', 'NOT_READY'].includes(status.state));

    const rejected = await service.waitFor(
      (all) => all.some((m) => m.jobId === 'junk-1'),
      4000,
      '未知 type 应得到答复',
    );
    assert.equal(rejected.find((m) => m.jobId === 'junk-1').ok, false);
  });
} catch (error) {
  // Scenarios swallow their own failures, so anything reaching here is setup or an
  // assertion between scenarios. It has to fail the run, not exit 0 with a summary
  // that only counted the scenarios that happened to run.
  results.push({ name: '前置准备 / 场景编排', ok: false, error: error.message });
} finally {
  console.log('');
  const failed = results.filter((entry) => !entry.ok);
  console.log(`  场景：${results.length - failed.length}/${results.length} 通过`);
  for (const entry of failed) console.log(`    ✖ ${entry.name}: ${entry.error}`);

  if (service) await service.stop();
  if (pages) await pages.close();
  // `stop()` waits for Chrome to actually exit and then removes the profile it was
  // given: signalling the PID alone leaves a full profile behind on every run, and
  // an immediate rerun would then race a profile that is still locked.
  if (browser) await browser.stop();

  process.exitCode = failed.length === 0 ? 0 : 1;
}
