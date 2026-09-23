import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { startTestWebSocketServer } from '../helpers/ws-server.js';

/**
 * The minimal test Service the POC drives Bridge with.
 *
 * It is deliberately a *Service*: it owns the browser process, the profile, the
 * initial URL and all interpretation. Bridge only receives JavaScript and returns
 * what it observed. Development and test use only — no platform, account or
 * business rule appears here either.
 */

const DRAIN_INTERVAL_MS = 20;

/**
 * The cadence ADR 0001 records for the Service-side keepalive loop.
 *
 * Chrome has reset an MV3 worker's idle timer on WebSocket *message* traffic since
 * 116; keeping the socket open is not activity. 20s leaves room under the ~30s idle
 * window the POC baseline measures.
 */
export const KEEPALIVE_INTERVAL_MS = 20000;

/** @param {{port?: number, log?: Function}} [options] */
export async function startTestService(options = {}) {
  const { port = 0, log = () => {} } = options;
  const server = await startTestWebSocketServer({ port });

  /** Every frame the Bridge sent, in order. */
  const received = [];
  const waiters = [];
  let bridgeCount = 0;

  const drain = setInterval(() => {
    for (const connection of server.connections) {
      const seen = connection.__pocSeen ?? 0;
      for (let i = seen; i < connection.received.length; i += 1) {
        let parsed;
        try {
          parsed = JSON.parse(connection.received[i]);
        } catch {
          parsed = { type: 'UNPARSEABLE', raw: connection.received[i] };
        }
        received.push(parsed);
        log('RECV', parsed);
      }
      connection.__pocSeen = connection.received.length;
    }
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(received)) {
        waiters[i].resolve(received);
        waiters.splice(i, 1);
      }
    }
  }, DRAIN_INTERVAL_MS);

  function withTimeout(promise, timeoutMs, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** @param {(received: object[]) => boolean} predicate */
  function waitFor(predicate, timeoutMs = 4000, message = '等待 Bridge 消息超时') {
    if (predicate(received)) return Promise.resolve(received);
    return withTimeout(
      new Promise((resolve) => waiters.push({ predicate, resolve })),
      timeoutMs,
      message,
    );
  }

  /** Frames sent since a marker, so a scenario can ignore earlier ones. */
  function mark() {
    return received.length;
  }

  function since(index) {
    return received.slice(index);
  }

  function send(message) {
    log('SEND', message);
    const text = JSON.stringify(message);
    for (const connection of server.connections) {
      if (!connection.closed) connection.send(text);
    }
  }

  let sequence = 0;
  function nextJobId(prefix = 'job') {
    sequence += 1;
    return `${prefix}-${sequence}`;
  }

  /** The Service owns the keepalive loop; see ADR 0001. At most one is running. */
  let keepaliveTimer = null;
  const keepaliveSends = [];

  function sendKeepalive() {
    const at = Date.now();
    const before = received.length;
    send({ type: 'KEEPALIVE' });
    keepaliveSends.push({ at, openConnections: server.openCount(), repliesBefore: before });
  }

  /**
   * Start the keepalive loop, or leave the running one alone.
   *
   * Idempotent on purpose: a scenario that wants "keepalive is running" should not
   * have to know whether an earlier scenario already started it, and two loops on
   * one connection would double the traffic the ADR specifies.
   */
  function startKeepalive(intervalMs = KEEPALIVE_INTERVAL_MS) {
    if (keepaliveTimer !== null) return false;
    sendKeepalive();
    keepaliveTimer = setInterval(sendKeepalive, intervalMs);
    return true;
  }

  /** Idempotent, so cleanup paths can call it without knowing whether it started. */
  function stopKeepalive() {
    if (keepaliveTimer === null) return false;
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    return true;
  }

  return {
    port: server.port,
    url: server.url,
    received,
    since,
    mark,
    send,
    nextJobId,
    waitFor,

    /** Number of Bridges that have connected since this Service started. */
    bridgeCount: () => server.totalAccepted(),
    openCount: () => server.openCount(),

    /**
     * Resolves once a Bridge has connected (or immediately if one already has).
     *
     * The deadline is checked inside the loop rather than by racing the loop
     * against a timer: a losing `Promise.race` leaves the loop scheduling 25ms
     * timers forever, and a pending timer is enough to keep Node alive, so a Bridge
     * that never connects would hang the run instead of reporting the timeout.
     */
    waitForBridge(timeoutMs = 15000) {
      if (server.totalAccepted() > 0 && server.openCount() > 0) return Promise.resolve();
      const deadline = Date.now() + timeoutMs;
      return (async () => {
        while (server.openCount() === 0) {
          if (Date.now() >= deadline) throw new Error('等待 Bridge 连接超时');
          await new Promise((r) => setTimeout(r, 25));
        }
      })();
    },

    /** Sends GET_STATUS and returns the STATUS that answers it. */
    async getStatus(timeoutMs = 4000) {
      const from = mark();
      send({ type: 'GET_STATUS' });
      const frames = await waitFor(
        (all) => all.slice(from).some((m) => m.type === 'STATUS'),
        timeoutMs,
        '等待 STATUS 超时',
      );
      return frames.slice(from).find((m) => m.type === 'STATUS');
    },

    /**
     * Sends EXECUTE and waits for the RESULT with that jobId.
     *
     * @param {{script: string, input?: unknown, jobId?: string, timeoutMs?: number}} job
     */
    async execute(job) {
      const jobId = job.jobId ?? nextJobId();
      // Marker before sending: `jobId` is only required to associate *this* EXECUTE
      // with its RESULT, not to be unique for all time. Searching the whole history
      // would return a stale RESULT when a caller reuses an id.
      const from = mark();
      const message = { type: 'EXECUTE', jobId, script: job.script };
      if ('input' in job) message.input = job.input;
      send(message);
      const frames = await waitFor(
        (all) => all.slice(from).some((m) => m.type === 'RESULT' && m.jobId === jobId),
        job.timeoutMs ?? 8000,
        `等待 ${jobId} 的 RESULT 超时`,
      );
      return frames.slice(from).filter((m) => m.type === 'RESULT' && m.jobId === jobId).at(-1);
    },

    /**
     * Restarts the endpoint on the same port, which is how the POC exercises
     * "the Service went away and came back".
     */
    async stop() {
      // The keepalive loop belongs to the connection lifecycle, so it is cleaned up
      // here rather than left for the process to exit around: a leaked interval is
      // both a hanging test process and a Service still talking to nobody.
      stopKeepalive();
      clearInterval(drain);
      await server.close();
    },

    startKeepalive,
    stopKeepalive,
    get keepaliveRunning() {
      return keepaliveTimer !== null;
    },
    /** Every KEEPALIVE this Service sent, with its timestamp and connection count. */
    keepaliveSends,
    keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
  };
}

