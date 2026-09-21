import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_STATES, createBridgeState } from '../src/lib/bridge-state.js';
import { ERROR_CODES } from '../src/lib/protocol.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Connection stand-in: records what Bridge tried to send, and where. */
function createFakeConnection({ sendResult = true, url = 'ws://service.test' } = {}) {
  const sent = [];
  const state = { url };
  return {
    sent,
    sendResult,
    get url() {
      return state.url;
    },
    /** Simulates the operator repointing the Service URL. */
    repoint(nextUrl) {
      state.url = nextUrl;
    },
    send(text) {
      sent.push(JSON.parse(text));
      return sendResult;
    },
  };
}

/** Work Tab stand-in whose boundness the test can flip mid-job. */
function createFakeWorkTab(initial = {}) {
  const state = { isBound: true, tabId: 42, reason: null, ...initial };
  return {
    state,
    get isBound() {
      return state.isBound;
    },
    get tabId() {
      return state.tabId;
    },
    get reason() {
      return state.reason;
    },
  };
}

/** Executor whose completion the test decides, so RUNNING is observable. */
function createControlledExecutor() {
  const calls = [];
  let pending = null;
  return {
    calls,
    execute(job) {
      calls.push(job);
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
    async settle(data) {
      pending.resolve(data);
      await flush();
    },
    async fail(error) {
      pending.reject(error);
      await flush();
    },
  };
}

function createHarness({ workTab = createFakeWorkTab(), connection, executor } = {}) {
  const conn = connection ?? createFakeConnection();
  const exec = executor ?? createControlledExecutor();
  const states = [];
  const bridge = createBridgeState({
    connection: conn,
    workTab,
    executor: exec,
    onStateChange: (state) => states.push(state),
  });
  return { bridge, connection: conn, executor: exec, workTab, states };
}

const execute = (jobId, extra = {}) =>
  JSON.stringify({ type: 'EXECUTE', jobId, script: 'return 1;', ...extra });

test('requires a connection, a work tab and an executor', () => {
  const connection = createFakeConnection();
  const workTab = createFakeWorkTab();
  const executor = createControlledExecutor();

  assert.throws(() => createBridgeState({ workTab, executor }), TypeError);
  assert.throws(() => createBridgeState({ connection: {}, workTab, executor }), TypeError);
  assert.throws(() => createBridgeState({ connection, executor }), TypeError);
  assert.throws(() => createBridgeState({ connection, workTab }), TypeError);
  assert.throws(() => createBridgeState({ connection, workTab, executor: {} }), TypeError);
});

test('GET_STATUS reports IDLE when a Work Tab is bound and nothing is running', async () => {
  const h = createHarness();

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));

  assert.deepEqual(h.connection.sent, [{ type: 'STATUS', state: 'IDLE' }]);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
});

test('GET_STATUS reports NOT_READY with the Work Tab reason', async () => {
  const h = createHarness({
    workTab: createFakeWorkTab({ isBound: false, tabId: null, reason: 'MULTIPLE_TABS' }),
  });

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));

  assert.deepEqual(h.connection.sent, [
    { type: 'STATUS', state: 'NOT_READY', reason: 'MULTIPLE_TABS' },
  ]);
  assert.equal(h.bridge.notReadyReason, 'MULTIPLE_TABS');
});

test('GET_STATUS reports RUNNING with the current jobId', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-1'));
  await flush();

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));

  assert.deepEqual(h.connection.sent, [{ type: 'STATUS', state: 'RUNNING', jobId: 'job-1' }]);
  assert.equal(h.bridge.currentJobId, 'job-1');

  await h.executor.settle(null);
  await handling;
});

test('a Job runs IDLE -> RUNNING -> RESULT -> IDLE', async () => {
  const h = createHarness();
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);

  const handling = h.bridge.handleMessage(execute('job-2'));
  await flush();
  assert.equal(h.bridge.state, BRIDGE_STATES.RUNNING);
  assert.equal(h.connection.sent.length, 0, 'RESULT 只在完成后推送');

  await h.executor.settle({ answer: 42 });
  await handling;

  assert.deepEqual(h.connection.sent, [
    { type: 'RESULT', jobId: 'job-2', ok: true, data: { answer: 42 } },
  ]);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
  assert.equal(h.bridge.currentJobId, null);
  assert.deepEqual(h.states, [BRIDGE_STATES.RUNNING, BRIDGE_STATES.IDLE]);
});

