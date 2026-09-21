import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_STATES, createBridgeState } from '../src/lib/bridge-state.js';
import { ERROR_CODES } from '../src/lib/protocol.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Connection stand-in: records what Bridge tried to send. */
function createFakeConnection({ sendResult = true } = {}) {
  const sent = [];
  return {
    sent,
    sendResult,
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
      error: { code: ERROR_CODES.NOT_READY, message: '没有可用的 Work Tab（NO_WORK_TAB）。' },
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
