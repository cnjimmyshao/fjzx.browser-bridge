#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { arch, platform, release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allowUserScripts,
  closePage,
  evaluate,
  findBrowser,
  findExtensionId,
  httpPages,
  launchBrowser,
  listTargets,
  openPage,
  sleep,
} from './browser.mjs';
import { KEEPALIVE_INTERVAL_MS, startTestService } from './service.mjs';
import { startTestPageServer } from './page-server.mjs';

/**
 * The KEEPALIVE end-to-end POC for issue #9 / #18, on the *current* `src/`.
 *
 * ADR 0001 decided that the Service keeps an existing Bridge WebSocket receiving
 * by sending `{"type":"KEEPALIVE"}` every 20s. This harness runs the A-F scenarios
 * #18 lists against a real Chrome with the real extension loaded, and records
 * timestamped evidence rather than a claim that "it looked connected".
 *
 *   node tests/poc/keepalive-poc.mjs [--browser <chrome.exe>] [--headed]
 *                                    [--port 9611] [--keepalive-seconds 600]
 *                                    [--baseline-seconds 100] [--phases A,B,C,...]
 *                                    [--smoke] [--evidence <path>]
 *
 * Deliberate measurement constraints, so the numbers mean something:
 *
 * - The worker's lifetime is read from `CDP /json/list` metadata only. No DevTools
 *   is ever attached to the MV3 worker: attaching one keeps it alive and would make
 *   every window trivially "stable". Opening the extension's own settings page is
 *   the same kind of observation.
 * - No continuous polling substitutes for the mechanism under test. During the
 *   keepalive window the *only* WebSocket traffic is the KEEPALIVE loop; the
 *   GET_STATUS/EXECUTE probes run after the window, not during it.
 * - The baseline runs first and is required to show reclamation. A "stable" baseline
 *   means the window is too short or the environment differs, and the run says so
 *   instead of reporting a meaningless pass.
 *
 * Only local addresses, a generated test profile and a local test page are used.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const EXTENSION_ROOT = join(REPO_ROOT, 'src');
const EXTENSION_NAME = 'Browser Bridge';

/** Defaults follow #18: >= 10 minutes of keepalive, >= 90s baseline windows. */
const DEFAULTS = {
  // Deliberately not 9222/9333: those are where other tooling and other POC runs put
  // a browser, and `launchBrowser` refuses to adopt a port it does not own.
  port: 9611,
  headed: false,
  browser: undefined,
  keepaliveSeconds: 600,
  baselineSeconds: 100,
  stopSeconds: 100,
  reconnectDownSeconds: 12,
  phases: ['A', 'B', 'C2', 'D', 'E', 'F', 'G'],
  evidence: join(REPO_ROOT, 'docs', 'research', 'evidence', 'keepalive-poc.json'),
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === '--browser') options.browser = next();
    else if (argv[i] === '--port') options.port = Number(next());
    else if (argv[i] === '--headed') options.headed = true;
    else if (argv[i] === '--smoke') options.smoke = true;
    else if (argv[i] === '--keepalive-seconds') options.keepaliveSeconds = Number(next());
    else if (argv[i] === '--baseline-seconds') options.baselineSeconds = Number(next());
    else if (argv[i] === '--stop-seconds') options.stopSeconds = Number(next());
    else if (argv[i] === '--reconnect-down-seconds') options.reconnectDownSeconds = Number(next());
    else if (argv[i] === '--evidence') options.evidence = next();
    else if (argv[i] === '--phases') {
      options.phases = next()
        .split(',')
        .map((phase) => phase.trim().toUpperCase())
        .filter(Boolean);
    } else if (argv[i].startsWith('--')) {
      throw new Error(`未知参数：${argv[i]}`);
    }
  }

  if (options.smoke) {
    // A short walk through every phase, so a broken scenario is found in two minutes
    // instead of after the ten-minute window. It must never be mistaken for the
    // verification run, hence the evidence default and the recorded limitation.
    options.keepaliveSeconds = 60;
    options.baselineSeconds = 100;
    options.stopSeconds = 100;
    options.reconnectDownSeconds = 10;
    options.evidence = join(tmpdir(), 'keepalive-poc-smoke.json');
  }

  // A phase is only meaningful after the ones it builds on. `--phases C2` on its own
  // would run ordinary GET_STATUS/EXECUTE traffic while still claiming to check the
  // keepalive contract, which is worse than refusing: a green subset run that never
  // sent a single KEEPALIVE. Refusing keeps every selectable combination honest.
  const PHASE_DEPENDENCIES = {
    A: [],
    B: [],
    C2: ['B'],
    D: ['B'],
    E: [],
    F: ['E'],
    G: ['E'],
  };
  for (const name of options.phases) {
    const known = Object.keys(PHASE_DEPENDENCIES);
    if (!known.includes(name)) {
      throw new Error(`未知场景 ${name}；可用：${known.join(', ')}`);
    }
    const missing = PHASE_DEPENDENCIES[name].filter((need) => !options.phases.includes(need));
    if (missing.length > 0) {
      throw new Error(`场景 ${name} 需要同时选择 ${missing.join(', ')}；--phases 不接受依赖不完整的子集`);
    }
  }
  return options;
}

