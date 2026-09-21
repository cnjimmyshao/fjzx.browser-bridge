import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

/**
 * Minimal, dependency-free WebSocket server used only by tests.
 *
 * It implements the subset Bridge needs to be exercised against: the opening
 * handshake, text frames in both directions, ping/pong and close. Keeping it in
 * the repo means the test suite stays free of third-party packages while still
 * talking to a real socket over real TCP.
 *
 * This is not production test infrastructure and never ships: it lives under
 * `tests/` and `src/` is the extension root.
 */

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** Servers never mask their frames. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Decode every complete frame currently held in `buffer`. */
function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }

    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }

    if (cursor + length > buffer.length) break;

    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }

    frames.push({ opcode, payload });
    offset = cursor + length;
  }

  return { frames, rest: buffer.subarray(offset) };
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startTestWebSocketServer({
  connectTimeoutMs = 2000,
  port = 0,
  respondToClose = true,
} = {}) {
  /** @type {Array<object>} accepted connections, in accept order */
  const connections = [];
  let totalAccepted = 0;

  const server = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' });
    response.end('upgrade required');
  });

  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1')
      .update(key + HANDSHAKE_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    const received = [];
    const messageWaiters = [];
    const closeWaiters = [];
    let closed = false;

    const connection = {
      index: connections.length,
      received,
      get closed() {
        return closed;
      },
      send(text) {
        socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
      },
      /** Server-side abrupt drop, i.e. the Service process disappearing. */
      destroy() {
        socket.destroy();
      },
      waitForMessage(predicate = () => true, timeoutMs = connectTimeoutMs) {
        const existing = received.find(predicate);
        if (existing !== undefined) return Promise.resolve(existing);
        return withTimeout(
          new Promise((resolve) => messageWaiters.push({ predicate, resolve })),
          timeoutMs,
          `等待客户端消息超时（连接 #${connection.index}）`,
        );
      },
      waitForClose(timeoutMs = connectTimeoutMs) {
        if (closed) return Promise.resolve();
        return withTimeout(
          new Promise((resolve) => closeWaiters.push(resolve)),
          timeoutMs,
          `等待连接关闭超时（连接 #${connection.index}）`,
        );
      },
    };

    connections.push(connection);
    totalAccepted += 1;

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;

      for (const frame of frames) {
        if (frame.opcode === OPCODE_TEXT) {
          const text = frame.payload.toString('utf8');
          received.push(text);
          for (let i = messageWaiters.length - 1; i >= 0; i--) {
            if (messageWaiters[i].predicate(text)) {
              messageWaiters[i].resolve(text);
              messageWaiters.splice(i, 1);
            }
          }
        } else if (frame.opcode === OPCODE_PING) {
          socket.write(encodeFrame(OPCODE_PONG, frame.payload));
        } else if (frame.opcode === OPCODE_CLOSE) {
          // `respondToClose: false` models a Service that never acknowledges the
          // closing handshake, leaving its side of the TCP connection open.
          if (respondToClose) socket.end(encodeFrame(OPCODE_CLOSE, frame.payload));
        }
      }
    });

    const markClosed = () => {
      if (closed) return;
      closed = true;
      for (const resolve of closeWaiters.splice(0)) resolve();
    };
    socket.on('close', markClosed);
    socket.on('error', markClosed);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const boundPort = server.address().port;

  return {
    port: boundPort,
    url: `ws://127.0.0.1:${boundPort}`,
    connections,
    /** Connections the server has accepted since it started. */
    totalAccepted: () => totalAccepted,
    /** Connections still open right now: the "at most one" assertion reads this. */
    openCount: () => connections.filter((connection) => !connection.closed).length,
    /** Resolve once `count` connections have been accepted, returning the newest. */
    waitForConnections(count, timeoutMs = connectTimeoutMs) {
      if (totalAccepted >= count) return Promise.resolve(connections[count - 1]);
      return new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          if (totalAccepted < count) return;
          clearInterval(poll);
          clearTimeout(guard);
          resolve(connections[count - 1]);
        }, 5);
        const guard = setTimeout(() => {
          clearInterval(poll);
          reject(new Error(`等待第 ${count} 个连接超时（当前 ${totalAccepted}）`));
        }, timeoutMs);
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const connection of connections) {
          // `connection.destroy` closes the socket; the record flips `closed` via
          // the socket's own close handler.
          connection.destroy();
        }
        server.close(() => resolve());
      });
    },
  };
}
