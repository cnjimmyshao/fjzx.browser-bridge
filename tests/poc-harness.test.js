import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { launchBrowser } from './poc/browser.mjs';

/**
 * Guards on the POC harness itself.
 *
 * The harness is not shipped, but a broken harness is worse than no harness: it
 * either reports a failure that is its own fault, or hangs. The failure modes below
 * were all found in review, and all of them are the kind a happy-path run never
 * exercises.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, 'poc', 'service.mjs');

/** @param {string[]} args @param {string} [input] */
function runNode(args, input, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`子进程超时未退出。stdout: ${stdout} stderr: ${stderr}`));
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(input ?? '');
  });
}

test('导入 service.mjs 不会启动 CLI（main 判定必须生效）', async () => {
  const script = [
    `import(${JSON.stringify(pathToFileURL(SERVICE).href)}).then((module) => {`,
    "  console.log('EXPORTED', typeof module.startTestService);",
    '  process.exit(0);',
    '});',
  ].join('\n');

  const { code, stdout, stderr } = await runNode(['-e', script]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /EXPORTED function/);
  // A CLI that also ran would have printed its banner before exiting.
  assert.doesNotMatch(stdout, /endpoint/);
});

test('README 里的 --interactive 命令真的能发消息并退出', async () => {
  const { code, stdout } = await runNode(
    [SERVICE, '--interactive', '--port', '0'],
    [':status', 'return document.title', ':input {"n":21}', 'return input.n * 2', ':quit'].join(
      '\n',
    ) + '\n',
  );

  assert.equal(code, 0);
  assert.match(stdout, /endpoint {2}ws:\/\/127\.0\.0\.1:\d+/);
  assert.match(stdout, /→ \{"type":"GET_STATUS"\}/);
  assert.match(stdout, /→ \{"type":"EXECUTE","jobId":"manual-1","script":"return document\.title"\}/);
  // `:input` must attach to later EXECUTEs, not to the one before it.
  assert.match(
    stdout,
    /→ \{"type":"EXECUTE","jobId":"manual-2","script":"return input\.n \* 2","input":\{"n":21\}\}/,
  );
});

test('waitForBridge 超时后不会留下让进程无法退出的轮询循环', async () => {
  // The real symptom is "npm run poc never exits", so the test has to observe the
  // process exiting on its own: the child deliberately does not call process.exit().
  const script = [
    `import { startTestService } from ${JSON.stringify(pathToFileURL(SERVICE).href)};`,
    'const service = await startTestService();',
    'try {',
    '  await service.waitForBridge(300);',
    "  console.log('UNEXPECTED');",
    '} catch (error) {',
    "  console.log('TIMEOUT', error.message);",
    '}',
    'await service.stop();',
    "console.log('DONE');",
  ].join('\n');

  const { code, stdout } = await runNode(['--input-type=module', '-e', script], '', 10000);

  assert.equal(code, 0);
  assert.match(stdout, /TIMEOUT/);
  assert.match(stdout, /DONE/);
});

test('调试端口已被占用时拒绝启动，且不碰 profile', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ Browser: 'Chrome/someone-else' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const profile = join(tmpdir(), `bridge-poc-refused-${port}`);

  try {
    await assert.rejects(
      launchBrowser({
        exe: process.execPath,
        extensionPath: 'unused',
        port,
        profile,
      }),
      /已经有另一个浏览器/,
    );
    assert.equal(existsSync(profile), false, '拒绝时不应创建 profile');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
