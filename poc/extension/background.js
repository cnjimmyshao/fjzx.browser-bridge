/**
 * POC service worker: the smallest extension that can answer one question.
 *
 * "For this target URL, what is the minimal request context a Node client needs
 * to replay the request?" It binds the single ordinary tab exactly the way the
 * real Bridge does (no hostname, no platform), reads cookies through
 * `chrome.cookies` for the target URL only, and reads the *page's* user agent
 * through `chrome.scripting` rather than trusting the service worker's own.
 *
 * This is not the V1 extension and does not touch it: `src/` keeps its frozen
 * four-message protocol. The point of the POC is to find out what the browser
 * actually allows before any protocol is proposed.
 *
 * Security rules the POC obeys so the report can state them as measured facts:
 * nothing is persisted (only the Service URL lives in `storage.local`, as in
 * V1), and no code path logs or stores a cookie value.
 */

import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildRequestContext,
  describeError,
  isSameOrigin,
  maskCookieHeader,
  mergeCookieSets,
  normalizeTargetUrl,
  normalizeTopLevelSite,
} from './lib/request-context.js';

const SERVICE_URL_KEY = 'pocServiceUrl';
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000];

let socket = null;
let socketUrl = null;
let reconnectTimer = null;
let reconnectAttempt = 0;

async function readServiceUrl() {
  const stored = await chrome.storage.local.get(SERVICE_URL_KEY);
  const value = stored?.[SERVICE_URL_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

function clearReconnect() {
  if (reconnectTimer === null) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  clearReconnect();
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void sync();
  }, delay);
}

function closeSocket() {
  const current = socket;
  socket = null;
  socketUrl = null;
  if (!current) return;
  current.onopen = null;
  current.onmessage = null;
  current.onclose = null;
  current.onerror = null;
  try {
    current.close();
  } catch {
    // A socket that is already gone needs no cleanup.
  }
}

function connect(url) {
  if (socket !== null && socketUrl === url && socket.readyState <= WebSocket.OPEN) return;

  closeSocket();

  let next;
  try {
    next = new WebSocket(url);
  } catch (error) {
    console.warn(`[poc] cannot dial the service: ${describeError(error)}`);
    scheduleReconnect();
    return;
  }

  socket = next;
  socketUrl = url;

  next.onopen = () => {
    reconnectAttempt = 0;
    console.info(`[poc] service connected: ${url}`);
  };
  next.onmessage = (event) => {
    void handleFrame(event.data);
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    socketUrl = null;
    scheduleReconnect();
  };
  // An error is always followed by a close, which is where reconnecting happens.
  next.onerror = () => {};
}

async function sync() {
  const url = await readServiceUrl();
  if (url === null) {
    closeSocket();
    clearReconnect();
    return;
  }
  connect(url);
}

function send(message) {
  const current = socket;
  if (current === null || current.readyState !== WebSocket.OPEN) return false;
  try {
    current.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.warn(`[poc] cannot send ${message.type}: ${describeError(error)}`);
    return false;
  }
}

/**
 * The single ordinary tab, resolved fresh on every request.
 *
 * V1 keeps a tracker with events and `storage.session` memory; the POC does not
 * need that machinery to answer its one question, so evaluation is lazy and the
 * rules are the same: `http(s)` only, exactly one candidate.
 */
async function resolveWorkTab() {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter(
    (tab) => typeof tab.id === 'number' && typeof tab.url === 'string' && /^https?:/.test(tab.url),
  );
  if (candidates.length === 0) return { ok: false, reason: 'NO_WORK_TAB' };
  if (candidates.length > 1) return { ok: false, reason: 'MULTIPLE_TABS' };
  return { ok: true, tab: candidates[0] };
}

/**
 * Runs *in the page*, so it must be self-contained: no closure over this file.
 *
 * These are the Work Tab's own answers, and they can differ from what the
 * extension service worker sees:
 *
 * - `navigator.userAgent` reflects a page-level override (device emulation) that
 *   the worker's own navigator knows nothing about;
 * - `document.referrer` / `document.referrerPolicy` are the page's view of the
 *   referrer rules, which is what decides the `Referer` a subresource would
 *   actually carry.
 */
function readPageFactsInPage() {
  const uaData = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    brands: uaData ? uaData.brands.map((brand) => `${brand.brand}/${brand.version}`) : null,
    mobile: uaData ? uaData.mobile : null,
    platform: uaData ? uaData.platform : null,
    documentReferrer: document.referrer,
    referrerPolicy: document.referrerPolicy ?? null,
    pageUrl: location.href,
  };
}

async function readPageFacts(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: readPageFactsInPage,
    });
    const value = results?.[0]?.result;
    if (value && typeof value.userAgent === 'string' && value.userAgent !== '') return value;
    return null;
  } catch (error) {
    // A page the extension may not script yet must not fail the whole request:
    // the service worker's own user agent is a fallback, and the response says
    // which source was used.
    console.warn(`[poc] page facts unavailable: ${describeError(error)}`);
    return null;
  }
}

async function replyStatus(message) {
  const workTab = await resolveWorkTab();
  if (!workTab.ok) {
    send({ type: 'STATUS', requestId: message.requestId ?? null, state: 'NOT_READY', reason: workTab.reason });
    return;
  }
  send({
    type: 'STATUS',
    requestId: message.requestId ?? null,
    state: 'IDLE',
    workTabUrl: workTab.tab.url,
  });
}

