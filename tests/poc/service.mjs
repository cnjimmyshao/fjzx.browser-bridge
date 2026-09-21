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

    /** Resolves once a Bridge has connected (or immediately if one already has). */
    waitForBridge(timeoutMs = 15000) {
      if (server.totalAccepted() > 0 && server.openCount() > 0) return Promise.resolve();
      return withTimeout(
        (async () => {
          while (server.openCount() === 0) await new Promise((r) => setTimeout(r, 25));
        })(),
        timeoutMs,
        '等待 Bridge 连接超时',
      );
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
      const message = { type: 'EXECUTE', jobId, script: job.script };
      if ('input' in job) message.input = job.input;
      send(message);
      const frames = await waitFor(
        (all) => all.some((m) => m.type === 'RESULT' && m.jobId === jobId),
        job.timeoutMs ?? 8000,
        `等待 ${jobId} 的 RESULT 超时`,
      );
      return frames.filter((m) => m.type === 'RESULT' && m.jobId === jobId).at(-1);
    },

    /**
     * Restarts the endpoint on the same port, which is how the POC exercises
     * "the Service went away and came back".
     */
    async stop() {
      clearInterval(drain);
      await server.close();
    },
  };
}
