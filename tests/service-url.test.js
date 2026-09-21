import test from 'node:test';
import assert from 'node:assert/strict';

import { SERVICE_URL_STORAGE_KEY, validateServiceUrl } from '../src/lib/service-url.js';

test('storage key is exactly the single documented V1 key', () => {
  assert.equal(SERVICE_URL_STORAGE_KEY, 'serviceUrl');
});

test('empty inputs are the explicit "not configured" state, not an error', () => {
  for (const raw of [null, undefined, '', '   ', '\t\n']) {
    assert.deepEqual(validateServiceUrl(raw), { ok: true, value: '' });
  }
});

test('accepts ws: and wss: URLs and trims surrounding whitespace', () => {
  assert.deepEqual(validateServiceUrl('ws://127.0.0.1:8080'), {
    ok: true,
    value: 'ws://127.0.0.1:8080',
  });
  assert.deepEqual(validateServiceUrl('  ws://127.0.0.1:8080  '), {
    ok: true,
    value: 'ws://127.0.0.1:8080',
  });
  assert.deepEqual(validateServiceUrl('wss://service.example/bridge'), {
    ok: true,
    value: 'wss://service.example/bridge',
  });
});

test('accepts a non-local Service URL: V1 does not restrict the host', () => {
  const result = validateServiceUrl('ws://10.0.0.5:9000/path?token=1');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'ws://10.0.0.5:9000/path?token=1');
});

test('rejects non-WebSocket protocols', () => {
  for (const raw of ['http://127.0.0.1:8080', 'https://service.example', 'ftp://host/x']) {
    const result = validateServiceUrl(raw);
    assert.equal(result.ok, false, `${raw} 应被拒绝`);
    assert.match(result.error, /ws: 或 wss:/);
  }
});

test('rejects input that is missing a ws/wss scheme', () => {
  for (const raw of ['127.0.0.1:8080', 'localhost:8080', 'service.example/bridge', 'not a url']) {
    const result = validateServiceUrl(raw);
    assert.equal(result.ok, false, `${raw} 应被拒绝`);
    assert.equal(typeof result.error, 'string');
    assert.notEqual(result.error, '');
  }
});

test('rejects non-string input', () => {
  for (const raw of [42, true, {}, [], () => {}]) {
    const result = validateServiceUrl(raw);
    assert.equal(result.ok, false);
    assert.match(result.error, /字符串/);
  }
});