const STARTED_AT = Date.now();
const events = [];

/** One timestamped observation. Every number in the evidence file comes from here. */
function record(phase, event, details = {}) {
  const entry = { at: Date.now(), t: Date.now() - STARTED_AT, phase, event, ...details };
  events.push(entry);
  const extras = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  console.log(`  [${String(Math.round(entry.t / 1000)).padStart(4)}s] ${phase} ${event} ${extras}`);
  return entry;
}

const seconds = (ms) => Math.round((ms / 1000) * 10) / 10;

/**
 * Poll until `check` returns truthy, reporting how long it took.
 *
 * The deadline is checked inside the loop instead of racing a timer: a losing
 * `Promise.race` leaves timers behind, and a pending timer keeps Node alive, which
 * for this harness means a hung run instead of a reported timeout.
 */
async function until(check, timeoutMs, what, everyMs = 250) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return { ms: Date.now() - started, value };
    if (Date.now() >= deadline) throw new Error(`等待「${what}」超时（${timeoutMs}ms）`);
    await sleep(everyMs);
  }
}

/**
 * Is the extension's MV3 service worker registered right now?
 *
 * Metadata only — see the file comment. `service_worker` targets belong to
 * extensions; the extension id makes it unambiguous which one is being watched.
 */
async function workerTargets(port, extensionId) {
  const targets = await listTargets(port);
  return targets.filter(
    (target) =>
      target.type === 'service_worker' && (target.url ?? '').includes(extensionId),
  );
}

/**
 * Watch worker presence and socket openness until `predicate` is satisfied.
 *
 * Samples at `everyMs` and returns both the raw samples and the transitions, so a
 * window can be read back without re-deriving anything from the printed log.
 */
async function observe({ port, extensionId, service, until: predicate, timeoutMs, everyMs = 1000 }) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const samples = [];
  const transitions = [];
  let workerPresent = null;
  let socketOpen = null;

  for (;;) {
    const workers = await workerTargets(port, extensionId);
    const present = workers.length > 0;
    // A reclaim takes the socket with it, so this is a second, independent view.
    const open = service.openCount() > 0;
    const t = Date.now() - started;
    samples.push({ t, workerPresent: present, workerTargets: workers.length, socketOpen: open });

    if (workerPresent === null || present !== workerPresent) {
      transitions.push({ t, workerPresent: present });
      workerPresent = present;
    }
    if (socketOpen === null || open !== socketOpen) {
      transitions.push({ t, socketOpen: open });
      socketOpen = open;
    }

    if (predicate({ workerPresent: present, socketOpen: open, samples, transitions })) {
      return { startedAt: started, endedAt: Date.now(), durationMs: Date.now() - started, samples, transitions };
    }
    if (Date.now() >= deadline) {
      return { startedAt: started, endedAt: Date.now(), durationMs: Date.now() - started, samples, transitions, timedOut: true };
    }
    await sleep(everyMs);
  }
}

/** How many samples observed a reclaim within a window. */
const reclaimsIn = (window) =>
  window.transitions.filter((entry) => entry.workerPresent === false).length;

const result = {
  startedAt: new Date(STARTED_AT).toISOString(),
  environment: {
    platform: `${platform()} ${release()} ${arch()}`,
    // `nvm`/`fnm` shims make `process.version` the honest answer here.
    node: process.version,
    keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  },
  options: null,
  browserVersion: null,
  /**
   * `commit` is what HEAD was when this run started; `workingTreeDirty` is
   * `git status --porcelain` at the same moment. Together they say which revision
   * the loaded `src/` actually was: a run started before a documentation-only commit
   * would otherwise look like it tested the wrong code, and a run with a modified
   * extension would look like it tested a commit.
   */
  commit: null,
  workingTreeDirty: null,
  phases: [],
  timings: {},
  events,
  checks: [],
  remainingLimitations: [],
};

function commitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** `git status --porcelain`, so a reader can tell whether "this checkout" is a commit. */
function workingTreeStatus() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * What this run does *not* establish, recorded next to the numbers so the evidence
 * file cannot be read as a broader guarantee than the ADR makes.
 */
function baseLimitations(options, headless) {
  return [
    'KEEPALIVE 只维持尚存活连接的消息活动；浏览器退出、系统休眠、网络中断或 worker 已被回收均不在保证范围内（ADR 0001）。',
    'worker 存活时间取自 CDP /json/list 元数据；全程未附着 worker DevTools，因此无法观察 worker 内部计时器，只能观察 worker target 是否存在。',
    `保活窗口内唯一的 WebSocket 流量是 KEEPALIVE 循环；GET_STATUS/EXECUTE 探针在窗口结束后才运行，不用额外活动代替被测机制。`,
    `本次为 ${headless ? 'headless（--headless=new）' : 'headed'} 模式、单一 Chrome for Testing 版本、单一 Windows 机器；不同版本或 headed 模式是否同样回收未在本次验证。`,
    '真实 Profile、真实业务站点与真实 Service 的业务 Job 未参与本次验证。',
    ...(options.keepaliveSeconds < 600
      ? [`本次保活窗口被参数缩短为 ${options.keepaliveSeconds}s，不足 #18 要求的 10 分钟，不能据此声称 10 分钟保活已通过。`]
      : []),
    ...(options.smoke
      ? ['本次为 --smoke 短窗口试跑，只用于确认 harness 本身跑得通，不是保活验证结果。']
      : []),
  ];
}

