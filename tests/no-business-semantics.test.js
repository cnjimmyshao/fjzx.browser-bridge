import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const extensionRoot = join(import.meta.dirname, '..', 'src');

/**
 * Terms that belong to a platform Service, never to the Bridge. Bridge only
 * carries JavaScript and technical state, so none of these may appear anywhere
 * in extension source.
 */
const FORBIDDEN_TERMS = [
  // platform names
  'douyin',
  'bilibili',
  'baidu',
  'xiaohongshu',
  'kuaishou',
  'toutiao',
  'weibo',
  // website business states the Service must interpret instead
  'captcha',
  'blocked',
  'login_required',
  'risk_control',
  '验证码',
  '风控',
];

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

test('extension source contains no platform or business-semantics terms', () => {
  const files = listFiles(extensionRoot);
  assert.ok(files.length > 0, '扩展源码不应为空');

  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const term of FORBIDDEN_TERMS) {
      if (text.includes(term.toLowerCase())) {
        offenders.push(`${file.slice(extensionRoot.length + 1)}: ${term}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `发现业务语义：\n${offenders.join('\n')}`);
});
