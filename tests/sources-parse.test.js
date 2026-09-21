import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const extensionRoot = join(repoRoot, 'src');
const testsRoot = join(repoRoot, 'tests');

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const relative = (file) => file.slice(repoRoot.length + 1);

/** Everything the extension ships, plus the harnesses that exercise it. */
const scriptFiles = () =>
  [...listFiles(extensionRoot), ...listFiles(testsRoot)].filter(
    (file) => file.endsWith('.js') || file.endsWith('.mjs'),
  );

/**
 * The service worker is the one source file the suite cannot import — it reads
 * `chrome.*` at module scope — and a syntax error there does not fail any unit
 * test: it silently stops the worker from ever starting, so the extension loads
 * cleanly and simply does nothing. Parsing every file closes that gap, and it
 * covers the harnesses too: the POC runner is not imported by `node --test`
 * either, so nothing else would notice it breaking.
 *
 * `stdio: 'inherit'` keeps the child's own SyntaxError visible in the test output
 * (piped stdio is not usable in this sandbox).
 */
test('every script in the repository parses', () => {
  const sources = scriptFiles();
  assert.ok(sources.length > 0, '源码不应为空');

  const offenders = [];
  for (const file of sources) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    } catch {
      offenders.push(relative(file));
    }
  }

  assert.deepEqual(offenders, [], `以下文件存在语法错误：${offenders.join(', ')}`);
});

test('the guard covers the files that no other test would notice breaking', () => {
  const sources = scriptFiles().map(relative);
  for (const required of [
    join('src', 'background', 'service-worker.js'),
    join('tests', 'poc', 'run-poc.mjs'),
  ]) {
    assert.ok(sources.includes(required), `守卫必须覆盖 ${required}`);
  }
});

/**
 * `readFileSync(file, 'utf8')` silently replaces invalid bytes, so a file mangled
 * by an editor or a script keeps working while the bytes on disk are wrong — it
 * only shows up as a stray replacement character in a comment. `fatal: true`
 * turns that into a failure instead.
 */
test('every text file in the repository is valid UTF-8', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const offenders = [];

  for (const file of [...listFiles(extensionRoot), ...listFiles(testsRoot)]) {
    try {
      decoder.decode(readFileSync(file));
    } catch {
      offenders.push(relative(file));
    }
  }

  assert.deepEqual(offenders, [], `以下文件不是合法 UTF-8：${offenders.join(', ')}`);
});

/**
 * A byte-order mark is valid UTF-8, so the check above cannot see it — but on a
 * file that starts with `#!` it turns the shebang into a syntax error, which is
 * exactly how the POC runner was broken once by writing it through a tool that
 * adds one. Nothing in this project needs a BOM.
 */
test('no file starts with a byte-order mark', () => {
  const offenders = [];
  for (const file of [...listFiles(extensionRoot), ...listFiles(testsRoot)]) {
    const [first, second, third] = readFileSync(file);
    if (first === 0xef && second === 0xbb && third === 0xbf) offenders.push(relative(file));
  }
  assert.deepEqual(offenders, [], `以下文件带 BOM：${offenders.join(', ')}`);
});

/**
 * The architecture forbids evaluating Service code inside the extension worker:
 * it runs in the Work Tab's USER_SCRIPT world through the userScripts API, or it
 * does not run at all. `eval` or `new Function` in the shipped extension would
 * mean Service code executing with the extension's own privileges, which is
 * exactly what the design is arranged to avoid.
 */
test('no shipped source evaluates Service code inside the extension', () => {
  const forbidden = [
    [/\beval\s*\(/, 'eval('],
    [/new\s+Function\s*\(/, 'new Function('],
    [/Function\s*\(\s*['"`]/, 'Function("...")'],
  ];
  const offenders = [];

  for (const file of listFiles(extensionRoot)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      if (pattern.test(text)) offenders.push(`${relative(file)}: ${label}`);
    }
  }

  assert.deepEqual(offenders, [], `发现动态求值：\n${offenders.join('\n')}`);
});
