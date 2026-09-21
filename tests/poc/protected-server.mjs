import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

/**
 * A local origin that behaves like a session-protected resource host.
 *
 * The request-context POC needs a target that *cannot* be fetched without the
 * context, or the whole exercise proves nothing. So this server enforces exactly
 * three things, and each one maps to a piece of what Bridge reports:
 *
 *   1. an `HttpOnly` session cookie — the part page JavaScript cannot read;
 *   2. a `Referer` on an allowlist;
 *   3. a non-empty `User-Agent`.
 *
 * It also serves a second origin (`localhost` next to `127.0.0.1`): SameSite and
 * partitioned cookies are rules about *sending*, not about storage, so observing
 * them needs a genuinely cross-site request.
 *
 * Every request is recorded with the **names** of the cookies it carried and never
 * a value, so the evidence file can prove what happened without holding a secret.
 * Not shipped, and not part of the extension.
 */

const MEDIA_PATH = '/media/1';
const PAYLOAD_BYTES = 64 * 1024;

/** Headers worth recording verbatim: what Chrome actually sends for a subresource. */
const RECORDED_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'origin',
  'user-agent',
];

/** Deterministic bytes, so a rerun compares digests. */
function buildPayload(seed) {
  const blocks = [];
  let block = Buffer.from(seed);
  while (blocks.length * 32 < PAYLOAD_BYTES) {
    block = createHash('sha256').update(block).digest();
    blocks.push(block);
  }
  return Buffer.concat(blocks).subarray(0, PAYLOAD_BYTES);
}

