import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The small amount of Chrome control the POC needs: start a browser with the
 * extension loaded, allow user scripts, open pages, and read the DOM back.
 *
 * Two facts from #6 shape this file:
 *
 * - Branded Chrome 142+ ignores `--load-extension`, so an unpacked extension can
 *   only be loaded by Chrome for Testing (or Chromium). `findBrowser` says so
 *   instead of failing mysteriously.
 * - `chrome.userScripts` is absent until an operator allows user scripts per
 *   extension, which is a toggle in the extension's details page. `allowUserScripts`
 *   clicks it, because a POC that cannot run scripts is not a POC.
 */

const DEBUG_PORT = 9222;

/** Locations worth trying when BROWSER_EXECUTABLE is not set. */
function browserCandidates() {
  const local = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';

  return [
    process.env.BROWSER_EXECUTABLE,
    join(local, 'chrome-for-testing', 'chrome-win64', 'chrome.exe'),
    join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    join(programFiles, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

export function findBrowser(explicit) {
  const candidates = [explicit, ...browserCandidates()].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    [
      '找不到可用于加载未打包扩展的浏览器。',
      '品牌版 Chrome 142+ / Edge 已忽略 --load-extension，请使用 Chrome for Testing：',
      '  1. 下载：https://googlechromelabs.github.io/chrome-for-testing/',
      '  2. 设置环境变量 BROWSER_EXECUTABLE 指向 chrome.exe，或传 --browser <path>',
      `已尝试：${candidates.join('、')}`,
    ].join('\n'),
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal DevTools Protocol client, one socket per target. */
async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`无法连接 CDP：${webSocketDebuggerUrl}`));
  });

  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };

  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // already gone
      }
    },
  };
}

/** @param {number} port */
export async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  return response.json();
}

/** @param {number} port @param {string} targetId @param {string} expression */
export async function evaluate(port, targetId, expression) {
  const target = (await listTargets(port)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error(`找不到目标 ${targetId}`);

  const client = await connect(target.webSocketDebuggerUrl);
  try {
    const result = await client.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? '页面求值失败');
    }
    return result.result?.value;
  } finally {
    client.close();
  }
}

/** @param {number} port @param {string} url @param {number} [timeoutMs] */
export async function openPage(port, url, timeoutMs = 15000) {
  await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await listTargets(port)).find(
      (candidate) => candidate.type === 'page' && candidate.url.startsWith(url.split('?')[0]),
    );
    if (target) return target.id;
    await sleep(100);
  }
  throw new Error(`打开页面超时：${url}`);
}

/** @param {number} port @param {string} targetId */
export async function closePage(port, targetId) {
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
}

/** Ordinary http(s) pages currently open. */
export async function httpPages(port) {
  const targets = await listTargets(port);
  return targets.filter(
    (target) => target.type === 'page' && /^https?:/.test(target.url ?? ''),
  );
}

/**
 * @param {{exe: string, extensionPath: string, port?: number, profile?: string, headless?: boolean}} options
 */
export async function launchBrowser(options) {
  const {
    exe,
    extensionPath,
    port = DEBUG_PORT,
    profile = join(tmpdir(), `bridge-poc-profile-${port}`),
    headless = true,
  } = options;

  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--disable-features=Translate,OptimizationHints',
    `--load-extension=${extensionPath}`,
    `--disable-extensions-except=${extensionPath}`,
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');

  // `stdio: 'ignore'` keeps the browser detached from this process's stdio.
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const version = await response.json();
      return { port, profile, pid: child.pid, browser: version.Browser };
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`浏览器调试端口 ${port} 在 30s 内没有就绪`);
}

/** @param {number} port @param {string} name */
export async function findExtensionId(port, name) {
  const targetId = await openPage(port, 'chrome://extensions');
  await sleep(1200);
  const found = await evaluate(
    port,
    targetId,
    `(() => {
      const manager = document.querySelector('extensions-manager');
      const list = manager?.shadowRoot?.querySelector('extensions-item-list');
      const items = [...(list?.shadowRoot?.querySelectorAll('extensions-item') ?? [])];
      return JSON.stringify(items.map((item) => ({
        id: item.id,
        name: item.shadowRoot.querySelector('#name')?.textContent?.trim() ?? '',
      })));
    })()`,
  );
  await closePage(port, targetId);

  const match = JSON.parse(found).find((item) => item.name === name);
  if (!match) throw new Error(`chrome://extensions 中找不到名为 “${name}” 的扩展`);
  return match.id;
}

/**
 * Flip the per-extension "Allow User Scripts" toggle.
 *
 * Chrome 138+ gates `chrome.userScripts` this way, and an unpacked extension
 * starts with it off, so this is a required step rather than a convenience.
 *
 * @param {number} port @param {string} extensionId
 */
export async function allowUserScripts(port, extensionId) {
  const targetId = await openPage(port, `chrome://extensions/?id=${extensionId}`);
  await sleep(1500);
  const state = await evaluate(
    port,
    targetId,
    `(() => {
      const manager = document.querySelector('extensions-manager');
      const view = manager?.shadowRoot?.querySelector('extensions-detail-view');
      const row = view?.shadowRoot?.querySelector('#allow-user-scripts');
      const toggle = row?.shadowRoot?.querySelector('#crToggle');
      if (!toggle) return 'NO_TOGGLE';
      if (!toggle.checked) toggle.click();
      return JSON.stringify({ checked: toggle.checked });
    })()`,
  );
  await closePage(port, targetId);

  if (state === 'NO_TOGGLE') {
    throw new Error('扩展详情页找不到 Allow User Scripts 开关（Chrome 版本可能低于 138）');
  }
  return JSON.parse(state).checked;
}

export { DEBUG_PORT, sleep };