function writeEvidence() {
  result.evidencePath = options.evidence;
  try {
    // A run whose evidence cannot be written is a run that proves nothing, and the
    // default path lives in a directory that may not exist yet in a fresh checkout.
    mkdirSync(dirname(options.evidence), { recursive: true });
    writeFileSync(options.evidence, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return true;
  } catch (error) {
    console.error(`  证据写入失败：${error.message}`);
    result.evidenceWriteFailed = error.message;
    return false;
  }
}

let pages = null;
let service = null;
let browser = null;
let extensionId = null;
let optionsUrl = null;
let servicePort = null;

/** Scenario bookkeeping: each phase contributes its own pass/fail record. */
async function phase(name, body) {
  console.log(`\n── 场景 ${name} ─────────────────────────────────────────────`);
  const entry = { phase: name, startedAt: Date.now() - STARTED_AT, ok: true, assertions: [] };
  result.phases.push(entry);
  try {
    await body(entry);
  } catch (error) {
    entry.ok = false;
    entry.error = error.message;
    console.log(`  ✖ ${name}: ${error.message}`);
    // No phase is allowed to fail quietly. They all assert required behaviour, so a
    // failing one is a broken run rather than an optional diagnostic — continuing
    // would let the remaining phases test a Bridge in a state the run never explains.
    throw error;
  } finally {
    entry.durationMs = Date.now() - STARTED_AT - entry.startedAt;
  }
  return entry;
}

function check(entry, description, condition, details = {}) {
  const outcome = { description, ok: Boolean(condition), ...details };
  entry.assertions.push(outcome);
  result.checks.push({ phase: entry.phase, ...outcome });
  console.log(`  ${condition ? '✔' : '✖'} ${description}`);
  assert.ok(condition, description);
}

/** Waits for the form to be interactive, then submits `url` on the real settings page. */
async function saveServiceUrl(url) {
  const target = await openPage(options.port, optionsUrl);
  try {
    await until(
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
      '设置页就绪',
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
  } finally {
    await closePage(options.port, target);
  }
}

/**
 * Wake a reclaimed worker through the one extension event this harness can cause
 * deliberately and observably: writing the Service URL again.
 *
 * Re-saving the *same* value is not enough — `chrome.storage.local.set` with an
 * unchanged value fires no `onChanged`. So the URL is briefly pointed at a dead
 * endpoint and then restored, which is also exactly what an operator does when
 * reconfiguring a profile. The wake is logged, never assumed.
 */
async function wakeWorker(phaseName) {
  const deadUrl = `ws://127.0.0.1:1`;
  record(phaseName, 'wake-begin', { method: 'settings-save', via: deadUrl });
  await saveServiceUrl(deadUrl);
  await sleep(500);
  await saveServiceUrl(service.url);
  const revived = await until(
    async () => service.openCount() > 0,
    30000,
    '唤醒后 Bridge 重新连接',
    250,
  );
  record(phaseName, 'wake-done', { reconnectMs: revived.ms });
  return revived.ms;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  // A bad invocation is a usage error, not a crash: a Phase-1 stack trace would bury
  // the one line that says which phase selection is not allowed.
  console.error(`✖ ${error.message}`);
  process.exit(2);
}
result.options = options;
result.commit = commitSha();
result.workingTreeDirty = workingTreeStatus() || '';
result.remainingLimitations = baseLimitations(options, !options.headed);
const wanted = (name) => options.phases.includes(name);
const exe = findBrowser(options.browser);

console.log('Browser Bridge KEEPALIVE POC（issue #9 / #18，当前 src/）\n');
console.log(`  browser     ${exe}`);
console.log(`  extension   ${EXTENSION_ROOT}`);
console.log(`  keepalive   ${KEEPALIVE_INTERVAL_MS}ms`);
console.log(`  phases      ${options.phases.join(', ')}`);

try {
  pages = await startTestPageServer();
  service = await startTestService();
  servicePort = service.port;
  browser = await launchBrowser({
    exe,
    extensionPath: EXTENSION_ROOT,
    port: options.port,
    headless: !options.headed,
  });
  result.browserVersion = browser.browser;
  console.log(`  service     ${service.url}`);
  console.log(`  page        ${pages.urlFor('/')}`);
  console.log(`  chrome      ${browser.browser}\n`);

  extensionId = await findExtensionId(options.port, EXTENSION_NAME);
  const manifest = JSON.parse(readFileSync(join(EXTENSION_ROOT, 'manifest.json'), 'utf8'));
  optionsUrl = `chrome-extension://${extensionId}/${manifest.options_ui.page}`;
  await openPage(options.port, pages.urlFor('/'));

  // ── setup: connect, and only then allow user scripts ────────────────────────
  //
  // Order matters. Toggling "Allow User Scripts" touches the extension and wakes
  // its worker, so doing it *after* the first connection is what puts the baseline
  // window at the start of a fresh worker lifetime instead of somewhere in the
  // middle of one.
  await saveServiceUrl(service.url);
  await until(async () => service.openCount() > 0, 60000, 'Bridge 首次连接', 250);
  record('setup', 'bridge-connected', { openConnections: service.openCount() });
  assert.equal(await allowUserScripts(options.port, extensionId), true);
  await sleep(1500);

  const idleStatus = await service.getStatus(8000);
  assert.equal(idleStatus.state, 'IDLE', 'POC 前提：唯一 Work Tab 且未执行 Job');
  record('setup', 'ready', { state: idleStatus.state });

  // ── setup: can the test Service actually drive a send loop? ─────────────────
  //
  // A smoke check on a throwaway Service, before any measurement. Its job is to make
  // sure the later scenarios are not "passing" with a loop that never sent anything —
  // B would then prove nothing about a cadence, and E nothing about frames inside a
  // Job. Short interval on purpose: this asks whether the loop runs and stops, not
  // whether its period is 20s (B measures that).
  //
  // It is *not* the leak check. `stop()` has already closed the listening socket by
  // the time the count is re-read, so a surviving `setInterval` would have nothing to
  // send on; and `process._getActiveHandles()` does not expose a live interval on
  // current Node, so filtering it proves nothing either way. The bounded proof that no
  // timer survives `stop()` is the Node test in `tests/poc-harness.test.js`, which
  // requires the process to exit on its own.
  if (wanted('B') || wanted('E')) {
    const probe = await startTestService();
    try {
      const probeSocket = new WebSocket(probe.url);
      await new Promise((resolve, reject) => {
        probeSocket.addEventListener('open', resolve, { once: true });
        probeSocket.addEventListener('error', reject, { once: true });
      });
      probe.startKeepalive(200);
      // Plain polling rather than `until()`: that helper's 250ms floor is the same
      // order as this interval.
      const sendDeadline = Date.now() + 3000;
      while (probe.keepaliveSends.length < 3 && Date.now() < sendDeadline) {
        await sleep(50);
      }
      const sendsBeforeStop = probe.keepaliveSends.length;
      probeSocket.close();
      await probe.stop();
      record('setup', 'send-loop-probe', {
        sendsBeforeStop,
        keepaliveRunningAfterStop: probe.keepaliveRunning,
      });
      assert.ok(sendsBeforeStop >= 3, `探针 Service 应至少投递 3 次，实际 ${sendsBeforeStop}`);
      assert.equal(probe.keepaliveRunning, false, 'stop() 之后发送循环不应仍在运行');
    } finally {
      await probe.stop().catch(() => {});
    }
  }

  // ── A: baseline, no WebSocket activity ──────────────────────────────────────
  if (wanted('A')) {
    await phase('A', async (entry) => {
      const before = service.openCount();
      const windowStartedAt = Date.now();
      // Sampled for the whole configured window, not until the first disappearance.
      // Returning early would make "no reconnect" a claim about ~31 seconds while the
      // evidence says the baseline ran for 100, and a worker that came back later (or
      // a socket that reopened) inside the remaining time would go unnoticed.
      const window = await observe({
        port: options.port,
        extensionId,
        service,
        until: () => Date.now() - windowStartedAt >= options.baselineSeconds * 1000,
        timeoutMs: options.baselineSeconds * 1000 + 5000,
      });
      const reclaim = window.transitions.find((t) => t.workerPresent === false);
      const socketDropped = window.transitions.find((t) => t.socketOpen === false);
      // Any transition after the loss means the baseline was not quiet after all.
      const workerComesBack = window.transitions.some(
        (t) => t.workerPresent === true && reclaim !== undefined && t.t > reclaim.t,
      );
      const socketReopens = window.transitions.some(
        (t) => t.socketOpen === true && socketDropped !== undefined && t.t > socketDropped.t,
      );
      result.timings.baselineReclaimMs = reclaim ? reclaim.t : null;
      result.timings.baselineSocketDropMs = socketDropped ? socketDropped.t : null;
      result.timings.baselineWindowMs = window.durationMs;
      record('A', 'baseline-window', {
        durationMs: window.durationMs,
        reclaims: reclaimsIn(window),
        socketDrops: window.transitions.filter((t) => t.socketOpen === false).length,
        socketDroppedAfterMs: result.timings.baselineSocketDropMs,
        workerComesBack,
        socketReopens,
        workerTargetsSeen: [...new Set(window.samples.map((s) => s.workerTargets))],
        samplesTaken: window.samples.length,
      });
      // Both halves are recorded through `check`, not only printed: the evidence file
      // is the record a reviewer reads, so an assertion that never reaches it is an
      // assertion the file does not actually claim.
      check(entry, 'A 基线：无 WebSocket 活动时 Worker 被回收', reclaim !== undefined, {
        reclaimAfterMs: reclaim ? reclaim.t : null,
        openConnectionsAtStart: before,
      });
      check(
        entry,
        'A 基线：socket 随 Worker 一起断开，且在完整窗口内没有重连',
        socketDropped !== undefined && !socketReopens && !workerComesBack,
        {
          socketDroppedAfterMs: result.timings.baselineSocketDropMs,
          windowMs: window.durationMs,
          socketReopens,
          workerComesBack,
        },
      );
      check(entry, `A 基线：观察窗口覆盖配置的 ${options.baselineSeconds}s`, window.durationMs >= options.baselineSeconds * 1000, {
        windowMs: window.durationMs,
        samplesTaken: window.samples.length,
      });
    });
  }

  // ── B: 20s KEEPALIVE for >= 10 minutes ──────────────────────────────────────
  let keepaliveWindow = null;
  let keepaliveStartedAt = null;

  if (wanted('B')) {
    await phase('B', async (entry) => {
      await wakeWorker('B');
      // Two separate marks: `sendsBefore` indexes the Service's KEEPALIVE send log,
      // `framesBefore` indexes the frames the Bridge has sent back.
      const sendsBefore = service.keepaliveSends.length;
      const framesBefore = service.mark();
      keepaliveStartedAt = Date.now();
      service.startKeepalive();
      record('B', 'keepalive-started', { intervalMs: KEEPALIVE_INTERVAL_MS });

      keepaliveWindow = await observe({
        port: options.port,
        extensionId,
        service,
        until: () => Date.now() - keepaliveStartedAt >= options.keepaliveSeconds * 1000,
        timeoutMs: options.keepaliveSeconds * 1000 + 5000,
      });

      const sent = service.keepaliveSends.length - sendsBefore;
      const windowSends = service.keepaliveSends.slice(sendsBefore);
      // What the cadence claim actually needs: every gap must sit near one period, and
      // the number of sends must match what that cadence can produce over the window.
      // A ceiling on the gap alone would accept a second loop or a 1s timer — those
      // only shrink the gaps — so the lower bound and the maximum count are what
      // actually pin the confirmed 20s contract. `floor(window / 20)` as a minimum
      // would instead demand a frame at exactly t=window, which is outside the window
      // by definition; the gap check is what proves the cadence, the count check only
      // proves coverage.
      const gaps = windowSends
        .slice(1)
        .map((send, index) => send.at - windowSends[index].at);
      const maxGapMs = gaps.length > 0 ? Math.max(...gaps) : null;
      const minGapMs = gaps.length > 0 ? Math.min(...gaps) : null;
      const expected = Math.ceil((options.keepaliveSeconds * 1000) / KEEPALIVE_INTERVAL_MS);
      // ±15% around one period covers timer drift and the POC's own 250ms polls.
      const gapMinMs = KEEPALIVE_INTERVAL_MS * 0.85;
      const gapMaxMs = KEEPALIVE_INTERVAL_MS * 1.15;
      // One send opens the loop; the rest are periodic. Anything more per period means
      // something is sending outside the confirmed cadence.
      const maxSends = Math.ceil((options.keepaliveSeconds * 1000) / KEEPALIVE_INTERVAL_MS) + 1;
      const repliesDuringWindow = service.since(framesBefore);
      result.timings.repliesDuringKeepaliveWindow = repliesDuringWindow.length;
      result.timings.keepaliveWindowMs = keepaliveWindow.durationMs;
      result.timings.keepaliveSent = sent;
      result.timings.keepaliveExpectedAtLeast = expected;
      result.timings.keepaliveExpectedAtMost = maxSends;
      result.timings.keepaliveMaxGapMs = maxGapMs;
      result.timings.keepaliveMinGapMs = minGapMs;
      record('B', 'keepalive-window', {
        durationMs: keepaliveWindow.durationMs,
        sent,
        minGapMs,
        maxGapMs,
        gapsWithinBand: gaps.every((gap) => gap >= gapMinMs && gap <= gapMaxMs),
        reconnects: service.bridgeCount() - 1,
        reclaims: reclaimsIn(keepaliveWindow),
        repliesFromBridge: repliesDuringWindow.length,
      });

      check(entry, `B 保活窗口内 Worker 从未被回收（${seconds(keepaliveWindow.durationMs)}s）`, reclaimsIn(keepaliveWindow) === 0, {
        reconnects: service.bridgeCount() - 1,
      });
      check(entry, 'B 窗口内 socket 始终 OPEN', keepaliveWindow.samples.every((s) => s.socketOpen));
      check(
        entry,
        `B 窗口内投递间隔保持 ${KEEPALIVE_INTERVAL_MS / 1000}s（实测 ${seconds(minGapMs ?? 0)}–${seconds(maxGapMs ?? 0)}s）`,
        maxGapMs !== null && minGapMs >= gapMinMs && maxGapMs <= gapMaxMs,
        { minGapMs, maxGapMs, allowedBandMs: [gapMinMs, gapMaxMs] },
      );
      check(
        entry,
        `B 投递节奏既是 20s 也不高于 20s：${sent} 次落在 ${expected}–${maxSends} 之间`,
        sent >= expected && sent <= maxSends,
        { expectedAtLeast: expected, expectedAtMost: maxSends, windowMs: keepaliveWindow.durationMs },
      );
      check(
        entry,
        `B 整个保活窗口内 Bridge 一帧都没有回（${sent} 次投递 → ${repliesDuringWindow.length} 条回帧）`,
        repliesDuringWindow.length === 0,
        { replies: repliesDuringWindow.map((message) => message.type) },
      );
    });
  }

  // ── C2: long idle then GET_STATUS / EXECUTE, with keepalive still running ────
  if (wanted('C2')) {
    await phase('C2', async (entry) => {
      // Deliberately *after* the window: these are the traffic the acceptance asks
      // for, and running them inside it would be the "extra activity instead of the
      // mechanism under test" the ADR rules out.
      const status = await service.getStatus(6000);
      check(entry, 'C2 长时间无业务 Job 后 GET_STATUS 立刻有 STATUS', status?.type === 'STATUS', {
        state: status?.state,
      });
      check(entry, 'C2 该 STATUS 仍是 IDLE', status.state === 'IDLE');

      const executed = await service.execute({ script: 'return { ok: 1 };' });
      check(entry, 'C2 无副作用 EXECUTE → RESULT ok=true', executed.ok === true, {
        data: executed.data,
      });
    });
  }

  // ── D: stop keepalive and watch Chrome reclaim the worker ───────────────────
  if (wanted('D')) {
    await phase('D', async (entry) => {
      const lastSend = service.keepaliveSends.at(-1)?.at ?? null;
      assert.ok(service.stopKeepalive(), 'D 前提：KEEPALIVE 循环应在运行');
      record('D', 'keepalive-stopped', { lastSendAgoMs: lastSend ? Date.now() - lastSend : null });

      const window = await observe({
        port: options.port,
        extensionId,
        service,
        until: (state) => state.workerPresent === false && state.socketOpen === false,
        timeoutMs: options.stopSeconds * 1000,
      });
      const reclaim = window.transitions.find((t) => t.workerPresent === false);
      result.timings.reclaimAfterStopMs = reclaim ? reclaim.t : null;
      result.timings.reclaimAfterLastKeepaliveMs = reclaim && lastSend ? reclaim.t + (window.startedAt - lastSend) : null;
      record('D', 'stop-window', {
        durationMs: window.durationMs,
        reclaims: reclaimsIn(window),
        reclaimAfterMs: reclaim ? reclaim.t : null,
      });
      check(entry, 'D 停止保活后 worker 恢复 idle 回收', reclaim !== undefined, {
        reclaimAfterStopMs: reclaim ? reclaim.t : null,
        reclaimAfterLastKeepaliveMs: result.timings.reclaimAfterLastKeepaliveMs,
      });
    });
  }

  // ── E: KEEPALIVE during a RUNNING Job ───────────────────────────────────────
  if (wanted('E')) {
    await phase('E', async (entry) => {
      await wakeWorker('E');
      // Restart the loop rather than inherit B's phase. The claim under test is "the
      // Job survives periodic frames", so the frames have to be counted from the
      // Job's own start — inheriting a loop already 600s into its cadence would make
      // how many frames land inside the Job depend on where the Job happens to begin.
      service.stopKeepalive();
      service.startKeepalive();
      record('E', 'keepalive-restarted', { intervalMs: KEEPALIVE_INTERVAL_MS });

      const jobId = service.nextJobId('running-keepalive');
      const from = service.mark();
      const jobStartAt = Date.now();
      const job = service.execute({
        jobId,
        // Comfortably longer than two periods, so at least two periodic frames land
        // inside the Job instead of only the synchronous one that opened the loop.
        timeoutMs: 90000,
        script: 'await new Promise((r) => setTimeout(r, 45000)); return "long-done";',
      });
      await sleep(1500);

      const running = await service.getStatus(6000);
      check(entry, 'E RUNNING 期间 GET_STATUS 仍为 RUNNING + 原 jobId', running.state === 'RUNNING' && running.jobId === jobId, {
        state: running.state,
        jobId: running.jobId,
      });

      // From here to the next probe is a keepalive-only window inside RUNNING: the Job
      // is in flight, so nothing but KEEPALIVE should reach the Bridge. Counting every
      // frame the Bridge sent in that window is what catches a state-dependent
      // violation — a STATUS or a keyed RESULT per keepalive would otherwise slip past
      // the shape-specific filters further down.
      const framesBeforeQuietWindow = service.mark();
      const sendsBeforeQuietWindow = service.keepaliveSends.length;
      // Wait until the Job has been running across two full periods, then probe: that
      // is what "spans multiple keepalive cycles" has to mean.
      await until(
        () => Date.now() - jobStartAt >= KEEPALIVE_INTERVAL_MS * 2 + 2000,
        60000,
        'RUNNING 期间跨越两个 keepalive 周期',
        250,
      );
      const sentDuringJob = service.keepaliveSends.filter((send) => send.at >= jobStartAt).length;
      const quietWindowFrames = service.since(framesBeforeQuietWindow);
      const quietWindowSends = service.keepaliveSends.length - sendsBeforeQuietWindow;
      record('E', 'running-quiet-window', {
        keepaliveSent: quietWindowSends,
        repliesFromBridge: quietWindowFrames.length,
      });
      check(
        entry,
        `E RUNNING 期间的保活窗口内 Bridge 没有回帧（${quietWindowSends} 次投递 → ${quietWindowFrames.length} 条回帧）`,
        quietWindowSends >= 2 && quietWindowFrames.length === 0,
        {
          keepaliveSent: quietWindowSends,
          replies: quietWindowFrames.map((message) => message.type),
        },
      );

      const stillRunning = await service.getStatus(6000);
      check(entry, 'E 跨多个 keepalive 周期后 currentJob 未被改写', stillRunning.state === 'RUNNING' && stillRunning.jobId === jobId, {
        state: stillRunning.state,
        jobId: stillRunning.jobId,
        keepaliveSentDuringJob: sentDuringJob,
      });
      check(entry, 'E 该 Job 期间确实投递了两次周期性 KEEPALIVE', sentDuringJob >= 2, {
        keepaliveSentDuringJob: sentDuringJob,
      });

      const settled = await job;
      check(entry, 'E 原 Job 正常 RESULT', settled.ok === true && settled.data === 'long-done', {
        data: settled.data,
      });
      const busy = service.since(from).filter((message) => message.error?.code === 'BUSY');
      check(entry, 'E KEEPALIVE 没有产生 BUSY', busy.length === 0);
      const kaResults = service.since(from).filter((message) => message.type === 'RESULT' && !message.jobId);
      check(entry, 'E KEEPALIVE 没有产生无 jobId 的 RESULT', kaResults.length === 0);
    });
  }

  // ── F: KEEPALIVE during NOT_READY ───────────────────────────────────────────
  if (wanted('F')) {
    await phase('F', async (entry) => {
      const sole = (await httpPages(options.port))[0];
      await closePage(options.port, sole.id);
      await until(async () => (await httpPages(options.port)).length === 0, 8000, 'Work Tab 关闭', 250);

      const framesBeforeQuietWindow = service.mark();
      const sendsBeforeQuietWindow = service.keepaliveSends.length;
      // Two keepalive periods, so the window is real rather than a single frame.
      await sleep(KEEPALIVE_INTERVAL_MS * 2 + 2000);

      // Keepalive-only window inside NOT_READY: no probe has been sent yet, so any
      // frame the Bridge produced here is a response to KEEPALIVE. Checking the type
      // of the reply is not enough — a NOT_READY-specific violation would be a
      // STATUS, which the previous literal-`KEEPALIVE` filter could never see.
      const quietWindowFrames = service.since(framesBeforeQuietWindow);
      const quietWindowSends = service.keepaliveSends.length - sendsBeforeQuietWindow;
      record('F', 'not-ready-quiet-window', {
        keepaliveSent: quietWindowSends,
        repliesFromBridge: quietWindowFrames.length,
      });
      check(
        entry,
        `F NOT_READY 期间的保活窗口内 Bridge 没有回帧（${quietWindowSends} 次投递 → ${quietWindowFrames.length} 条回帧）`,
        quietWindowSends >= 2 && quietWindowFrames.length === 0,
        {
          keepaliveSent: quietWindowSends,
          replies: quietWindowFrames.map((message) => message.type),
        },
      );

      const status = await service.getStatus(8000);
      check(entry, 'F NOT_READY 期间 KEEPALIVE 不改变状态', status.state === 'NOT_READY', {
        state: status.state,
        reason: status.reason,
      });
      // Which of the two reasons a closed sole Work Tab produces is the Work Tab
      // manager's business, not this scenario's; what matters is that it stays a
      // technical NOT_READY reason rather than being replaced by anything.
      check(
        entry,
        'F 无 Work Tab 时报告 WORK_TAB_CLOSED 或 NO_WORK_TAB',
        ['WORK_TAB_CLOSED', 'NO_WORK_TAB'].includes(status.reason),
        { reason: status.reason },
      );
      check(entry, 'F KEEPALIVE 不创建 Tab', (await httpPages(options.port)).length === 0);
      check(entry, 'F NOT_READY 期间 socket 仍可达', service.openCount() > 0, {
        openConnections: service.openCount(),
      });

      // Two tabs: the ambiguous case, which must stay ambiguous.
      await openPage(options.port, pages.urlFor('/one'));
      await openPage(options.port, pages.urlFor('/two'));
      await sleep(1500);
      const ambiguous = await service.getStatus(8000);
      check(entry, 'F 多 Tab 时仍是 MULTIPLE_TABS，Bridge 不任选一个', ambiguous.reason === 'MULTIPLE_TABS', {
        reason: ambiguous.reason,
      });
    });
  }

  // ── G: Service disconnect, send-loop cleanup and reconnect ─────────────────
  if (wanted('G')) {
    await phase('G', async (entry) => {
      check(entry, 'G 断开前 KEEPALIVE 循环在运行', service.keepaliveRunning);
      record('G', 'service-stopping', { keepaliveSends: service.keepaliveSends.length });

      await service.stop();
      check(entry, 'G Service 停止后 KEEPALIVE 发送循环已清理', service.keepaliveRunning === false);
      // Deliberately *not* an introspection check here or anywhere else.
      // `process._getActiveHandles()` does not expose a live `setInterval` as a
      // `Timeout` on current Node, so filtering it returns an empty list whether or not
      // a timer leaked — an assertion that can never fail is worse than no assertion.
      //
      // Waiting out a period here to look for stray sends would also push this
      // scenario's service outage past the Worker idle window, turning G into another
      // reclaim observation and costing it the reconnection it exists to test. The
      // cleanup is therefore verified once, up front, in the probe below. Its bounded
      // form — the process exiting on its own after `stop()` — lives in
      // `tests/poc-harness.test.js`.

      // The default outage is deliberately shorter than the idle window the baseline
      // measures. That is what makes this scenario about *reconnection*: the worker
      // survives the Service being away, so the V1.2 backoff still has a timer to
      // fire. Keeping the Service down past the idle window would instead re-observe
      // the reclaim problem A/D already cover, in which case no reconnect can be
      // expected at all — see the branch below.
      record('G', 'service-down');
      await sleep(options.reconnectDownSeconds * 1000);
      const workerAfterOutage = await workerTargets(options.port, extensionId);
      const workerReclaimed = workerAfterOutage.length === 0;
      result.timings.workerReclaimedDuringOutage = workerReclaimed;

      service = await startTestService({ port: servicePort });
      record('G', 'service-restarted', { workerReclaimed });

      let recoveredMs = null;
      try {
        recoveredMs = (
          await until(async () => service.openCount() > 0, 45000, 'Bridge 重连', 250)
        ).ms;
      } catch {
        recoveredMs = null;
      }
      result.timings.reconnectAfterOutageMs = recoveredMs;
      record('G', 'reconnect-outcome', { recoveredMs, workerReclaimed });

      check(entry, 'G Service 恢复后 Bridge 重连', recoveredMs !== null, { recoveredMs });
      if (recoveredMs === null) {
        // Only the reclaimed case has an explanation the ADR accepts; a worker that
        // was still alive and still failed to reconnect is a real defect.
        check(entry, 'G 未重连只可能是 worker 已被回收', workerReclaimed, {
          note: 'KEEPALIVE 维持尚存活连接的活动，不负责唤醒已终止的 worker',
        });
        result.remainingLimitations.push(
          'G：本次 Service 离线时间超过了 worker 的空闲窗口，重连定时器随 worker 一起消失，Service 恢复后未能自动重连；这是 #9 记录的既有局限，不属于 KEEPALIVE 的保证范围。',
        );
      } else {
        const beforeResume = service.keepaliveSends.length;
        service.startKeepalive();
        await until(
          () => service.keepaliveSends.length > beforeResume,
          60000,
          '重连后 KEEPALIVE 恢复',
          250,
        );
        check(entry, 'G 重连后 KEEPALIVE 恢复投递', service.keepaliveSends.length > beforeResume, {
          sentBeforeResume: beforeResume,
          sentNow: service.keepaliveSends.length,
        });
        check(
          entry,
          'G 重连后仍然只有一个 keepalive 发送循环',
          service.keepaliveRunning === true,
          { keepaliveSends: service.keepaliveSends.length },
        );
      }
    });
  }

  result.summary = {
    phasesRun: result.phases.length,
    phasesFailed: result.phases.filter((entry) => !entry.ok).length,
    durationMs: Date.now() - STARTED_AT,
  };

  // Self-consistency: the evidence file is the record a reviewer reads, so an
  // assertion that a phase counted but did not hand to `check` would silently shrink
  // what the file claims was verified. Fail loudly instead of writing a record that
  // is quietly thinner than the run.
  const assertionsRun = result.phases.reduce((total, entry) => total + entry.assertions.length, 0);
  result.summary.assertionsRun = assertionsRun;
  result.summary.assertionsRecorded = result.checks.length;
  if (assertionsRun !== result.checks.length) {
    result.evidenceIncomplete =
      `阶段共记录 ${assertionsRun} 条断言，但证据文件只收到 ${result.checks.length} 条；` +
      '有断言绕过了 check()，本文件不完整。';
    console.error(`  ✖ ${result.evidenceIncomplete}`);
  }

  result.finishedAt = new Date().toISOString();
  writeEvidence();
  console.log(`\n  证据：${options.evidence}`);
} catch (error) {
  result.summary = {
    phasesRun: result.phases.length,
    phasesFailed: result.phases.filter((entry) => !entry.ok).length,
    durationMs: Date.now() - STARTED_AT,
    fatal: error.message,
  };
  result.finishedAt = new Date().toISOString();
  writeEvidence();
  console.error(`\n✖ POC 未通过：${error.message}`);
} finally {
  console.log('');
  for (const entry of result.phases) {
    const failed = entry.assertions.filter((assertion) => !assertion.ok);
    console.log(
      `  ${entry.ok ? '✔' : '✖'} ${entry.phase}  ${entry.assertions.length - failed.length}/${entry.assertions.length} 断言通过`,
    );
  }
  if (result.summary) {
    console.log(
      `\n  场景：${result.summary.phasesRun - result.summary.phasesFailed}/${result.summary.phasesRun} 通过，总耗时 ${seconds(result.summary.durationMs)}s`,
    );
  }
  if (service) await service.stop().catch(() => {});
  if (pages) await pages.close();
  if (browser) await browser.stop();

  // Any requested phase failing fails the run: they all assert required behaviour, and
  // a green exit code next to a summary that lists failed scenarios is how a
  // regression gets waved through. Missing evidence fails too — the evidence file is
  // the record a reviewer has to be able to read.
  const failedPhases = result.phases.filter((entry) => !entry.ok);
  process.exitCode =
    failedPhases.length > 0 ||
    result.summary?.fatal ||
    result.evidenceWriteFailed ||
    result.evidenceIncomplete
      ? 1
      : 0;
}