/** Never record a query string: signed URLs live there. */
function maskUrl(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search === '' ? '' : '?…'}`;
  } catch {
    return '(unparsable)';
  }
}

function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== 'string' || header === '') return cookies;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== '') cookies.set(name, pair.slice(separator + 1).trim());
  }
  return cookies;
}

function equalSecrets(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** @param {{host?: string, altHost?: string, port?: number}} [options] */
export async function startProtectedServer(options = {}) {
  const { host = '127.0.0.1', altHost = 'localhost', port = 0 } = options;
  const sessionToken = randomBytes(16).toString('hex');
  const partitionedToken = randomBytes(8).toString('hex');
  const payload = buildPayload(`browser-bridge-request-context:${sessionToken}`);
  const payloadDigest = createHash('sha256').update(payload).digest('hex');
  const log = [];

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    const cookies = parseCookies(request.headers.cookie);
    const origin = `http://${host}:${server.address().port}`;
    const altOrigin = `http://${altHost}:${server.address().port}`;
    const record = {
      at: new Date().toISOString(),
      path,
      host: request.headers.host ?? null,
      referer: maskUrl(request.headers.referer),
      secFetchSite: request.headers['sec-fetch-site'] ?? null,
      userAgent: request.headers['user-agent'] ?? null,
      cookieNames: [...cookies.keys()],
      hasSession: equalSecrets(cookies.get('sid') ?? '', sessionToken),
      hasStrict: cookies.has('strict'),
      hasPartitioned: cookies.has('part'),
      range: request.headers.range ?? null,
      headers: Object.fromEntries(
        RECORDED_HEADERS.filter((name) => request.headers[name] !== undefined).map((name) => [
          name,
          String(request.headers[name]),
        ]),
      ),
      status: 0,
      note: null,
    };
    log.push(record);

    const finish = (status, body, headers = {}) => {
      record.status = status;
      response.writeHead(status, { 'cache-control': 'no-store', ...headers });
      response.end(body);
    };

    if (path === '/' || path === '/feed') {
      finish(200, feedPage({ origin, altOrigin }), { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    if (path === '/embed') {
      finish(200, embedPage({ origin, partitionedToken }), { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    if (path === '/login') {
      // `sid` is HttpOnly on purpose: it is the piece of context that page
      // JavaScript provably cannot reach. `theme` stays readable as a control.
      finish(200, JSON.stringify({ ok: true, cookieNames: ['sid', 'theme', 'strict'] }), {
        'content-type': 'application/json',
        'set-cookie': [
          `sid=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`,
          'theme=dark; SameSite=Lax; Path=/',
          'strict=1; SameSite=Strict; Path=/',
        ],
      });
      return;
    }

    if (path === '/login-partitioned') {
      finish(200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json',
        'set-cookie': `part=${partitionedToken}; Partitioned; Secure; SameSite=None; Path=/`,
      });
      return;
    }

    if (path === MEDIA_PATH) {
      if (!record.hasSession) {
        record.note = 'MISSING_SESSION';
        finish(401, JSON.stringify({ error: 'MISSING_SESSION' }), { 'content-type': 'application/json' });
        return;
      }
      if (record.referer === null || !record.referer.startsWith(origin)) {
        record.note = 'BAD_REFERER';
        finish(403, JSON.stringify({ error: 'BAD_REFERER' }), { 'content-type': 'application/json' });
        return;
      }
      if (record.userAgent === null || record.userAgent.trim() === '') {
        record.note = 'MISSING_USER_AGENT';
        finish(403, JSON.stringify({ error: 'MISSING_USER_AGENT' }), { 'content-type': 'application/json' });
        return;
      }

      const headers = {
        'content-type': 'application/octet-stream',
        'accept-ranges': 'bytes',
        etag: `"${payloadDigest}"`,
      };

      const range = /^bytes=(\d*)-(\d*)$/.exec(record.range ?? '');
      if (range) {
        const start = range[1] === '' ? 0 : Number(range[1]);
        const end = range[2] === '' ? payload.length - 1 : Number(range[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= payload.length) {
          record.note = 'RANGE_NOT_SATISFIABLE';
          finish(416, JSON.stringify({ error: 'RANGE_NOT_SATISFIABLE' }), { 'content-type': 'application/json' });
          return;
        }
        const slice = payload.subarray(start, Math.min(end, payload.length - 1) + 1);
        record.note = `RANGE ${start}-${end}`;
        finish(206, slice, {
          ...headers,
          'content-range': `bytes ${start}-${start + slice.length - 1}/${payload.length}`,
        });
        return;
      }

      finish(200, payload, headers);
      return;
    }

    record.note = 'NOT_FOUND';
    finish(404, JSON.stringify({ error: 'NOT_FOUND' }), { 'content-type': 'application/json' });
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const boundPort = server.address().port;

  return {
    port: boundPort,
    origin: `http://${host}:${boundPort}`,
    altOrigin: `http://${altHost}:${boundPort}`,
    urlFor: (path = '/') => `http://${host}:${boundPort}${path}`,
    altUrlFor: (path = '/') => `http://${altHost}:${boundPort}${path}`,
    mediaUrl: `http://${host}:${boundPort}${MEDIA_PATH}`,
    altMediaUrl: `http://${altHost}:${boundPort}${MEDIA_PATH}`,
    sessionToken,
    payloadBytes: payload.length,
    payloadDigest,
    log,
    requestsFor: (path) => log.filter((entry) => entry.path === path),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function feedPage({ origin, altOrigin }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Protected resource</title></head>
  <body>
    <h1>Session-protected resource</h1>
    <button id="login">log in</button>
    <p id="login-state">anonymous</p>
    <p>document.cookie: <code id="cookie-visible"></code></p>
    <p>media URL: <code id="media-url">${origin}${MEDIA_PATH}</code></p>
    <button id="fetch-same">fetch media (same origin)</button>
    <button id="fetch-cross">fetch media (cross-site)</button>
    <pre id="same-status">same-origin: idle</pre>
    <pre id="cross-status">cross-site: idle</pre>
    <pre id="digest">browser digest: (none)</pre>
    <iframe id="embed" src="${altOrigin}/embed" width="400" height="80"></iframe>
    <script>
      const MEDIA = ${JSON.stringify(`${origin}${MEDIA_PATH}`)};
      const ALT_MEDIA = ${JSON.stringify(`${altOrigin}${MEDIA_PATH}`)};

      const render = () => {
        document.getElementById('cookie-visible').textContent = document.cookie || '(empty)';
        document.getElementById('login-state').textContent =
          document.cookie.includes('theme=dark') ? 'logged-in' : 'anonymous';
      };

      document.getElementById('login').addEventListener('click', async () => {
        await fetch('/login', { method: 'POST', credentials: 'same-origin' });
        render();
      });

      document.getElementById('fetch-same').addEventListener('click', async () => {
        const target = document.getElementById('same-status');
        try {
          const response = await fetch(MEDIA, { credentials: 'same-origin' });
          const buffer = await response.arrayBuffer();
          target.textContent = 'same-origin: HTTP ' + response.status + ', ' + buffer.byteLength + ' bytes';
          if (response.ok) {
            const bytes = await crypto.subtle.digest('SHA-256', buffer);
            const digest = [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
            document.getElementById('digest').textContent = 'browser digest: ' + digest;
          }
        } catch (error) {
          target.textContent = 'same-origin: failed ' + error.message;
        }
      });

      document.getElementById('fetch-cross').addEventListener('click', async () => {
        const target = document.getElementById('cross-status');
        try {
          const response = await fetch(ALT_MEDIA, { credentials: 'include' });
          target.textContent = 'cross-site: HTTP ' + response.status;
        } catch (error) {
          target.textContent = 'cross-site: request sent, read blocked (' + error.message + ')';
        }
      });

      render();
    </script>
  </body>
</html>`;
}

function embedPage({ origin, partitionedToken }) {
  return `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Third-party frame</title></head>
  <body>
    <p>frame origin <code>${origin}</code> writes a <code>Partitioned</code> cookie</p>
    <pre id="state">running</pre>
    <script>
      (async () => {
        const lines = [];
        try {
          const response = await fetch('/login-partitioned', { credentials: 'include' });
          lines.push('login-partitioned: HTTP ' + response.status);
        } catch (error) {
          lines.push('login-partitioned: failed ' + error.message);
        }
        lines.push('document.cookie: ' + (document.cookie || '(empty)'));
        lines.push('expected partitioned value: ${partitionedToken}');
        document.getElementById('state').textContent = lines.join('\\n');
      })();
    </script>
  </body>
</html>`;
}
