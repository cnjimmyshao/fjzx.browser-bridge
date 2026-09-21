/**
 * Zero-dependency browser launcher and CDP client for the POC.
 *
 * The repository ships no build step, no bundler and no third-party runtime
 * dependency, so the POC drives Chrome with nothing but `node:child_process`,
 * Node's global `WebSocket` and the DevTools Protocol. The launch shape follows
 * the harness already used elsewhere in this project family (a disposable
 * profile, `--remote-debugging-port=0`, `<profile>/DevToolsActivePort` for the
 * port, a `Runtime.evaluate` bridge into the extension service worker).
 *
 * Two details are load-bearing:
 *
 * - **Chrome for Testing is required.** Chrome 137+ branded builds ignore
 *   `--load-extension`; `--disable-features=DisableLoadExtensionCommandLineSwitch`
 *   is passed as well so a Chromium build that gates the switch still honours it.
 * - **`Runtime.runIfWaitingForDebugger`** is sent after attaching to the extension
 *   worker: the worker may be parked waiting for a debugger, and without this the
 *   evaluate would never run.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Chrome for Testing installs live in per-version directories under the home. */
function chromeForTestingCandidates() {
  const roots = [path.join(homedir(), 'chrome'), path.join(homedir(), '.cache', 'chrome-for-testing')];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const versions = readdirSync(root)
      .filter((name) => /^(win|mac|linux)/.test(name))
      .sort()
      .reverse();
    for (const version of versions) {
      candidates.push(
        path.join(root, version, 'chrome-win64', 'chrome.exe'),
        path.join(root, version, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
        path.join(root, version, 'chrome-linux64', 'chrome'),
      );
    }
  }
  return candidates;
}

/** First browser that exists, with Chrome for Testing deliberately ahead of branded Chrome. */
export function findBrowser(explicit) {
  const candidates =
    process.platform === 'win32'
      ? [
          explicit,
          process.env.CHROMIUM_EXECUTABLE,
          ...chromeForTestingCandidates(),
          `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            explicit,
            process.env.CHROMIUM_EXECUTABLE,
            ...chromeForTestingCandidates(),
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            explicit,
            process.env.CHROMIUM_EXECUTABLE,
            ...chromeForTestingCandidates(),
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
          ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    '没有找到可用的 Chrome for Testing / Chromium；用 CHROMIUM_EXECUTABLE=<路径> 指定（Chrome 137+ 品牌版会忽略 --load-extension）。',
  );
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Set();
    let sequence = 0;

    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket is not an error worth reporting.
      }
      reject(new Error(`CDP 连接超时：${wsUrl}`));
    }, 10000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        on(listener) {
          listeners.add(listener);
        },
        send(method, params = {}, sessionId) {
          const id = ++sequence;
          return new Promise((resolveCall, rejectCall) => {
            const timeout = setTimeout(() => {
              pending.delete(id);
              rejectCall(new Error(`CDP 调用超时：${method}`));
            }, 20000);
            pending.set(id, {
              ok: (value) => {
                clearTimeout(timeout);
                resolveCall(value);
              },
              no: (error) => {
                clearTimeout(timeout);
                rejectCall(error);
              },
            });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
      });
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket 出错：${wsUrl}`));
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.error) call.no(new Error(`${message.error.message}${message.error.data ? ` — ${message.error.data}` : ''}`));
        else call.ok(message.result);
        return;
      }
      for (const listener of listeners) {
        try {
          listener(message);
        } catch {
          // A listener must never break the protocol loop.
        }
      }
    });

    socket.addEventListener('close', () => {
      for (const call of pending.values()) call.no(new Error('CDP 连接已关闭'));
      pending.clear();
    });
  });
}

/**
 * @param {{
 *   extensionDir: string,
 *   profileDir: string,
 *   executablePath?: string,
 *   headless?: boolean,
 * }} options
 */
