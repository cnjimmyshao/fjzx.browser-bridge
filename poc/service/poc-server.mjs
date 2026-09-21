/**
 * POC resource server: a local origin that behaves like a session-protected
 * media host.
 *
 * It exists to make one question falsifiable — "can a Node client, given only
 * the context the extension returned, fetch the same bytes the browser can?"
 * So it enforces exactly three things, each mapping to one piece of context:
 *
 *   1. an `HttpOnly` session cookie (unreadable from page JavaScript),
 *   2. a `Referer` on an allowlist,
 *   3. a non-empty `User-Agent`.
 *
 * A request that fails one of them says which one, and every request is
 * recorded with the *names* of the cookies it carried — never a value — so the
 * evidence file can prove what happened without holding a secret.
 *
 * It also serves a second origin (`localhost` vs `127.0.0.1`) purely so the POC
 * can observe SameSite and partitioned-cookie behaviour, which are browser
 * sending rules rather than storage rules.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const PAYLOAD_BYTES = 64 * 1024;
const MEDIA_PATH = '/media/1';

/**
 * Headers worth recording verbatim: they are what the report's replay table is
 * built from. `cookie` is deliberately absent — the record keeps cookie *names*
 * and nothing else.
 */
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
  'sec-fetch-user',
  'priority',
  'range',
  'origin',
  'user-agent',
  'upgrade-insecure-requests',
];

