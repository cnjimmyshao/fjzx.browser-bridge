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
  // `storage` is all V1.1 requires: the single Service URL. Any later issue that
  // genuinely needs another permission must update this list deliberately, so
  // permission creep shows up as a reviewed diff instead of slipping in.
  assert.deepEqual(manifest.permissions, ['storage']);
});

test('no host permissions are requested', () => {
  // Bridge is site-agnostic: it never declares which sites it may touch.
  for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions']) {
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

test('declares an options page that exists inside the extension root', () => {
  assert.equal(typeof manifest.options_ui?.page, 'string');
  const page = manifest.options_ui.page;
  assert.equal(page.includes('..'), false, 'options page 不得逃出扩展根目录');
  assert.equal(existsSync(join(extensionRoot, page)), true, `缺少 ${page}`);
});
