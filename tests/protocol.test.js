import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_MESSAGE_TYPES,
  ERROR_CODES,
  PARSE_FAILURES,
  SERVICE_MESSAGE_TYPES,
  createResultError,
  createResultOk,
  createStatus,
  isJsonCompatible,
  parseServiceMessage,
} from '../src/lib/protocol.js';

test('the frozen V1 message set contains exactly four types and three codes', () => {
  assert.deepEqual(Object.values(SERVICE_MESSAGE_TYPES), ['EXECUTE', 'GET_STATUS']);
  assert.deepEqual(Object.values(BRIDGE_MESSAGE_TYPES), ['RESULT', 'STATUS']);
  assert.deepEqual(Object.values(ERROR_CODES), [
    'BUSY',
    'NOT_READY',
    'SCRIPT_EXECUTION_FAILED',
  ]);
});

test('parses a complete EXECUTE, carrying input and metadata through untouched', () => {
  const input = { nested: [1, 2, { deep: true }] };
  const metadata = { trace: 'abc', attempt: 3 };

  const result = parseServiceMessage(
    JSON.stringify({ type: 'EXECUTE', jobId: 'job-1', script: 'return 1;', input, metadata }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.message.type, 'EXECUTE');
  assert.equal(result.message.jobId, 'job-1');
  assert.equal(result.message.script, 'return 1;');
  assert.deepEqual(result.message.input, input, 'input 必须原样带过');
  assert.deepEqual(result.message.metadata, metadata, 'metadata 必须原样带过');
});

test('input and metadata are optional and are not invented when absent', () => {
  const result = parseServiceMessage(
    JSON.stringify({ type: 'EXECUTE', jobId: 'job-2', script: '' }),
  );

  assert.equal(result.ok, true);
  assert.equal('input' in result.message, false);
  assert.equal('metadata' in result.message, false);
  assert.equal(result.message.script, '');
});

test('parses GET_STATUS, which needs nothing else', () => {
  const result = parseServiceMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.deepEqual(result, { ok: true, message: { type: 'GET_STATUS' } });
});

test('rejects anything that is not a text frame', () => {
  for (const raw of [undefined, null, 42, {}, [], Buffer.from('{}')]) {
    const result = parseServiceMessage(raw);
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.NOT_TEXT);
    assert.equal(result.jobId, null);
  }
});

test('rejects malformed JSON without throwing', () => {
  for (const raw of ['{', 'not json', '{"type":}', '']) {
    const result = parseServiceMessage(raw);
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.INVALID_JSON);
  }
});

test('rejects JSON that is not an object', () => {
  for (const raw of ['[]', '"EXECUTE"', '7', 'null', 'true']) {
    const result = parseServiceMessage(raw);
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.NOT_AN_OBJECT);
  }
});