export async function launchBrowser({ extensionDir, profileDir, executablePath, headless = true }) {
  const exe = findBrowser(executablePath);
  const child = spawn(
    exe,
    [
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--use-mock-keychain',
      // Chrome 137+ reduces the switch to a no-op unless this feature is off.
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      // Lets CDP attach to extension targets (and to their service workers) the
      // way the project's other browser harnesses do.
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      ...(headless ? ['--headless=new'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let client;
  try {
    let advertised;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        advertised = (await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(`浏览器进程提前退出（exit ${child.exitCode}）`);
        await sleep(100);
      }
    }
    if (!advertised) throw new Error('浏览器没有暴露 DevTools 端口（DevToolsActivePort 未出现）。');

    client = await connect(`ws://127.0.0.1:${advertised[0]}${advertised[1]}`);

    /**
     * One session per target, plus the execution contexts that session reports.
     *
     * A target can expose more than one execution context, and `Runtime.evaluate`
     * without an explicit `contextId` resolves against whichever one the session
     * currently considers default — for an extension service worker that is not
     * reliably the worker's own global (observed: an evaluate landed in a context
     * where `chrome` existed but had no `storage`). The POC therefore tracks the
     * contexts each session reports and always names the default one.
     */
    const sessions = new Map();

    async function targets() {
      const { targetInfos } = await client.send('Target.getTargets');
      return targetInfos;
    }

    client.on((message) => {
      if (!message.sessionId) return;
      for (const record of sessions.values()) {
        if (record.sessionId !== message.sessionId) continue;
        if (message.method === 'Runtime.executionContextCreated') {
          record.contexts.push(message.params.context);
        } else if (message.method === 'Runtime.executionContextsCleared') {
          record.contexts = [];
        }
      }
    });

    /** Attach to a target once, enabling Runtime so its contexts are reported. */
    async function attach(targetId) {
      const existing = sessions.get(targetId);
      if (existing !== undefined) return existing.sessionId;
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
      const record = { sessionId, contexts: [] };
      sessions.set(targetId, record);
      await client.send('Runtime.enable', {}, sessionId);
      return sessionId;
    }

    function defaultContextId(record) {
      const context =
        record.contexts.find((candidate) => candidate.auxData?.isDefault === true) ?? record.contexts[0];
      return context === undefined ? null : context.id;
    }

    async function waitForContext(targetId, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const record = sessions.get(targetId);
        const contextId = record === undefined ? null : defaultContextId(record);
        if (contextId !== null) return contextId;
        await sleep(50);
      }
      return null;
    }

    async function evaluateInTarget(targetId, expression) {
      const sessionId = await attach(targetId);
      const contextId = await waitForContext(targetId);
      const evaluateOnce = (target, context) =>
        client.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true, ...(context === null ? {} : { contextId: context }) },
          target,
        );

      let result;
      try {
        result = await evaluateOnce(sessionId, contextId);
      } catch (error) {
        // A worker that restarted invalidates its context id; re-resolve once.
        if (!/context/i.test(error.message)) throw error;
        sessions.delete(targetId);
        const retrySession = await attach(targetId);
        result = await evaluateOnce(retrySession, await waitForContext(targetId));
      }

      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '求值失败',
        );
      }
      return result.result?.value;
    }

    /** Evaluate a function in a target's default context and return its value. */
    async function evaluate(targetId, fn, arg) {
      return evaluateInTarget(targetId, `(${fn.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)})`);
    }

    /** Evaluate a raw expression (used where a function literal is awkward). */
    async function evaluateExpression(targetId, expression) {
      return evaluateInTarget(targetId, expression);
    }

    async function waitForExtensionWorker(timeoutMs = 30000) {
      // A Chrome for Testing profile ships component extensions whose workers are
      // also `chrome-extension://…/background.js` (observed: a built-in
      // "google.com" extension). Matching on the URL alone attaches to the wrong
      // extension, so the worker is identified by its manifest name instead.
      const expectedName = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')).name;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const candidates = (await targets()).filter(
          (target) => target.type === 'service_worker' && target.url.startsWith('chrome-extension://'),
        );
        for (const candidate of candidates) {
          try {
            const sessionId = await attach(candidate.targetId);
            // The worker may be parked waiting for a debugger.
            await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
            await waitForContext(candidate.targetId, 5000);
            const name = await evaluateExpression(candidate.targetId, 'chrome.runtime.getManifest().name');
            if (name === expectedName) return candidate;
          } catch {
            // Not our extension, or not ready yet: try the next candidate.
          }
        }
        await sleep(200);
      }
      throw new Error(`扩展 ${expectedName} 的 service worker 没有启动（--load-extension 是否被忽略？）。`);
    }

    async function newPage(url) {
      const { targetId } = await client.send('Target.createTarget', { url });
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const found = (await targets()).find((target) => target.targetId === targetId);
        if (found && found.url !== '' && found.url !== 'about:blank') return { targetId, url: found.url };
        await sleep(100);
      }
      return { targetId, url };
    }

    async function waitForLoad(targetId, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const state = await evaluateExpression(targetId, 'document.readyState').catch(() => null);
        if (state === 'complete') return true;
        await sleep(100);
      }
      return false;
    }

    /** Override the user agent for one page only (device emulation). */
    async function setUserAgentOverride(targetId, userAgent) {
      const sessionId = await attach(targetId);
      await client.send('Network.setUserAgentOverride', { userAgent }, sessionId);
    }

    async function close() {
      await client.send('Browser.close').catch(() => {});
      try {
        client.socket.close();
      } catch {
        // Already closed.
      }
      if (child.exitCode === null) {
        await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
        if (child.exitCode === null) child.kill();
      }
    }

    return {
      executable: exe,
      headless,
      client,
      targets,
      evaluate,
      evaluateExpression,
      waitForExtensionWorker,
      newPage,
      waitForLoad,
      setUserAgentOverride,
      close,
    };
  } catch (error) {
    client?.socket.close();
    if (child.exitCode === null) child.kill();
    throw error;
  }
}
