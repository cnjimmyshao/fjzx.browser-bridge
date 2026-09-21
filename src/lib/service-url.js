/**
 * Service URL: the single persistent configuration of Browser Bridge V1.
 *
 * This module is intentionally pure. It performs no I/O and never touches
 * `chrome.*`, so it can be exercised directly by `node --test`.
 */

/** Key used inside `chrome.storage.local`. This is the only stored key in V1. */
export const SERVICE_URL_STORAGE_KEY = 'serviceUrl';

/** V1 talks to the Service over WebSocket, so only these two schemes are valid. */
const ALLOWED_PROTOCOLS = ['ws:', 'wss:'];

/**
 * Validate and normalize a raw Service URL.
 *
 * An empty input is not an error: it is the explicit "not configured" state,
 * and is reported as `value: ''`.
 *
 * @param {unknown} raw value as typed by the operator, or read back from storage
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateServiceUrl(raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: '' };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Service URL 必须是字符串。' };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: '' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      error: 'Service URL 不是合法 URL，需形如 ws://127.0.0.1:8080 或 wss://host/path。',
    };
  }

  if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
    return {
      ok: false,
      error: `Service URL 的协议必须是 ws: 或 wss:，当前是 ${parsed.protocol}`,
    };
  }

  if (parsed.hostname === '') {
    return { ok: false, error: 'Service URL 缺少主机名。' };
  }

  if (parsed.hash !== '') {
    // `new URL()` accepts fragments but the WebSocket constructor throws on
    // them, so persisting this would store an address that can never connect.
    return {
      ok: false,
      error: 'Service URL 不得包含片段标识（# 之后的部分），WebSocket 不接受该地址。',
    };
  }

  // Store the trimmed operator input rather than a re-serialized URL: Bridge
  // does not reinterpret what the Service configured.
  return { ok: true, value: trimmed };
}
