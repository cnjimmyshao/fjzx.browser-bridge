import { createServiceConfigSync } from '../lib/service-config.js';
import { createServiceConnection } from '../lib/service-connection.js';
import { createSettingsStore } from '../lib/settings-store.js';
import { SERVICE_URL_STORAGE_KEY } from '../lib/service-url.js';
import { createWorkTabManager } from '../lib/work-tab.js';

/**
 * V1.2/V1.3 service worker: maintain the single Service WebSocket and bind the
 * single Work Tab.
 *
 * V1.3 only tracks *which* tab is the Work Tab, and why none is bound when none
 * is. It executes nothing: the Job protocol and USER_SCRIPT execution arrive in
 * later issues.
 *
 * Note that a Manifest V3 worker is not persistent: Chrome may terminate it when
 * idle, which also drops the socket. Every wake-up re-runs this module and
 * re-dials, so `configSync.sync()` is called both on lifecycle events and at the
 * bottom of this file.
 */

const store = createSettingsStore(chrome.storage.local);

const connection = createServiceConnection({ logger: console });

connection.setMessageHandler((data) => {
  // V1.3 implements no protocol yet. Anything that arrives is deliberately
  // ignored, so unknown text or malformed JSON can never break the Bridge.
  console.debug(
    '[bridge] service message ignored: V1.3 implements no protocol',
    typeof data === 'string' ? data.slice(0, 120) : typeof data,
  );
});

const configSync = createServiceConfigSync({
  readServiceUrl: () => store.readServiceUrl(),
  applyServiceUrl: (serviceUrl) => connection.setUrl(serviceUrl),
  logger: console,
});

const WORK_TAB_BINDING_KEY = 'workTabBinding';

/**
 * Remember which tab Bridge was driving across a worker suspension.
 *
 * Chrome suspends this worker whenever it goes idle, which discards module
 * state; without a persisted binding, closing the Work Tab right after a wake
 * would look like "there was never a tab" instead of WORK_TAB_CLOSED.
 * `storage.session` is in-memory for the browser session, so the Service URL
 * stays the only *persistent* configuration.
 */
function createWorkTabBinding() {
  const area = chrome.storage?.session;
  if (!area) return undefined;
  return {
    async read() {
      const stored = await area.get(WORK_TAB_BINDING_KEY);
      const value = stored?.[WORK_TAB_BINDING_KEY];
      return value && typeof value === 'object' ? value : null;
    },
    async write(state) {
      await area.set({ [WORK_TAB_BINDING_KEY]: state });
    },
  };
}

// Exposed for later issues; V1.3 only keeps it current and logs transitions.
const workTab = createWorkTabManager({
  tabs: chrome.tabs,
  binding: createWorkTabBinding(),
  logger: console,
});

// Listeners are registered synchronously: a Manifest V3 worker must have them in
// place before it finishes evaluating.
chrome.runtime.onInstalled.addListener(() => {
  void configSync.sync('onInstalled');
  void workTab.refresh('onInstalled');
});

chrome.runtime.onStartup.addListener(() => {
  void configSync.sync('onStartup');
  void workTab.refresh('onStartup');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const change = changes[SERVICE_URL_STORAGE_KEY];
  if (!change) return;
  configSync.applyStorageChange(change.newValue);
});

void configSync.sync('worker-start');
// Evaluated before the tab listeners can fire, so the initial binding is in
// place as soon as the worker is up.
void workTab.refresh('worker-start');