test('the executor receives the Work Tab id, the script and the raw input', async () => {
  const h = createHarness({ workTab: createFakeWorkTab({ tabId: 99 }) });
  const input = { nested: { a: [1, 2] } };

  const handling = h.bridge.handleMessage(execute('job-3', { input, metadata: { m: 1 } }));
  await flush();

  assert.deepEqual(h.executor.calls, [{ tabId: 99, script: 'return 1;', input }]);
  assert.equal('metadata' in h.executor.calls[0], false, 'metadata 不得被解释或转发');

  await h.executor.settle(null);
  await handling;
});

test('RESULT.jobId echoes the EXECUTE jobId exactly', async () => {
  const h = createHarness();
  const jobId = 'Job-With-CASE_and.dots-123';

  const handling = h.bridge.handleMessage(execute(jobId));
  await flush();
  await h.executor.settle(null);
  await handling;

  assert.equal(h.connection.sent[0].jobId, jobId);
});

test('a second EXECUTE while RUNNING is answered BUSY and leaves the first Job alone', async () => {
  const h = createHarness();

  const first = h.bridge.handleMessage(execute('job-first'));
  await flush();

  await h.bridge.handleMessage(execute('job-second'));

  assert.deepEqual(h.connection.sent, [
    {
      type: 'RESULT',
      jobId: 'job-second',
      ok: false,
      error: { code: ERROR_CODES.BUSY, message: 'Bridge 正在执行 job-first。' },
    },
  ]);
  assert.equal(h.bridge.currentJobId, 'job-first', '第一个 Job 不受影响');
  assert.equal(h.executor.calls.length, 1, '不得排队执行第二个 Job');

  await h.executor.settle('first-result');
  await first;

  assert.deepEqual(h.connection.sent.at(-1), {
    type: 'RESULT',
    jobId: 'job-first',
    ok: true,
    data: 'first-result',
  });
});

test('EXECUTE while NOT_READY is refused without starting the executor', async () => {
  const h = createHarness({
    workTab: createFakeWorkTab({ isBound: false, tabId: null, reason: 'NO_WORK_TAB' }),
  });

  await h.bridge.handleMessage(execute('job-4'));

  assert.equal(h.executor.calls.length, 0, '未就绪时不得启动 executor');
  assert.deepEqual(h.connection.sent, [
    {
      type: 'RESULT',
      jobId: 'job-4',
      ok: false,
      error: { code: ERROR_CODES.NOT_READY, message: 'Bridge 当前不可用（NO_WORK_TAB）。' },
    },
  ]);
  assert.equal(h.bridge.state, BRIDGE_STATES.NOT_READY);
});

test('a throwing executor becomes SCRIPT_EXECUTION_FAILED', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-5'));
  await flush();

  await h.executor.fail(new Error('boom'));
  await handling;

  assert.deepEqual(h.connection.sent, [
    {
      type: 'RESULT',
      jobId: 'job-5',
      ok: false,
      error: { code: ERROR_CODES.SCRIPT_EXECUTION_FAILED, message: 'boom' },
    },
  ]);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE, '失败后仍回到可服务状态');
  assert.equal(h.bridge.currentJobId, null);
});

test('a non-serializable return value becomes SCRIPT_EXECUTION_FAILED', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-6'));
  await flush();

  const circular = {};
  circular.self = circular;
  await h.executor.settle(circular);
  await handling;

  assert.equal(h.connection.sent[0].ok, false);
  assert.equal(h.connection.sent[0].error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
  assert.match(h.connection.sent[0].error.message, /JSON-compatible/);
});

test('malformed and unknown frames are absorbed', async () => {
  const h = createHarness();

  for (const raw of ['', '{', 'not json', '[]', '42', 'null', undefined, {}, 7]) {
    await assert.doesNotReject(() => h.bridge.handleMessage(raw));
  }

  assert.deepEqual(h.connection.sent, [], '无法回答的帧不应产生任何消息');
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
});

test('a rejected request that carried a jobId still gets an answer', async () => {
  const h = createHarness();

  await h.bridge.handleMessage(JSON.stringify({ type: 'EXECUTE', jobId: 'job-7' }));

  assert.deepEqual(h.connection.sent, [
    {
      type: 'RESULT',
      jobId: 'job-7',
      ok: false,
      error: { code: ERROR_CODES.SCRIPT_EXECUTION_FAILED, message: 'EXECUTE 缺少字符串 script。' },
    },
  ]);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE, '无效请求不得占用状态');
});

test('an unknown type without a jobId is silently ignored', async () => {
  const h = createHarness();

  await h.bridge.handleMessage(JSON.stringify({ type: 'NOPE' }));

  assert.deepEqual(h.connection.sent, []);
});