/** Deterministic bytes: the same payload every run, so digests are comparable. */
function buildPayload(seed) {
  const blocks = [];
  let block = Buffer.from(seed);
  while (blocks.length * 32 < PAYLOAD_BYTES) {
    block = createHash('sha256').update(block).digest();
    blocks.push(block);
  }
  return Buffer.concat(blocks).subarray(0, PAYLOAD_BYTES);
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Never log or store a query string: signed URLs live there. */
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

/**
 * @param {{host?: string, altHost?: string, port?: number}} [options]
 */
export async function startPocServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const altHost = options.altHost ?? 'localhost';
  const sessionToken = randomBytes(16).toString('hex');
  const partitionedToken = randomBytes(8).toString('hex');
  const payload = buildPayload(`browser-bridge-request-context-poc:${sessionToken}`);
  const payloadDigest = sha256Hex(payload);

  /** @type {Array<object>} one record per request, values never included */
  const log = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    const cookies = parseCookies(request.headers.cookie);
    const ua = request.headers['user-agent'];
    const record = {
      at: new Date().toISOString(),
      method: request.method,
      path: url.pathname,
      host: request.headers.host ?? null,
      origin: request.headers.origin ?? null,
      referer: maskUrl(request.headers.referer),
      secFetchSite: request.headers['sec-fetch-site'] ?? null,
      secFetchMode: request.headers['sec-fetch-mode'] ?? null,
      userAgent: typeof ua === 'string' ? ua : null,
      cookieNames: [...cookies.keys()],
      hasSession: equalSecrets(cookies.get('sid') ?? '', sessionToken),
      hasTheme: cookies.has('theme'),
      hasStrict: cookies.has('strict'),
      hasPartitioned: cookies.has('part'),
      range: request.headers.range ?? null,
      // Measured request headers, so the report can quote what Chrome actually
      // sends for a subresource instead of what the documentation implies.
      headers: Object.fromEntries(
        RECORDED_HEADERS.filter((name) => request.headers[name] !== undefined).map((name) => [
          name,
          String(request.headers[name]),
        ]),
      ),
      status: 0,
      bytes: 0,
      note: null,
    };
    log.push(record);

    const finish = (status, body, headers = {}) => {
      record.status = status;
      record.bytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body ?? '');
      response.writeHead(status, {
        'cache-control': 'no-store',
        'x-poc-session': record.hasSession ? 'present' : 'missing',
        'x-poc-referer': record.referer ? 'present' : 'missing',
        'x-poc-user-agent': record.userAgent ? 'present' : 'missing',
        ...headers,
      });
      response.end(body);
    };

    const origin = `http://${host}:${server.address().port}`;
    const altOrigin = `http://${altHost}:${server.address().port}`;

    if (url.pathname === '/' || url.pathname === '/feed') {
      finish(200, feedPage({ origin, altOrigin }), { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    if (url.pathname === '/embed') {
      finish(200, embedPage({ origin, partitionedToken }), { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    if (url.pathname === '/login') {
      // `sid` is HttpOnly on purpose: it is the part of the context that page
      // JavaScript provably cannot reach. `theme` stays readable as a control.
      const setCookie = [
        `sid=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`,
        'theme=dark; SameSite=Lax; Path=/',
        'strict=1; SameSite=Strict; Path=/',
      ];
      finish(200, JSON.stringify({ ok: true, cookieNames: ['sid', 'theme', 'strict'] }), {
        'content-type': 'application/json',
        'set-cookie': setCookie,
      });
      return;
    }

    if (url.pathname === '/login-partitioned') {
      // CHIPS: only meaningful in a third-party context, which is why the
      // `localhost` frame inside a `127.0.0.1` page exists.
      finish(200, JSON.stringify({ ok: true }), {
        'content-type': 'application/json',
        'set-cookie': `part=${partitionedToken}; Partitioned; Secure; SameSite=None; Path=/`,
      });
      return;
    }

    if (url.pathname === MEDIA_PATH) {
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
        'x-poc-digest': payloadDigest,
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

  const port = options.port ?? 0;
  await new Promise((resolve) => server.listen(port, host, resolve));
  const boundPort = server.address().port;

  return {
    port: boundPort,
    origin: `http://${host}:${boundPort}`,
    altOrigin: `http://${altHost}:${boundPort}`,
    feedUrl: `http://${host}:${boundPort}/feed`,
    mediaUrl: `http://${host}:${boundPort}${MEDIA_PATH}`,
    altMediaUrl: `http://${altHost}:${boundPort}${MEDIA_PATH}`,
    sessionToken,
    partitionedToken,
    payloadDigest,
    payloadBytes: payload.length,
    log,
    sha256Hex,
    requestsFor(path) {
      return log.filter((entry) => entry.path === path);
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

function feedPage({ origin, altOrigin }) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Request Context POC — 受 Session 保护的资源</title>
<style>
  body { font: 14px/1.6 system-ui, sans-serif; margin: 24px; max-width: 900px; }
  button { font: inherit; padding: 4px 12px; margin-right: 8px; }
  code, pre { background: #f4f4f4; padding: 2px 4px; }
  dt { font-weight: 600; margin-top: 8px; }
  iframe { width: 100%; height: 120px; border: 1px dashed #999; margin-top: 8px; }
</style>
</head>
<body>
<h1>受 Session 保护的资源（POC）</h1>
<p>这个页面只做三件事：登录（下发 HttpOnly Cookie）、暴露一个受保护资源 URL、以及让浏览器自己去取一次该资源作为对照。</p>

<p>
  <button id="login">登录</button>
  <span id="login-state">anonymous</span>
</p>

<dl>
  <dt>document.cookie（页面 JS 可见）</dt>
  <dd><code id="cookie-visible"></code></dd>
  <dt>媒体 URL（页面/Runtime 发现的资源）</dt>
  <dd><code id="media-url">${origin}${MEDIA_PATH}</code></dd>
</dl>

<p>
  <button id="fetch-same">浏览器同源 fetch 媒体</button>
  <button id="fetch-cross">浏览器跨站 fetch 媒体（SameSite 对照）</button>
</p>
<pre id="same-status">same-origin: 未执行</pre>
<pre id="cross-status">cross-site: 未执行</pre>
<pre id="digest">browser digest: (未执行)</pre>

<h2>第三方 iframe（分区 Cookie / CHIPS 对照）</h2>
<iframe id="embed" src="${altOrigin}/embed"></iframe>

<script>
  const MEDIA = ${JSON.stringify(`${origin}${MEDIA_PATH}`)};
  const ALT_MEDIA = ${JSON.stringify(`${altOrigin}${MEDIA_PATH}`)};

  const render = () => {
    document.getElementById('cookie-visible').textContent = document.cookie || '(empty)';
    document.getElementById('login-state').textContent =
      document.cookie.includes('theme=dark') ? 'logged-in' : 'anonymous';
  };

  const digestOf = async (buffer) => {
    const bytes = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
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
      target.textContent = 'same-origin: HTTP ' + response.status + '，' + buffer.byteLength + ' bytes';
      if (response.ok) {
        document.getElementById('digest').textContent = 'browser digest: ' + (await digestOf(buffer));
      }
    } catch (error) {
      target.textContent = 'same-origin: 失败 ' + error.message;
    }
  });

  document.getElementById('fetch-cross').addEventListener('click', async () => {
    const target = document.getElementById('cross-status');
    try {
      const response = await fetch(ALT_MEDIA, { credentials: 'include' });
      target.textContent = 'cross-site: HTTP ' + response.status + '（CORS 未放行时读取会被拦）';
    } catch (error) {
      target.textContent = 'cross-site: 请求已发出但读取被拦（' + error.message + '）';
    }
  });

  render();
</script>
</body>
</html>`;
}

function embedPage({ origin, partitionedToken }) {
  return `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>第三方 frame</title></head>
<body>
<p>这个 frame 的 origin 是 <code>${origin}</code>，它试图写入一个 <code>Partitioned</code> Cookie。</p>
<pre id="state">running</pre>
<script>
  (async () => {
    const lines = [];
    try {
      const response = await fetch('/login-partitioned', { credentials: 'include' });
      lines.push('login-partitioned: HTTP ' + response.status);
    } catch (error) {
      lines.push('login-partitioned: 失败 ' + error.message);
    }
    lines.push('document.cookie: ' + (document.cookie || '(empty)'));
    lines.push('expected partitioned value: ${partitionedToken}');
    document.getElementById('state').textContent = lines.join('\\n');
  })();
</script>
</body>
</html>`;
}

// `node poc/service/poc-server.mjs` starts a standalone instance for manual
// poking; the POC runner imports the factory instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const instance = await startPocServer();
  console.log(`feed:  ${instance.feedUrl}`);
  console.log(`media: ${instance.mediaUrl}`);
  console.log('Ctrl+C 结束。');
}
