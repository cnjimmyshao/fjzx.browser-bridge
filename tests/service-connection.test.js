import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTION_STATES, createServiceConnection } from '../src/lib/service-connection.js';

/**
 * Stand-in for the platform WebSocket. Every lifecycle event is driven by hand so
 * the connection logic can be asserted deterministically, without timers or TCP.
 */
class FakeWebSocket {
  static created = [];

  static reset() {
    FakeWebSocket.created = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closeCalls = 0;
    FakeWebSocket.created.push(this);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // --- drivers used by the tests ---
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(data) {
    this.onmessage?.({ data });
  }

  fail() {
    this.onerror?.({});
  }

  dropFromService() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeoutImpl(id) {
      pending.delete(id);
    },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    pendingCount: () => pending.size,
    fireAll() {
      const entries = [...pending.values()];
      pending.clear();
      for (const timer of entries) timer.fn();
    },
  };
}

function createHarness(options = {}) {
  FakeWebSocket.reset();
  const timers = createFakeTimers();
  const states = [];
  const messages = [];

  const connection = createServiceConnection({
    WebSocketImpl: FakeWebSocket,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...options,
  });
  connection.setStateChangeHandler((state) => states.push(state));
  connection.setMessageHandler((data) => messages.push(data));

  return { connection, timers, states, messages, sockets: () => FakeWebSocket.created };
}

test('rejects a WebSocket implementation that is not constructible, or an empty backoff', () => {
  for (const bad of [null, 'nope', 42, {}]) {
    assert.throws(
      () => createServiceConnection({ WebSocketImpl: bad }),
      TypeError,
      `${String(bad)} 应被拒绝`,
    );
  }
  assert.throws(
    () => createServiceConnection({ WebSocketImpl: FakeWebSocket, reconnectDelaysMs: [] }),
    TypeError,
  );
});

test('falls back to the platform WebSocket when none is injected', () => {
  // `undefined` must mean "use the default", which is what the extension relies
  // on: the service worker passes nothing and gets its own global WebSocket.
  const connection = createServiceConnection({ reconnectDelaysMs: [10] });
  assert.equal(connection.state, CONNECTION_STATES.DISCONNECTED);
  assert.equal(connection.url, '');
});

test('dials nothing while no Service URL is configured', () => {
  const h = createHarness();
  assert.equal(h.connection.state, CONNECTION_STATES.DISCONNECTED);

  h.connection.setUrl('');
  assert.equal(h.sockets().length, 0);

  // Whitespace is the "not configured" state, not an endpoint.
  h.connection.setUrl('   ');
  assert.equal(h.sockets().length, 0);
  assert.equal(h.connection.url, '');
});

test('connects to the configured Service URL and reports CONNECTED', () => {
  const h = createHarness();
  h.connection.setUrl('ws://127.0.0.1:1234');

  assert.equal(h.sockets().length, 1);
  assert.equal(h.sockets()[0].url, 'ws://127.0.0.1:1234');
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTING);

  h.sockets()[0].open();
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTED);
  assert.deepEqual(h.states, [CONNECTION_STATES.CONNECTING, CONNECTION_STATES.CONNECTED]);
});

test('re-setting the same URL does not open a second socket', () => {
  const h = createHarness();
  h.connection.setUrl('ws://service');
  h.sockets()[0].open();

  h.connection.setUrl('ws://service');
  h.connection.setUrl('  ws://service  ');

  assert.equal(h.sockets().length, 1);
  assert.equal(h.sockets()[0].closeCalls, 0);
});

test('changing the Service URL closes the old socket and dials only the new one', () => {
  const h = createHarness();
  h.connection.setUrl('ws://first');
  const first = h.sockets()[0];
  first.open();

  h.connection.setUrl('ws://second');

  assert.equal(first.closeCalls, 1);
  assert.equal(h.sockets().length, 2);
  assert.equal(h.sockets()[1].url, 'ws://second');
  assert.equal(h.connection.url, 'ws://second');
});

test('late events from a replaced socket cannot disturb the live connection', () => {
  const h = createHarness();
  h.connection.setUrl('ws://first');
  const first = h.sockets()[0];

  h.connection.setUrl('ws://second');
  const second = h.sockets()[1];
  second.open();

  // The old socket's handlers were detached, so none of this may reach the
  // connection: otherwise a dying socket could schedule a spurious reconnect.
  first.open();
  first.fail();
  first.dropFromService();

  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTED);
  assert.equal(h.timers.pendingCount(), 0);
  assert.equal(h.sockets().length, 2);
});

test('reconnects after an unintended drop using the first backoff delay', () => {
  const h = createHarness({ reconnectDelaysMs: [10, 20, 40] });
  h.connection.setUrl('ws://service');
  h.sockets()[0].open();

  h.sockets()[0].dropFromService();

  assert.equal(h.connection.state, CONNECTION_STATES.DISCONNECTED);
  assert.deepEqual(h.timers.delays(), [10]);

  h.timers.fireAll();
  assert.equal(h.sockets().length, 2);
  assert.equal(h.sockets()[1].url, 'ws://service');
});