test('no result history survives a completed Job', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-8'));
  await flush();
  await h.executor.settle('done');
  await handling;

  assert.equal(h.bridge.currentJobId, null);
  // Only the request/response pair exists; nothing is cached for later retrieval.
  assert.equal(h.connection.sent.length, 1);

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.deepEqual(h.connection.sent.at(-1), { type: 'STATUS', state: 'IDLE' });
});

test('the Work Tab disappearing mid-Job does not disturb the Job in flight', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-9'));
  await flush();

  h.workTab.state.isBound = false;
  h.workTab.state.reason = 'WORK_TAB_CLOSED';

  assert.equal(h.bridge.state, BRIDGE_STATES.RUNNING, '执行中的 Job 不受影响');
  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.deepEqual(h.connection.sent.at(-1), {
    type: 'STATUS',
    state: 'RUNNING',
    jobId: 'job-9',
  });

  await h.executor.settle('ok');
  await handling;

  assert.deepEqual(h.connection.sent.at(-1), {
    type: 'RESULT',
    jobId: 'job-9',
    ok: true,
    data: 'ok',
  });
  assert.equal(h.bridge.state, BRIDGE_STATES.NOT_READY, '完成后按实际 Work Tab 条件定状态');
});

test('a dropped RESULT is logged rather than queued or thrown', async () => {
  const warnings = [];
  const connection = createFakeConnection({ sendResult: false });
  const bridge = createBridgeState({
    connection,
    workTab: createFakeWorkTab(),
    executor: { execute: async () => 'data' },
    logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
  });

  await assert.doesNotReject(() => bridge.handleMessage(execute('job-10')));

  assert.ok(warnings.some((line) => line.includes('dropped RESULT')));
  assert.equal(bridge.state, BRIDGE_STATES.IDLE);
});

test('a throwing state-change handler cannot break the Job', async () => {
  const connection = createFakeConnection();
  const bridge = createBridgeState({
    connection,
    workTab: createFakeWorkTab(),
    executor: { execute: async () => 1 },
    onStateChange: () => {
      throw new Error('handler exploded');
    },
  });

  await assert.doesNotReject(() => bridge.handleMessage(execute('job-11')));
  assert.deepEqual(connection.sent, [
    { type: 'RESULT', jobId: 'job-11', ok: true, data: 1 },
  ]);
});

test('a frame delivered by a previous endpoint is dropped rather than answered', async () => {
  const h = createHarness();
  // Handling was deferred while the Work Tab was evaluated and the operator
  // repointed the Service URL in the meantime.
  h.connection.repoint('ws://other.test');

  await h.bridge.handleMessage(execute('job-18'), { deliveredOn: 'ws://service.test' });

  assert.deepEqual(h.connection.sent, [], '不得在新端点上回答旧端点发来的帧');
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
});

test('a frame delivered on the current endpoint is handled normally', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-19'), {
    deliveredOn: 'ws://service.test',
  });
  await flush();
  await h.executor.settle('ok');
  await handling;

  assert.deepEqual(h.connection.sent, [
    { type: 'RESULT', jobId: 'job-19', ok: true, data: 'ok' },
  ]);
});

test('a bound Work Tab is not enough when the platform will not run scripts', async () => {
  // The API being unavailable is a technical state, so it is reported as
  // NOT_READY rather than letting a Job be accepted and then fail obscurely.
  const executor = { ...createControlledExecutor(), isAvailable: () => false };
  const h = createHarness({ executor });

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.deepEqual(h.connection.sent, [
    { type: 'STATUS', state: 'NOT_READY', reason: 'USER_SCRIPTS_UNAVAILABLE' },
  ]);
  assert.equal(h.bridge.notReadyReason, 'USER_SCRIPTS_UNAVAILABLE');

  await h.bridge.handleMessage(execute('job-24'));
  assert.equal(h.executor.calls.length, 0, '不可用时不得启动 executor');
  assert.equal(h.connection.sent.at(-1).error.code, ERROR_CODES.NOT_READY);
  assert.match(h.connection.sent.at(-1).error.message, /USER_SCRIPTS_UNAVAILABLE/);
});

test('a Work Tab problem outranks an unavailable API in the reported reason', async () => {
  const executor = { ...createControlledExecutor(), isAvailable: () => false };
  const h = createHarness({
    executor,
    workTab: createFakeWorkTab({ isBound: false, tabId: null, reason: 'MULTIPLE_TABS' }),
  });

  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));

  assert.deepEqual(h.connection.sent, [
    { type: 'STATUS', state: 'NOT_READY', reason: 'MULTIPLE_TABS' },
  ]);
});

test('an executor without an availability probe is treated as available', async () => {
  const h = createHarness();
  await h.bridge.handleMessage(JSON.stringify({ type: 'GET_STATUS' }));
  assert.deepEqual(h.connection.sent, [{ type: 'STATUS', state: 'IDLE' }]);
});

