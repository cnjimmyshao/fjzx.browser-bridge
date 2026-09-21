import { createServiceConfigSync } from '../lib/service-config.js';
import { createServiceConnection } from '../lib/service-connection.js';
import { createSettingsStore } from '../lib/settings-store.js';
import { SERVICE_URL_STORAGE_KEY } from '../lib/service-url.js';

/**
 * V1.2 service worker: maintain the single Service WebSocket.
 *
 * It reads the Service URL, connects when one is configured, keeps the
 * connection alive across unintended drops, and follows URL changes. No Job
 * protocol, no Work Tab, no business logic.
 *
 * Note that a Manifest V3 worker is not persistent: Chrome may terminate it when
 * idle, which also drops the socket. Every wake-up re-runs this module and
 * re-dials, so `configSync.sync()` is called both on lifecycle events and at the
 * bottom of this file.
 */

const store = createSettingsStore(chrome.storage.local);

const connection = createServiceConnection({ logger: console });

connection.setMessageHandler((data) => {
  // V1.2 implements no protocol yet. Anything that arrives is deliberately
  // ignored, so unknown text or malformed JSON can never break the Bridge.
  console.debug(
    '[bridge] service message ignored: V1.2 implements no protocol',
    typeof data === 'string' ? data.slice(0, 120) : typeof data,
  );
});

const configSync = createServiceConfigSync({
  readServiceUrl: () => store.readServiceUrl(),
  applyServiceUrl: (serviceUrl) => connection.setUrl(serviceUrl),
  logger: console,
});

// Listeners are registered synchronously: a Manifest V3 worker must have them in
// place before it finishes evaluating.
chrome.runtime.onInstalled.addListener(() => {
  void configSync.sync('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void configSync.sync('onStartup');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[SERVICE_URL_STORAGE_KEY];
  if (!change) return;
  configSync.applyStorageChange(change.newValue);
});

void configSync.sync('worker-start');
