import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `src/` is the extension root: Chrome loads this directory directly, so no
 * build step is required and `tests/`, `docs/` and `package.json` stay out of
 * the shipped extension.
 */
const extensionRoot = join(import.meta.dirname, '..', 'src');
const manifestPath = join(extensionRoot, 'manifest.json');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

test('manifest is valid JSON and declares Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('permissions stay at the minimum V1 needs', () => {
  // Every addition must be deliberate, so permission creep shows up as a reviewed
  // diff instead of slipping in:
  //   storage     — the single Service URL (V1.1)
  //   tabs        — `tab.url` and `changeInfo.url` (V1.3). Host permissions cover
  //                 http(s) but cannot cover `chrome://`, so without `tabs` a Work
  //                 Tab navigating to a browser page goes unnoticed and keeps being
  //                 reported as bound (verified).
  //   userScripts — running Service JavaScript at all (V1.5)
  //   scripting   — the Work Tab's own page facts (issue #25): its user agent and
  //                 `document.referrer`. Verified: a page-level user agent override
  //                 is visible there and *not* in the service worker, so the worker
  //                 cannot answer instead.
  //   cookies     — the request context (issue #25): what the browser itself holds
  //                 for one explicit target URL. `cookies` adds no warning text of
  //                 its own, and the disclosed set is limited to `getAll({url})`;
  //                 there is no `getAll({})` or `getAll({domain})` anywhere.
  assert.deepEqual(manifest.permissions, [
    'storage',
    'tabs',
    'userScripts',
    'scripting',
    'cookies',
  ]);
});

test('the only host permission is <all_urls>, which names no site', () => {
  // chrome.userScripts.execute() refuses to touch a tab the extension holds no
  // host permission for (verified), so host access is part of V1's execution
  // mechanism rather than an optional extra. <all_urls> names no site, which is
  // what keeps Bridge site-agnostic: every site is treated identically and no
  // platform knowledge is encoded anywhere in the manifest.
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  for (const pattern of manifest.host_permissions) {
    assert.match(pattern, /[*<]/, `${pattern} 不应是具体站点`);
  }
});

test('no optional permissions are requested', () => {
  for (const key of ['optional_host_permissions', 'optional_permissions']) {
    assert.equal(key in manifest, false, `manifest 不得包含 ${key}`);
  }
});

test('no content scripts are declared', () => {
  // Architecture invariant: Service JavaScript runs through the userScripts API
  // in the USER_SCRIPT world, never as a declared content script.
  assert.equal('content_scripts' in manifest, false);
});

test('identifies the extension without platform semantics', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.notEqual(manifest.name.trim(), '');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, 'string');
  assert.notEqual(manifest.description.trim(), '');
});

test('description stays within the documented 132-character limit', () => {
  // Counted by code point rather than UTF-16 unit so the assertion holds if the
  // description ever picks up non-BMP characters.
  const length = [...manifest.description].length;
  assert.ok(length <= 132, `description 为 ${length} 字符，超过 Chrome 文档的 132 上限`);
});

test('declares an options page that exists inside the extension root', () => {
  assert.equal(typeof manifest.options_ui?.page, 'string');
  const page = manifest.options_ui.page;
  assert.equal(page.includes('..'), false, 'options page 不得逃出扩展根目录');
  assert.equal(existsSync(join(extensionRoot, page)), true, `缺少 ${page}`);
});
