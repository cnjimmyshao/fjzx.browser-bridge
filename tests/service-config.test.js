import test from 'node:test';
import assert from 'node:assert/strict';

import { createServiceConfigSync } from '../src/lib/service-config.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRecorder(logger = {}) {
  const applied = [];
  return { applied, applyServiceUrl: (serviceUrl) => applied.push(serviceUrl), logger };
}

test('requires both collaborators', () => {
  assert.throws(() => createServiceConfigSync({}), TypeError);
  assert.throws(() => createServiceConfigSync({ readServiceUrl: () => {} }), TypeError);
  assert.throws(() => createServiceConfigSync({ applyServiceUrl: () => {} }), TypeError);
});

test('sync applies the persisted Service URL', async () => {
  const recorder = createRecorder();
  const sync = createServiceConfigSync({
    readServiceUrl: async () => 'ws://stored',
    ...recorder,
  });

  await sync.sync('worker-start');

  assert.deepEqual(recorder.applied, ['ws://stored']);
});

test('a storage change that lands while a read is pending wins', async () => {
  const read = createDeferred();
  const recorder = createRecorder();
  const sync = createServiceConfigSync({
    readServiceUrl: () => read.promise,
    ...recorder,
  });

  const inFlight = sync.sync('worker-start'); // the read is still pending
  sync.applyStorageChange('ws://new'); // the operator saves meanwhile
  read.resolve('ws://old'); // the pre-save read finally resolves
  await inFlight;

  assert.deepEqual(
    recorder.applied,
    ['ws://new'],
    '陈旧的读取不得把连接退回旧端点',
  );
});

test('a storage change is applied immediately, without waiting for a read', () => {
  const recorder = createRecorder();
  const sync = createServiceConfigSync({
    readServiceUrl: async () => 'ws://never',
    ...recorder,
  });

  sync.applyStorageChange('ws://saved');

  assert.deepEqual(recorder.applied, ['ws://saved']);
});

test('a removed or non-string stored value means "not configured"', () => {
  const recorder = createRecorder();
  const sync = createServiceConfigSync({ readServiceUrl: async () => '', ...recorder });

  sync.applyStorageChange(undefined);
  sync.applyStorageChange(null);
  sync.applyStorageChange(42);
  sync.applyStorageChange({});

  assert.deepEqual(recorder.applied, ['', '', '', '']);
});

test('an in-flight read is discarded even when the change repeats the same value', async () => {
  const read = createDeferred();
  const recorder = createRecorder();
  const sync = createServiceConfigSync({ readServiceUrl: () => read.promise, ...recorder });

  const inFlight = sync.sync('onStartup');
  sync.applyStorageChange('ws://same');
  read.resolve('ws://same');
  await inFlight;

  // The change event is authoritative; the read must not apply a second time.
  assert.deepEqual(recorder.applied, ['ws://same']);
});

test('a failed read applies nothing and never throws at the caller', async () => {
  const applied = [];
  const warnings = [];
  const sync = createServiceConfigSync({
    readServiceUrl: async () => {
      throw new Error('storage unavailable');
    },
    applyServiceUrl: (serviceUrl) => applied.push(serviceUrl),
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });

  await assert.doesNotReject(() => sync.sync('worker-start'));

  assert.deepEqual(applied, []);
  assert.equal(warnings.length, 1);
});

test('a change during one sync does not suppress a later sync', async () => {
  let stored = 'ws://one';
  const recorder = createRecorder();
  const sync = createServiceConfigSync({ readServiceUrl: async () => stored, ...recorder });

  await sync.sync('worker-start');
  sync.applyStorageChange('ws://two');
  stored = 'ws://two';
  await sync.sync('onStartup');

  assert.deepEqual(recorder.applied, ['ws://one', 'ws://two', 'ws://two']);
});