test('an error schedules no reconnect of its own; the close event does', () => {
  const h = createHarness({ reconnectDelaysMs: [10] });
  h.connection.setUrl('ws://service');
  const socket = h.sockets()[0];

  socket.fail();
  assert.equal(h.timers.pendingCount(), 0, '失败本身不得排定重连');

  socket.dropFromService();
  assert.equal(h.timers.pendingCount(), 1, '只应存在一个待重连定时器');
});

test('an unreachable Service does not crash the caller and keeps retrying', () => {
  const h = createHarness({ reconnectDelaysMs: [10, 20] });
  h.connection.setUrl('ws://127.0.0.1:1');

  assert.doesNotThrow(() => {
    for (let i = 0; i < 3; i++) {
      h.sockets().at(-1).fail();
      h.sockets().at(-1).dropFromService();
      h.timers.fireAll();
    }
  });

  assert.equal(h.sockets().length, 4, '每次退避结束后都应再试一次');
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTING);
});

test('backoff grows with consecutive failures and then repeats the last delay', () => {
  const h = createHarness({ reconnectDelaysMs: [10, 20, 40] });
  h.connection.setUrl('ws://service');

  const observed = [];
  for (let i = 0; i < 4; i++) {
    h.sockets().at(-1).dropFromService();
    observed.push(...h.timers.delays());
    h.timers.fireAll();
  }

  assert.deepEqual(observed, [10, 20, 40, 40]);
});

test('a successful connection resets the backoff', () => {
  const h = createHarness({ reconnectDelaysMs: [10, 20, 40] });
  h.connection.setUrl('ws://service');

  h.sockets().at(-1).dropFromService();
  h.timers.fireAll();
  h.sockets().at(-1).dropFromService();
  assert.deepEqual(h.timers.delays(), [20]);

  h.timers.fireAll();
  h.sockets().at(-1).open(); // recovered
  h.sockets().at(-1).dropFromService();

  assert.deepEqual(h.timers.delays(), [10], '恢复后应回到首个退避值');
});

test('clearing the Service URL closes the socket and stops reconnecting', () => {
  const h = createHarness({ reconnectDelaysMs: [10] });
  h.connection.setUrl('ws://service');
  const socket = h.sockets()[0];
  socket.open();

  h.connection.setUrl('');

  assert.equal(socket.closeCalls, 1);
  assert.equal(h.connection.state, CONNECTION_STATES.DISCONNECTED);
  assert.equal(h.timers.pendingCount(), 0);
  assert.equal(h.sockets().length, 1, '清除配置后不得再拨号');
});

test('stop() closes the connection and cancels any pending retry', () => {
  const h = createHarness({ reconnectDelaysMs: [10] });
  h.connection.setUrl('ws://service');
  h.sockets()[0].open();
  h.sockets()[0].dropFromService();
  assert.equal(h.timers.pendingCount(), 1);

  h.connection.stop();

  assert.equal(h.timers.pendingCount(), 0);
  assert.equal(h.connection.state, CONNECTION_STATES.DISCONNECTED);
  h.timers.fireAll();
  assert.equal(h.sockets().length, 1, '停止后不得再拨号');
});

test('raw frames reach the handler, including text that is not JSON', () => {
  const h = createHarness();
  h.connection.setUrl('ws://service');
  const socket = h.sockets()[0];
  socket.open();

  socket.deliver('not json at all');
  socket.deliver('{"type":"UNKNOWN"}');
  socket.deliver('{ broken');

  assert.deepEqual(h.messages, ['not json at all', '{"type":"UNKNOWN"}', '{ broken']);
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTED);
});

test('a throwing message handler cannot break the connection', () => {
  const h = createHarness();
  h.connection.setMessageHandler(() => {
    throw new Error('handler exploded');
  });
  h.connection.setUrl('ws://service');
  const socket = h.sockets()[0];
  socket.open();

  assert.doesNotThrow(() => socket.deliver('anything'));
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTED);
  assert.equal(h.timers.pendingCount(), 0);
});

test('a throwing state handler cannot break the connection', () => {
  const h = createHarness();
  h.connection.setStateChangeHandler(() => {
    throw new Error('state handler exploded');
  });

  assert.doesNotThrow(() => h.connection.setUrl('ws://service'));
  assert.doesNotThrow(() => h.sockets()[0].open());
  assert.equal(h.connection.state, CONNECTION_STATES.CONNECTED);
});

test('a URL the runtime refuses is reported instead of thrown, and is not retried on a timer', () => {
  const timers = createFakeTimers();
  const connection = createServiceConnection({
    WebSocketImpl: class {
      constructor(url) {
        throw new SyntaxError(`refused: ${url}`);
      }
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    reconnectDelaysMs: [10],
  });

  assert.doesNotThrow(() => connection.setUrl('ws://service#fragment'));
  assert.equal(connection.state, CONNECTION_STATES.DISCONNECTED);
  assert.equal(timers.pendingCount(), 0, 'URL 本身不被接受时不应定时重试');
});
