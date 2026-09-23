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

/**
 * Locations worth trying when BROWSER_EXECUTABLE is not set.
 *
 * Only builds that actually honour `--load-extension` are listed. Edge is
 * deliberately absent even though it is installed on essentially every Windows
 * machine: it ignores the flag, so picking it automatically would start a browser
 * without the extension and surface as a confusing "extension not found" much
 * later. An explicit `--browser` path is always honoured, so Edge can still be
 * passed on purpose.
 */
function browserCandidates() {
  const local = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';

  return [
    process.env.BROWSER_EXECUTABLE,
    join(local, 'chrome-for-testing', 'chrome-win64', 'chrome.exe'),
    join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    join(programFiles, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'),
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

/** Every DevTools HTTP call is bounded by this. */
const HTTP_TIMEOUT_MS = 5000;

/** The WebSocket upgrade to a target is local, so it should be near-instant. */
const HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * A bounded DevTools HTTP request.
 *
 * A port can accept a connection and then never answer — a wedged browser, or an
 * unrelated TCP service. An unbounded `fetch` would await forever, which for this
 * harness means `npm run poc` hangs instead of reporting anything.
 */
function cdpFetch(url, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** Minimal DevTools Protocol client, one socket per target. */
async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    // Bounded handshake. A target that accepts TCP but stalls before the upgrade
    // fires neither `open` nor `error`; the per-command timeout in send() cannot
    // help, because it only starts once this promise has settled. Combined with the
    // POC's own timers, a wedged target would hang the entire run.
    let settled = false;
    const timer = setTimeout(() => {
      // Claim the outcome before closing: closing fires `error` synchronously, and
      // the timeout is the more useful explanation of what happened.
      settled = true;
      try {
        socket.close();
      } catch {
        // already gone
      }
      reject(new Error(`连接 CDP 超时：${webSocketDebuggerUrl}`));
    }, HANDSHAKE_TIMEOUT_MS);

    socket.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法连接 CDP：${webSocketDebuggerUrl}`));
    };
  });

  let nextId = 1;
  const pending = new Map();

  /**
   * Fail every in-flight command.
   *
   * A `send()` whose socket dies first would otherwise never settle, and since the
   * POC keeps HTTP servers and a polling interval alive, one dead target would hang
   * the whole run instead of failing a scenario.
   */
  function failPending(reason) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(reason);
  }

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  };
  socket.onclose = () => failPending(new Error('CDP 连接已关闭'));
  socket.onerror = () => failPending(new Error('CDP 连接出错'));

  return {
    /**
     * @param {string} method
     * @param {object} [params]
     * @param {number} [timeoutMs] A target that stops answering must not hang the run.
     */
    send(method, params = {}, timeoutMs = 10000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      failPending(new Error('CDP 客户端已关闭'));
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
  const response = await cdpFetch(`http://127.0.0.1:${port}/json/list`);
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

/**
 * Open a page and return *that* page's target id.
 *
 * `/json/new` answers with the target it created, so the id is taken from the
 * response rather than re-found by URL. Matching on a URL prefix would happily
 * return an already-open page instead — and because the query string used to be
 * stripped, `chrome://extensions` and `chrome://extensions/?id=…` collapsed into one
 * prefix, so the still-closing overview could be handed back to `allowUserScripts()`
 * in place of the detail view.
 *
 * @param {number} port @param {string} url @param {number} [timeoutMs]
 */
export async function openPage(port, url, timeoutMs = 15000) {
  const response = await cdpFetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  const created = await response.json();
  if (!created?.id) throw new Error(`/json/new 没有返回新标签页：${url}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const target = (await listTargets(port)).find((candidate) => candidate.id === created.id);
    if (target) return created.id;
    await sleep(100);
  }
  throw new Error(`打开页面超时：${url}`);
}

/** @param {number} port @param {string} targetId */
export async function closePage(port, targetId) {
  await cdpFetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
}

/** Ordinary http(s) pages currently open. */
export async function httpPages(port) {
  const targets = await listTargets(port);
  return targets.filter(
    (target) => target.type === 'page' && /^https?:/.test(target.url ?? ''),
  );
}

/**
 * Delete a generated profile, patiently.
 *
 * Windows refuses to remove files that a process still holds open, and Chrome's
 * renderer/GPU children outlive the browser process briefly. Retrying beats both
 * failing a green run over cleanup and leaking a profile per run.
 *
 * @param {string} profile @param {number} [timeoutMs]
 */
async function removeProfile(profile, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(profile, { recursive: true, force: true });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await sleep(200);
    }
  }
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

  // Refuse to reuse a port something else already owns. The readiness probe below
  // only asks "is there a debugging endpoint here?", so an unrelated browser on the
  // same port — the default 9222 makes this easy — would be adopted silently: the
  // POC would then close that session's tabs while cleanup killed a different PID.
  if (await isEndpointAlive(port)) {
    throw new Error(
      `调试端口 ${port} 上已经有另一个浏览器在监听，它不属于本次 POC。` +
        '请用 --port 换一个端口，或先关掉那个浏览器。',
    );
  }

  // Clear anything left by a crashed run. Failing loudly beats handing Chrome a
  // profile another process is still using.
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`无法清理 profile ${profile}（上次的浏览器可能还没退出）：${error.message}`);
  }
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

  // `existsSync` is happy with a directory or a non-executable file, and `spawn`
  // reports those through the `error` event rather than by throwing. With no
  // listener that is an uncaught exception, which would kill the runner before its
  // `finally` could print a summary or clean up the profile.
  try {
    await new Promise((resolve, reject) => {
      child.once('error', (error) => reject(new Error(`无法启动浏览器 ${exe}：${error.message}`)));
      child.once('spawn', resolve);
    });
  } catch (error) {
    // Nothing was started, so the profile this call created is the only thing to undo.
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }

  const deadline = Date.now() + 45000;
  let lastVersionError = null;
  let refusedAfterExit = 0;
  while (Date.now() < deadline) {
    let version = null;
    try {
      const response = await cdpFetch(`http://127.0.0.1:${port}/json/version`, {}, 2000);
      version = await response.json();
    } catch (error) {
      version = null; // not up yet, or not answering
      lastVersionError = error;
    }

    if (version) return { port, profile, pid: child.pid, browser: version.Browser, stop };

    // The spawned process exiting is *not* by itself a startup failure: on Windows
    // this Chrome hands the session to another process and the launcher exits with
    // code 0 while the endpoint is still coming up. Treating that as "port did not
    // open" fails a healthy start, so an exit is only a hint.
    //
    // A *refused* connection alongside a dead launcher is different: nothing is
    // listening and nothing is coming, so waiting out the full deadline would report
    // a generic timeout instead of the exit code that explains it.
    if (child.exitCode !== null && isConnectionRefused(lastVersionError)) {
      refusedAfterExit += 1;
      if (refusedAfterExit >= 4) {
        await removeProfile(profile);
        throw new Error(
          `浏览器进程已退出（退出码 ${child.exitCode}），调试端口 ${port} 没有打开。`,
        );
      }
    } else {
      refusedAfterExit = 0;
    }

    await sleep(250);
  }

  // Nothing answered in time. The child is detached and was never returned to the
  // caller, so the caller's cleanup cannot reach it: it has to die here.
  await killChild();
  await removeProfile(profile);
  const reason = child.exitCode === null ? '没有出现端点' : `进程已退出（退出码 ${child.exitCode}）`;
  throw new Error(
    `浏览器调试端口 ${port} 在 45s 内没有就绪（${reason}）` +
      (lastVersionError ? `：${lastVersionError.message}` : ''),
  );

  /**
   * Signal the browser and wait for it to actually be gone.
   *
   * Signalling alone is not enough on Windows: the profile stays locked until every
   * process holding it has exited, so an immediate rerun could not clear it.
   */
  async function killChild(timeoutMs = 10000) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      process.kill(child.pid);
    } catch {
      // already gone
    }
    await Promise.race([exited, sleep(timeoutMs)]);
  }

  /**
   * Kill the browser and drop its generated profile.
   *
   * Without this the POC leaves a full Chrome profile behind on every successful
   * run — one per `--port`, tens of megabytes each.
   *
   * Closing is asked for through CDP as well as signalled. The spawned process may
   * already have exited (see `launchBrowser`), in which case the signal reaches
   * nothing while the browser that owns the port is still running and still holds
   * the profile — the POC would then never be able to clean up or rerun.
   */
  async function stop() {
    await closeThroughCdp(port);
    await killChild();
    const removed = await removeProfile(profile);
    if (!removed) {
      // A profile still locked here means the browser is alive; report it instead of
      // letting the next run fail on a leftover profile with no explanation.
      console.warn(`[poc] 无法删除 profile ${profile}（浏览器可能仍在运行）`);
    }
    return removed;
  }
}

/**
 * Is something already serving DevTools on this port?
 *
 * Deliberately fail-closed: a request that times out means the port accepted a
 * connection without ever answering. That is still "not ours", and refusing is far
 * better than spawning a browser we then cannot distinguish from whatever is there.
 *
 * @param {number} port
 */
async function isEndpointAlive(port) {
  try {
    await cdpFetch(`http://127.0.0.1:${port}/json/version`, {}, 1500);
    return true;
  } catch (error) {
    return error?.name === 'TimeoutError';
  }
}

/**
 * Did the runtime refuse the connection outright, as opposed to never answering?
 *
 * `fetch` reports both as a `TypeError`, so the distinguishing detail is in the
 * cause: a refused socket means nothing is listening, while a timeout means
 * something accepted the connection and stayed silent.
 *
 * @param {unknown} error
 */
function isConnectionRefused(error) {
  if (error?.name === 'TimeoutError') return false;
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = current.code ?? current.errno;
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return true;
    if (current.name === 'TimeoutError') return false;
    current = current.cause;
  }
  return false;
}

