import { createBridgeState } from '../lib/bridge-state.js';
import { createExecutorStub } from '../lib/executor-stub.js';
import { createServiceConfigSync } from '../lib/service-config.js';
import { createServiceConnection } from '../lib/service-connection.js';
import { createSettingsStore } from '../lib/settings-store.js';
import { SERVICE_URL_STORAGE_KEY } from '../lib/service-url.js';
import { createWorkTabManager } from '../lib/work-tab.js';

/**
 * V1.2-V1.4 service worker: keep the Service WebSocket, bind the Work Tab, and
 * run the one Job the Service hands over.
 *
 * Execution is still a stub: V1.4 defines the protocol and the state machine, and
 * the next issue replaces only the executor.
 *
 * Note that a Manifest V3 worker is not persistent: Chrome may terminate it when
 * idle, which also drops the socket. Every wake-up re-runs this module and
 * re-dials, so `configSync.sync()` is called both on lifecycle events and at the
 * bottom of this file.
 */

const store = createSettingsStore(chrome.storage.local);

const connection = createServiceConnection({ logger: console });

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

const workTab = createWorkTabManager({
  tabs: chrome.tabs,
  binding: createWorkTabBinding(),
  logger: console,
});

const bridge = createBridgeState({
  connection,
  workTab,
  executor: createExecutorStub(),
  logger: console,
});

// Started before the listeners below so the initial binding is in place as soon
// as the worker is up. `settled()` is what inbound frames wait on.
void workTab.refresh('worker-start');

connection.setMessageHandler((data) => {
  // Wait for any tab evaluation still in flight before answering. Without this a
  // frame can be handled while a stale binding is still being reported: before
  // the first evaluation, or during the query that a newly created second tab
  // just triggered, where a Job would run against an already-ambiguous profile.
  //
  // The endpoint is captured now, not after the wait: the operator may repoint
  // the Service URL while a frame is queued, and that frame belongs to the
  // Service that sent it, not to whoever is connected afterwards.
  const deliveredOn = connection.url;
  void workTab
    .settled()
    .then(() => bridge.handleMessage(data, { deliveredOn }))
    .catch((error) => {
      // `handleMessage` already absorbs everything; this only guarantees a
      // surprise can never surface as an unhandled rejection in the worker.
      console.warn('[bridge] inbound message handling failed', error);
    });
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
