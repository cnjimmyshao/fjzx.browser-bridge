import test from 'node:test';
import assert from 'node:assert/strict';

import { WORK_TAB_REASONS, createWorkTabManager } from '../src/lib/work-tab.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the manager's async refresh settle before asserting. */
const settle = () => sleep(5);

const web = (id, url = 'https://example.test/page') => ({ id, url });
const browser = (id, url) => ({ id, url });

/** Minimal `chrome.tabs` stand-in that records listener registrations. */
function createFakeTabs(initialTabs = []) {
  let tabs = [...initialTabs];
  const listeners = { onCreated: [], onRemoved: [], onUpdated: [] };
  const queries = [];

  return {
    api: {
      async query(queryInfo) {
        queries.push(queryInfo);
        return tabs.map((tab) => ({ ...tab }));
      },
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
    },
    queryCount: () => queries.length,
    async addTab(tab) {
      tabs.push(tab);
      for (const fn of listeners.onCreated) fn(tab);
      await settle();
    },
    async removeTab(tabId) {
      tabs = tabs.filter((tab) => tab.id !== tabId);
      for (const fn of listeners.onRemoved) fn(tabId);
      await settle();
    },
    async navigate(tabId, url) {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab));
      for (const fn of listeners.onUpdated) fn(tabId, { url });
      await settle();
    },
    async emitUpdated(tabId, changeInfo) {
      for (const fn of listeners.onUpdated) fn(tabId, changeInfo);
      await settle();
    },
    async emitCreated(tab) {
      for (const fn of listeners.onCreated) fn(tab);
      await settle();
    },
  };
}

function createRecorder() {
  const seen = [];
  return { seen, onChange: (state, trigger) => seen.push({ ...state, trigger }) };
}

test('requires a tabs API with query and the lifecycle events', () => {
  const fake = createFakeTabs().api;
  assert.throws(() => createWorkTabManager({ tabs: undefined }), TypeError);
  assert.throws(() => createWorkTabManager({ tabs: {} }), TypeError);
  assert.throws(() => createWorkTabManager({ tabs: { query: () => {} } }), TypeError);
  assert.throws(
    () => createWorkTabManager({ tabs: { ...fake, onUpdated: undefined } }),
    TypeError,
  );
});

test('binds the only ordinary tab on refresh', async () => {
  const fake = createFakeTabs([browser(1, 'chrome://extensions/'), web(2)]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('test');

  assert.equal(manager.tabId, 2);
  assert.equal(manager.isBound, true);
  assert.equal(manager.reason, null);
  assert.deepEqual(recorder.seen, [{ tabId: 2, reason: null, trigger: 'test' }]);
});

test('an empty profile reports NO_WORK_TAB', async () => {
  const fake = createFakeTabs([]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('test');

  assert.equal(manager.tabId, null);
  assert.equal(manager.reason, WORK_TAB_REASONS.NO_WORK_TAB);
  assert.deepEqual(recorder.seen, [
    { tabId: null, reason: WORK_TAB_REASONS.NO_WORK_TAB, trigger: 'test' },
  ]);
});

test('two ordinary tabs report MULTIPLE_TABS and nothing is bound', async () => {
  const fake = createFakeTabs([web(1, 'https://a.test/'), web(2, 'https://b.test/')]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('test');

  assert.equal(manager.tabId, null);
  assert.equal(manager.reason, WORK_TAB_REASONS.MULTIPLE_TABS);
});

test('a newly created tab triggers re-evaluation', async () => {
  const fake = createFakeTabs([browser(1, 'chrome://newtab/')]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('worker-start');
  assert.equal(manager.reason, WORK_TAB_REASONS.NO_WORK_TAB);

  await fake.addTab(web(2, 'https://a.test/'));
  assert.equal(manager.tabId, 2, '新 Tab 出现后应自动绑定');
});

test('closing the bound tab reports WORK_TAB_CLOSED', async () => {
  const fake = createFakeTabs([web(7)]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('worker-start');
  await fake.removeTab(7);

  assert.equal(manager.tabId, null);
  assert.equal(manager.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
  assert.equal(recorder.seen.at(-1).reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('navigating the bound tab keeps it bound', async () => {
  const fake = createFakeTabs([web(3, 'https://a.test/one')]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('worker-start');
  await fake.navigate(3, 'https://a.test/two');

  assert.equal(manager.tabId, 3, '同 Tab 导航不改变身份');
  assert.equal(
    recorder.seen.filter((entry) => entry.tabId === 3).length,
    1,
    '绑定没有变化时不应重复上报',
  );
});

test('a browser page becoming an ordinary page is picked up', async () => {
  const fake = createFakeTabs([browser(1, 'chrome://newtab/')]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('worker-start');
  assert.equal(manager.tabId, null);

  // A committed navigation: the tab's url changes, which is what onUpdated
  // reports and what the next query will see.
  await fake.navigate(1, 'https://a.test/');
  assert.equal(manager.tabId, 1);
});

test('an update that carries no URL change does not re-query', async () => {
  const fake = createFakeTabs([web(1)]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('worker-start');
  const before = fake.queryCount();

  await fake.emitUpdated(1, { status: 'loading' });
  await fake.emitUpdated(1, { audible: true });
  await fake.emitUpdated(1, undefined);

  assert.equal(fake.queryCount(), before, '只有 URL 变化才可能改变候选资格');
});

test('reports only real transitions', async () => {
  const fake = createFakeTabs([web(1)]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('a');
  await manager.refresh('b');
  await fake.emitCreated({ id: 1, url: 'https://a.test/' });

  assert.equal(recorder.seen.length, 1, '状态未变则不应重复上报');
});

test('a throwing change handler cannot break the manager', async () => {
  const fake = createFakeTabs([web(1)]);
  const manager = createWorkTabManager({
    tabs: fake.api,
    onChange: () => {
      throw new Error('handler exploded');
    },
  });

  await assert.doesNotReject(() => manager.refresh('test'));
  assert.equal(manager.tabId, 1);
});

test('a failing query is logged and leaves the previous state intact', async () => {
  const warnings = [];
  const tabs = {
    query: async () => {
      throw new Error('tabs unavailable');
    },
    onCreated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  };
  const manager = createWorkTabManager({
    tabs,
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });

  await assert.doesNotReject(() => manager.refresh('test'));

  assert.equal(manager.tabId, null);
  assert.equal(warnings.length, 1);
});