/**
 * Standalone entry point, so a human can drive Bridge by hand.
 *
 *   node tests/poc/service.mjs                只打印往来帧
 *   node tests/poc/service.mjs --interactive  用命令行发 EXECUTE / GET_STATUS
 *
 * This is the command README's manual walkthrough tells the reader to run, so it
 * has to be a real entry point rather than a comment.
 */
const DEFAULT_CLI_PORT = 8787;

function parseCliArgs(argv) {
  const options = { port: DEFAULT_CLI_PORT, interactive: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--interactive') options.interactive = true;
  }
  return options;
}

async function runCli(argv) {
  const { port, interactive } = parseCliArgs(argv);

  /** Declared first: the service's log callback writes through it. */
  let reader = null;
  const print = (text) => {
    if (reader?.terminal) reader.output.write(`${text}\n`);
    else console.log(text);
  };

  const service = await startTestService({
    port,
    log: (direction, message) => {
      print(`${direction === 'SEND' ? '→' : '←'} ${JSON.stringify(message)}`);
      if (reader?.terminal) reader.prompt(true);
    },
  });

  print('');
  print('Browser Bridge 测试 Service');
  print(`  endpoint  ${service.url}`);
  print('  把上面的地址填进扩展设置页的 Service URL，Bridge 连上后即可发消息。');

  if (!interactive) {
    print('');
    print('未开启交互模式：只打印往来帧。加 --interactive 可手工发 EXECUTE。');
    process.on('SIGINT', async () => {
      await service.stop();
      process.exit(0);
    });
    return;
  }

  reader = createInterface({ input: process.stdin, output: process.stdout, prompt: 'bridge> ' });
  let input;

  print('');
  print('命令：');
  print('  <脚本>         发送 EXECUTE。脚本是函数体，用 return 返回数据；\\n 会变成换行');
  print('  :input <json>  设置后续 EXECUTE 的 input（:input - 清除）');
  print('  :status        发送 GET_STATUS');
  print('  :quit          退出');
  print('');
  reader.prompt();

  reader.on('line', (raw) => {
    const line = raw.trim();
    try {
      if (line === '') {
        // just re-prompt
      } else if (line === ':quit' || line === ':exit') {
        reader.close();
        return;
      } else if (line === ':status') {
        service.send({ type: 'GET_STATUS' });
      } else if (line.startsWith(':input')) {
        const argument = line.slice(':input'.length).trim();
        if (argument === '-') {
          input = undefined;
          print('  input 已清除');
        } else {
          input = JSON.parse(argument);
          print(`  input = ${JSON.stringify(input)}`);
        }
      } else {
        const message = {
          type: 'EXECUTE',
          jobId: service.nextJobId('manual'),
          script: line.replace(/\\n/g, '\n'),
        };
        if (input !== undefined) message.input = input;
        service.send(message);
      }
    } catch (error) {
      print(`  命令出错：${error.message}`);
    }
    reader.prompt();
  });

  reader.on('close', async () => {
    print('');
    await service.stop();
    process.exit(0);
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await runCli(process.argv.slice(2));
}