test('rejects unknown message types, including Bridge-only ones', () => {
  // RESULT and STATUS travel the other way; seeing them here is not our business.
  for (const type of ['RESULT', 'STATUS', 'FOO', '', 42, undefined]) {
    const result = parseServiceMessage(JSON.stringify({ type, jobId: 'job-3' }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.UNKNOWN_TYPE);
  }
});

test('rejects an EXECUTE without a usable jobId', () => {
  for (const jobId of [undefined, null, '', 7, {}, []]) {
    const result = parseServiceMessage(JSON.stringify({ type: 'EXECUTE', jobId, script: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.MISSING_JOB_ID);
    assert.equal(result.jobId, null, '不可用的 jobId 不得被报出');
  }
});

test('rejects an EXECUTE without a script, still reporting the jobId', () => {
  for (const script of [undefined, null, 42, {}, ['x']]) {
    const result = parseServiceMessage(JSON.stringify({ type: 'EXECUTE', jobId: 'job-4', script }));
    assert.equal(result.ok, false);
    assert.equal(result.failure, PARSE_FAILURES.MISSING_SCRIPT);
    assert.equal(result.jobId, 'job-4', '有 jobId 才能回 RESULT');
  }
});

test('a rejected frame still reports a usable jobId so a RESULT can be sent', () => {
  const unknownType = parseServiceMessage(JSON.stringify({ type: 'NOPE', jobId: 'job-5' }));
  assert.equal(unknownType.jobId, 'job-5');

  const badJson = parseServiceMessage('{"type":"EXECUTE","jobId":"job-6",');
  assert.equal(badJson.jobId, null, 'JSON 都没解析出来时没有 jobId 可用');
});

test('builds a successful RESULT, mapping undefined to null', () => {
  assert.deepEqual(createResultOk('job-7', { a: 1 }), {
    type: 'RESULT',
    jobId: 'job-7',
    ok: true,
    data: { a: 1 },
  });
  assert.deepEqual(createResultOk('job-7', undefined), {
    type: 'RESULT',
    jobId: 'job-7',
    ok: true,
    data: null,
  });
  assert.deepEqual(createResultOk('job-7', false), {
    type: 'RESULT',
    jobId: 'job-7',
    ok: true,
    data: false,
  });
});

test('builds a failed RESULT with only a V1 error code', () => {
  assert.deepEqual(createResultError('job-8', ERROR_CODES.BUSY, 'busy'), {
    type: 'RESULT',
    jobId: 'job-8',
    ok: false,
    error: { code: 'BUSY', message: 'busy' },
  });
});

test('STATUS carries exactly what its state needs', () => {
  assert.deepEqual(createStatus('IDLE'), { type: 'STATUS', state: 'IDLE' });
  assert.deepEqual(createStatus('RUNNING', { jobId: 'job-9' }), {
    type: 'STATUS',
    state: 'RUNNING',
    jobId: 'job-9',
  });
  assert.deepEqual(createStatus('NOT_READY', { reason: 'MULTIPLE_TABS' }), {
    type: 'STATUS',
    state: 'NOT_READY',
    reason: 'MULTIPLE_TABS',
  });
  assert.deepEqual(createStatus('RUNNING'), { type: 'STATUS', state: 'RUNNING' });
});

test('accepts exactly the JSON value types the architecture allows', () => {
  const accepted = [
    null,
    true,
    false,
    0,
    -1.5,
    '',
    'text',
    [],
    [1, 'two', null, { three: false }],
    {},
    { a: { b: [{ c: null }] } },
  ];
  for (const value of accepted) {
    assert.equal(isJsonCompatible(value), true, `${JSON.stringify(value)} 应被接受`);
  }
});

test('refuses values JSON.stringify would silently rewrite', () => {
  // Each of these serializes without throwing, but the Service would receive
  // something other than what the script returned.
  const rejected = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['a function', () => {}],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a Date', new Date(0)],
    ['a RegExp', /x/],
    ['a typed array', new Uint8Array(2)],
    ['a nested undefined', { a: undefined }],
    ['a nested function', { a: () => {} }],
    ['an undefined in an array', [undefined]],
  ];
  for (const [label, value] of rejected) {
    assert.equal(isJsonCompatible(value), false, `${label} 应被拒绝`);
  }
});

test('detects cycles without rejecting a value that merely appears twice', () => {
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.equal(isJsonCompatible(cyclic), false);
  assert.equal(isJsonCompatible([cyclic]), false);

  const shared = { reused: true };
  assert.equal(isJsonCompatible({ a: shared, b: shared }), true);
  assert.equal(isJsonCompatible([shared, shared]), true);
});

test('accepts a null-prototype object, which still serializes as a plain object', () => {
  const bare = Object.create(null);
  bare.a = 1;
  assert.equal(isJsonCompatible(bare), true);
});

test('refuses arrays whose holes or stray properties JSON would change', () => {
  // `every` skips holes, so they need an explicit check: `new Array(1)` leaves as
  // `[null]`, and a stray property is dropped entirely.
  assert.equal(isJsonCompatible(new Array(1)), false);
  assert.equal(isJsonCompatible([1, , 3]), false);
  assert.equal(isJsonCompatible([1, undefined, 3]), false);

  const withProperty = [1];
  withProperty.extra = 'x';
  assert.equal(isJsonCompatible(withProperty), false);

  assert.equal(isJsonCompatible([1, 2, 3]), true);
  assert.equal(isJsonCompatible([]), true);
});