function contextFailure(requestId, code, message) {
  return { type: 'REQUEST_CONTEXT', requestId, ok: false, error: { code, message } };
}

async function replyRequestContext(message) {
  const startedAt = Date.now();
  const requestId =
    typeof message.requestId === 'string' && message.requestId !== '' ? message.requestId : null;

  const workTab = await resolveWorkTab();
  if (!workTab.ok) {
    send(contextFailure(requestId, CONTEXT_ERROR_CODES.NOT_READY, `没有唯一 Work Tab（${workTab.reason}）。`));
    return;
  }

  const target = normalizeTargetUrl(message.targetUrl);
  if (!target.ok) {
    send(contextFailure(requestId, CONTEXT_ERROR_CODES.INVALID_TARGET_URL, target.reason));
    return;
  }

  const scope =
    message.scope === TARGET_SCOPES.TARGET_ONLY ? TARGET_SCOPES.TARGET_ONLY : TARGET_SCOPES.WORK_TAB_ORIGIN;

  const workTabUrl = normalizeTargetUrl(workTab.tab.url);
  if (!workTabUrl.ok) {
    send(contextFailure(requestId, CONTEXT_ERROR_CODES.NOT_READY, 'Work Tab 的 URL 不是普通网页。'));
    return;
  }

  if (scope === TARGET_SCOPES.WORK_TAB_ORIGIN && !isSameOrigin(target.url, workTabUrl.url)) {
    send(
      contextFailure(
        requestId,
        CONTEXT_ERROR_CODES.TARGET_OUT_OF_SCOPE,
        `targetUrl 与 Work Tab 不同源（${new URL(target.url).origin} ≠ ${new URL(workTabUrl.url).origin}）；跨源必须显式使用 scope=${TARGET_SCOPES.TARGET_ONLY}。`,
      ),
    );
    return;
  }

  // The one API call that matters: `url` scoping means the browser itself
  // decides which cookies apply, so Bridge never enumerates the cookie jar.
  // Partitioned cookies need a second, partition-named query: measured on
  // Chrome for Testing 153, a `Partitioned` cookie the browser really sends is
  // absent from a `url`-only `getAll`.
  let cookies;
  let partitionedCookies = [];
  let topLevelSite = null;
  if (message.topLevelSite !== undefined && message.topLevelSite !== null) {
    const normalizedSite = normalizeTopLevelSite(message.topLevelSite);
    if (!normalizedSite.ok) {
      send(contextFailure(requestId, CONTEXT_ERROR_CODES.INVALID_TARGET_URL, normalizedSite.reason));
      return;
    }
    topLevelSite = normalizedSite.topLevelSite;
  }

  try {
    const unpartitioned = await chrome.cookies.getAll({ url: target.url });
    if (topLevelSite !== null) {
      partitionedCookies = await chrome.cookies.getAll({
        url: target.url,
        partitionKey: { topLevelSite },
      });
    }
    cookies = mergeCookieSets(unpartitioned, partitionedCookies);
  } catch (error) {
    send(
      contextFailure(requestId, CONTEXT_ERROR_CODES.CONTEXT_FAILED, `chrome.cookies 读取失败：${describeError(error)}`),
    );
    return;
  }

  const pageFacts = await readPageFacts(workTab.tab.id);
  const context = buildRequestContext({
    targetUrl: target.url,
    scope,
    workTabUrl: workTabUrl.url,
    cookies,
    userAgent: pageFacts?.userAgent ?? navigator.userAgent,
    userAgentSource: pageFacts ? 'work-tab-page' : 'extension-service-worker',
    observedAt: new Date().toISOString(),
    documentReferrer: pageFacts?.documentReferrer ?? null,
    referrerPolicy: pageFacts?.referrerPolicy ?? null,
    serviceWorkerUserAgent: navigator.userAgent,
  });

  send({ type: 'REQUEST_CONTEXT', requestId, ok: true, context });

  console.info(
    `[poc] REQUEST_CONTEXT ok in ${Date.now() - startedAt}ms ${JSON.stringify({
      targetOrigin: context.targetOrigin,
      scope: context.scope,
      cookies: context.cookieCount,
      httpOnly: context.httpOnlyCookieCount,
      partitioned: context.partitionedCookieCount,
      partitionQueried: topLevelSite !== null,
      mask: maskCookieHeader(context.cookieHeader),
      userAgentSource: context.userAgentSource,
    })}`,
  );
}

async function handleFrame(raw) {
  if (typeof raw !== 'string') return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[poc] ignoring a frame that is not JSON');
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn('[poc] ignoring a frame that is not an object');
    return;
  }

  if (parsed.type === 'GET_STATUS') {
    await replyStatus(parsed);
    return;
  }
  if (parsed.type === 'GET_REQUEST_CONTEXT') {
    await replyRequestContext(parsed);
    return;
  }
  console.warn(`[poc] ignoring an unknown message type: ${String(parsed.type)}`);
}

// Listeners are registered synchronously: an MV3 worker must have them in place
// before it finishes evaluating.
chrome.runtime.onStartup.addListener(() => {
  void sync();
});
chrome.runtime.onInstalled.addListener(() => {
  void sync();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!(SERVICE_URL_KEY in changes)) return;
  void sync();
});
// Mirrors the real Bridge, which tracks tab lifecycle. It also gives the POC a
// way to wake a suspended worker: a tab event re-runs this module, which
// re-dials the Service at the bottom of the file.
chrome.tabs.onUpdated.addListener(() => {
  void sync();
});

void sync();