/**
 * Ask the browser on `port` to shut itself down, over the browser-level CDP target.
 *
 * Best-effort: an unreachable or already-gone browser is not an error, because the
 * caller signals the spawned process as well.
 *
 * @param {number} port
 */
async function closeThroughCdp(port, timeoutMs = 5000) {
  let client = null;
  try {
    const response = await cdpFetch(`http://127.0.0.1:${port}/json/version`, {}, 1500);
    const version = await response.json();
    if (!version?.webSocketDebuggerUrl) return false;
    client = await connect(version.webSocketDebuggerUrl);
    await client.send('Browser.close', {}, timeoutMs);
    return true;
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

/** @param {number} port @param {string} name @param {number} [timeoutMs] */export async function findExtensionId(port, name, timeoutMs = 15000) {
  let targetId;
  try {
    targetId = await openPage(port, 'chrome://extensions');
  } catch (error) {
    // The usual cause is a browser that ignores `--load-extension`: it starts
    // happily, so the failure only shows up here, as a page that never opens.
    throw new Error(
      `${error.message}。若这里用的是品牌版 Chrome 142+ 或 Edge，它们会忽略 --load-extension，` +
        '扩展从未被加载；请改用 Chrome for Testing。',
    );
  }

  try {
    // Poll instead of sleeping a fixed amount: the target exists as soon as the page
    // is created, but the shadow-DOM list fills in later, and how much later depends
    // on the machine. A fixed delay turns a slow start into "extension not loaded".
    const deadline = Date.now() + timeoutMs;
    for (;;) {
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

      const items = JSON.parse(found);
      const match = items.find((item) => item.name === name);
      if (match) return match.id;
      if (Date.now() >= deadline) {
        const listed = items.map((item) => item.name).filter(Boolean);
        throw new Error(
          `chrome://extensions 中找不到名为 “${name}” 的扩展` +
            `（已列出：${listed.length > 0 ? listed.join('、') : '空'}）`,
        );
      }
      await sleep(200);
    }
  } finally {
    await closePage(port, targetId);
  }
}

/**
 * Flip the per-extension "Allow User Scripts" toggle.
 *
 * Chrome 138+ gates `chrome.userScripts` this way, and an unpacked extension
 * starts with it off, so this is a required step rather than a convenience.
 *
 * @param {number} port @param {string} extensionId @param {number} [timeoutMs]
 */
export async function allowUserScripts(port, extensionId, timeoutMs = 15000) {
  const targetId = await openPage(port, `chrome://extensions/?id=${extensionId}`);

  try {
    // Same reasoning as findExtensionId: the detail view is built after the target
    // appears, so waiting a fixed 1.5s can read an empty shadow DOM and conclude the
    // toggle does not exist.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
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

      if (state !== 'NO_TOGGLE') return JSON.parse(state).checked;
      if (Date.now() >= deadline) {
        throw new Error('扩展详情页找不到 Allow User Scripts 开关（Chrome 版本可能低于 138）');
      }
      await sleep(200);
    }
  } finally {
    await closePage(port, targetId);
  }
}

export { DEBUG_PORT, sleep };