test('a Job that resolves with undefined still produces a JSON-compatible RESULT', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-12'));
  await flush();

  await h.executor.settle(undefined);
  await handling;

  assert.deepEqual(h.connection.sent, [
    { type: 'RESULT', jobId: 'job-12', ok: true, data: null },
  ]);
});

test('a value whose inspection throws fails the Job instead of stranding it', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-20'));
  await flush();

  // A plain object with an enumerable throwing getter: reading it during
  // validation raises, and a Job left registered would answer every later
  // EXECUTE with BUSY forever.
  const explosive = {
    get boom() {
      throw new Error('getter exploded');
    },
  };
  await h.executor.settle(explosive);
  await handling;

  assert.equal(h.connection.sent[0].ok, false);
  assert.equal(h.connection.sent[0].error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE, 'Bridge 不得滞留在 RUNNING');
  assert.equal(h.bridge.currentJobId, null);

  // And a later Job still gets through.
  const next = h.bridge.handleMessage(execute('job-21'));
  await flush();
  await h.executor.settle('fine');
  await next;

  assert.deepEqual(h.connection.sent.at(-1), {
    type: 'RESULT',
    jobId: 'job-21',
    ok: true,
    data: 'fine',
  });
});

test('a rejection value that cannot even be described still clears the Job', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-22'));
  await flush();

  // `String(value)` throws here, so describing the failure is itself a hazard on
  // the path that is supposed to recover from it.
  const hostile = {
    [Symbol.toPrimitive]() {
      throw new Error('cannot describe me');
    },
  };
  await h.executor.fail(hostile);
  await handling;

  assert.equal(h.connection.sent[0].ok, false);
  assert.equal(h.connection.sent[0].error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE, 'Bridge 不得滞留在 RUNNING');

  const next = h.bridge.handleMessage(execute('job-23'));
  await flush();
  await h.executor.settle('fine');
  await next;
  assert.deepEqual(h.connection.sent.at(-1), {
    type: 'RESULT',
    jobId: 'job-23',
    ok: true,
    data: 'fine',
  });
});

test('a RESULT is not delivered to a Service that did not submit the Job', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-13'));
  await flush();

  // The operator repoints the Service URL while the Job is still running.
  h.connection.repoint('ws://other.test');
  await h.executor.settle('page-derived data');
  await handling;

  assert.deepEqual(h.connection.sent, [], '替代端点不得收到它没提交过的 Job 结果');
  assert.equal(h.bridge.state, BRIDGE_STATES.IDLE, 'Job 仍然结束，Bridge 重新可用');
  assert.equal(h.bridge.currentJobId, null);
});

test('a RESULT survives a reconnect to the same endpoint', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-14'));
  await flush();

  h.connection.repoint('ws://service.test'); // same endpoint, new socket
  await h.executor.settle('ok');
  await handling;

  assert.deepEqual(h.connection.sent, [
    { type: 'RESULT', jobId: 'job-14', ok: true, data: 'ok' },
  ]);
});

test('values JSON would silently rewrite are refused instead of corrupted', async () => {
  const cases = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a nested undefined', { a: undefined }],
    ['a nested function', { a: () => {} }],
    ['a Map', new Map([['k', 'v']])],
    ['a Date', new Date(0)],
    ['a Set', new Set([1])],
    ['a bigint', 10n],
  ];

  for (const [label, value] of cases) {
    const h = createHarness();
    const handling = h.bridge.handleMessage(execute('job-15'));
    await flush();
    await h.executor.settle(value);
    await handling;

    assert.equal(h.connection.sent[0].ok, false, `${label} 应被拒绝`);
    assert.equal(h.connection.sent[0].error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
    assert.equal(h.bridge.state, BRIDGE_STATES.IDLE);
  }
});

test('a cyclic return value is refused rather than thrown over', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-16'));
  await flush();

  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  await h.executor.settle(cyclic);
  await handling;

  assert.equal(h.connection.sent[0].ok, false);
  assert.equal(h.connection.sent[0].error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
});

test('a value that merely appears twice is not mistaken for a cycle', async () => {
  const h = createHarness();
  const handling = h.bridge.handleMessage(execute('job-17'));
  await flush();

  const shared = { reused: true };
  await h.executor.settle({ first: shared, second: shared, list: [1, 'two', null, false] });
  await handling;

  assert.equal(h.connection.sent[0].ok, true);
  assert.deepEqual(h.connection.sent[0].data, {
    first: { reused: true },
    second: { reused: true },
    list: [1, 'two', null, false],
  });
});
