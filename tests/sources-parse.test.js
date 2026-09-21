import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const extensionRoot = join(import.meta.dirname, '..', 'src');

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

/**
 * The service worker is the one source file the suite cannot import — it reads
 * `chrome.*` at module scope — and a syntax error there does not fail any unit
 * test: it silently stops the worker from ever starting, so the extension loads
 * cleanly and simply does nothing. Parsing every file closes that gap.
 *
 * `stdio: 'inherit'` keeps the child's own SyntaxError visible in the test output
 * (piped stdio is not usable in this sandbox).
 */
test('every extension source file parses', () => {
  const sources = listFiles(extensionRoot).filter((file) => file.endsWith('.js'));
  assert.ok(sources.length > 0, '扩展源码不应为空');

  const offenders = [];
  for (const file of sources) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    } catch {
      offenders.push(file.slice(extensionRoot.length + 1));
    }
  }

  assert.deepEqual(offenders, [], `以下文件存在语法错误：${offenders.join(', ')}`);
});

test('the service worker is among the files guarded', () => {
  const sources = listFiles(extensionRoot).map((file) => file.slice(extensionRoot.length + 1));
  assert.ok(
    sources.includes(join('background', 'service-worker.js')),
    '守卫必须覆盖 service worker',
  );
});
