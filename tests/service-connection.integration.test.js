import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTION_STATES, createServiceConnection } from '../src/lib/service-connection.js';
import { startTestWebSocketServer } from './helpers/ws-server.js';

/**
 * These exercise the real thing: a real WebSocket over real TCP against the
 * minimal test Service in `tests/helpers/ws-server.js`. The unit suite next door
 * pins the lifecycle logic deterministically; this one proves the wiring works
 * against an actual endpoint.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForState(connection, wanted, timeoutMs = 3000) {
  if (connection.state === wanted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const guard = setTimeout(
      () => reject(new Error(`等待状态 ${wanted} 超时（当前 ${connection.state}）`)),
      timeoutMs,
    );
    connection.setStateChangeHandler((next) => {
      if (next !== wanted) return;
      clearTimeout(guard);
      resolve();
    });
  });
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error('等待条件超时');
}

test('connects to a real Service endpoint', async (t) => {
  const server = await startTestWebSocketServer();
  const connection = createServiceConnection({ reconnectDelaysMs: [30] });
  t.after(async () => {
    connection.stop();
    await server.close();
  });

  connection.setUrl(server.url);
  await waitForState(connection, CONNECTION_STATES.CONNECTED);

  assert.equal(server.totalAccepted(), 1);
  assert.equal(server.openCount(), 1);
});

test('never dials while no Service URL is configured', async (t) => {
  const server = await startTestWebSocketServer();
  const connection = createServiceConnection({ reconnectDelaysMs: [30] });
  t.after(async () => {
    connection.stop();
    await server.close();
  });

  connection.setUrl('');
  await sleep(200);

  assert.equal(server.totalAccepted(), 0);
  assert.equal(connection.state, CONNECTION_STATES.DISCONNECTED);
});

test('reconnects by itself after the Service drops the connection', async (t) => {
  const server = await startTestWebSocketServer();
  const connection = createServiceConnection({ reconnectDelaysMs: [30] });
  t.after(async () => {
    connection.stop();
    await server.close();
  });

  connection.setUrl(server.url);
  await server.waitForConnections(1);
  const first = server.connections[0];

  first.destroy();
  await first.waitForClose();
  assert.equal(connection.state, CONNECTION_STATES.DISCONNECTED);

  await server.waitForConnections(2, 3000);
  assert.equal(server.totalAccepted(), 2, '断线后应自动重连，无需重装');
});

test('keeps at most one Service connection open when the URL changes', async (t) => {
  const serverA = await startTestWebSocketServer();
  const serverB = await startTestWebSocketServer();
  const connection = createServiceConnection({ reconnectDelaysMs: [30] });
  t.after(async () => {
    connection.stop();
    await Promise.all([serverA.close(), serverB.close()]);
  });

  connection.setUrl(serverA.url);
  await serverA.waitForConnections(1);
  assert.equal(serverA.openCount(), 1);

  connection.setUrl(serverB.url);
  await serverB.waitForConnections(1);
  await serverA.connections[0].waitForClose();

  assert.equal(serverA.openCount(), 0, '旧连接必须已关闭');
  assert.equal(serverB.openCount(), 1);
  assert.equal(connection.url, serverB.url);
});

test('recovers once the Service comes back, without a reinstall', async (t) => {
  // Reserve a port, then take the Service away so the first dials fail.
  const probe = await startTestWebSocketServer();
  const { port } = probe;
  await probe.close();

  const connection = createServiceConnection({ reconnectDelaysMs: [50] });
  t.after(() => connection.stop());

  connection.setUrl(`ws://127.0.0.1:${port}`);
  await sleep(200);
  assert.notEqual(connection.state, CONNECTION_STATES.CONNECTED, '此刻不应已连接');

  const server = await startTestWebSocketServer({ port });
  t.after(() => server.close());

  await server.waitForConnections(1, 4000);
  await waitForState(connection, CONNECTION_STATES.CONNECTED, 4000);
  assert.equal(server.openCount(), 1);
});

test('delivers raw Service frames and survives a non-JSON payload', async (t) => {
  const server = await startTestWebSocketServer();
  const received = [];
  const connection = createServiceConnection({ reconnectDelaysMs: [30] });
  connection.setMessageHandler((data) => received.push(data));
  t.after(async () => {
    connection.stop();
    await server.close();
  });

  connection.setUrl(server.url);
  await server.waitForConnections(1);
  await waitForState(connection, CONNECTION_STATES.CONNECTED);

  server.connections[0].send('{ this is not json');
  server.connections[0].send('plain text');
  await waitUntil(() => received.length === 2);

  assert.deepEqual(received, ['{ this is not json', 'plain text']);
  assert.equal(connection.state, CONNECTION_STATES.CONNECTED, '非法负载不得影响连接');
  assert.equal(server.openCount(), 1);
});

test('an endpoint with nothing listening does not crash and keeps its retry loop', async (t) => {
  const probe = await startTestWebSocketServer();
  const { port } = probe;
  await probe.close();

  const connection = createServiceConnection({ reconnectDelaysMs: [40] });
  t.after(() => connection.stop());

  assert.doesNotThrow(() => connection.setUrl(`ws://127.0.0.1:${port}`));
  await sleep(250);

  assert.notEqual(connection.state, CONNECTION_STATES.CONNECTED);
  assert.ok(connection.url.endsWith(`:${port}`), '重试期间仍保持目标 URL');
});
