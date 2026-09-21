import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `tests/poc/service.mjs` is both a module and a command line tool, and the README
 * tells the reader to run it by hand. These tests guard the two ways that can rot:
 * the entry point disappearing (the README then documents a command that exits
 * immediately) and the entry point firing on import (which would break every test
 * that imports `startTestService`).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(HERE, 'poc', 'service.mjs');

/** @param {string[]} args @param {string} [input] */
function run(args, input, timeoutMs = 20000) {
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

  const { code, stdout, stderr } = await run(['-e', script]);

  assert.equal(code, 0, stderr);
  assert.match(stdout, /EXPORTED function/);
  // A CLI that also ran would have printed its banner before exiting.
  assert.doesNotMatch(stdout, /endpoint/);
});

test('README 里的 --interactive 命令真的能发消息并退出', async () => {
  const { code, stdout } = await run(
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
