import test from 'node:test';
import assert from 'node:assert/strict';

import { createSettingsStore } from '../src/lib/settings-store.js';
import { SERVICE_URL_STORAGE_KEY } from '../src/lib/service-url.js';

/** Minimal in-memory stand-in for a `chrome.storage.StorageArea`. */
function createFakeStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    setCalls: [],
    async get(key) {
      if (typeof key !== 'string') {
        throw new Error('fake storage 只支持字符串 key');
      }
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items) {
      this.setCalls.push({ ...items });
      Object.assign(data, items);
    },
  };
}

test('rejects a storage area that cannot get/set', () => {
  for (const bad of [undefined, null, {}, { get: () => {} }, { set: () => {} }]) {
    assert.throws(() => createSettingsStore(bad), TypeError);
  }
});

test('an unconfigured profile reads as empty and stays unwritten', async () => {
  const area = createFakeStorageArea();
  const store = createSettingsStore(area);

  assert.equal(await store.readServiceUrl(), '');
  assert.deepEqual(area.setCalls, [], '读取不得写入隐式默认 URL');
  assert.deepEqual(area.data, {});
});

test('saves, reads back and overwrites the Service URL', async () => {
  const area = createFakeStorageArea();
  const store = createSettingsStore(area);

  assert.deepEqual(await store.saveServiceUrl('ws://127.0.0.1:8080'), {
    ok: true,
    value: 'ws://127.0.0.1:8080',
  });
  assert.equal(await store.readServiceUrl(), 'ws://127.0.0.1:8080');

  await store.saveServiceUrl('wss://service.example/bridge');
  assert.equal(await store.readServiceUrl(), 'wss://service.example/bridge');
});

test('round-trips through the raw storage value a fresh profile would hold', async () => {
  const area = createFakeStorageArea({ [SERVICE_URL_STORAGE_KEY]: 'ws://127.0.0.1:8080' });
  const store = createSettingsStore(area);
  assert.equal(await store.readServiceUrl(), 'ws://127.0.0.1:8080');
});

test('an invalid save is rejected and writes nothing', async () => {
  const area = createFakeStorageArea();
  const store = createSettingsStore(area);

  const result = await store.saveServiceUrl('http://127.0.0.1:8080');
  assert.equal(result.ok, false);
  assert.deepEqual(area.setCalls, []);
  assert.deepEqual(area.data, {});
});

test('an empty value explicitly clears the configuration', async () => {
  const area = createFakeStorageArea({ [SERVICE_URL_STORAGE_KEY]: 'ws://127.0.0.1:8080' });
  const store = createSettingsStore(area);

  assert.deepEqual(await store.saveServiceUrl(''), { ok: true, value: '' });
  assert.equal(await store.readServiceUrl(), '');
});

test('a corrupted stored value reads as not configured instead of surfacing', async () => {
  const area = createFakeStorageArea({ [SERVICE_URL_STORAGE_KEY]: 'http://127.0.0.1:8080' });
  const store = createSettingsStore(area);
  assert.equal(await store.readServiceUrl(), '');
});

test('serviceUrl is the only key ever written', async () => {
  const area = createFakeStorageArea();
  const store = createSettingsStore(area);

  await store.saveServiceUrl('ws://127.0.0.1:8080');
  await store.saveServiceUrl('ws://127.0.0.1:8081');
  await store.saveServiceUrl('');

  assert.deepEqual(Object.keys(area.data), [SERVICE_URL_STORAGE_KEY]);
  for (const call of area.setCalls) {
    assert.deepEqual(Object.keys(call), [SERVICE_URL_STORAGE_KEY]);
  }
});
