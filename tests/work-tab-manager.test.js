import test from 'node:test';
import assert from 'node:assert/strict';

import { WORK_TAB_REASONS, createWorkTabManager } from '../src/lib/work-tab.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let the manager's async refresh settle before asserting. */
const settle = () => sleep(5);

const web = (id, url = 'https://example.test/page') => ({ id, url });
const browser = (id, url) => ({ id, url });

/**
 * Minimal `chrome.tabs` stand-in: records listener registrations, and can either
 * answer queries immediately or hand the test control over when each one
 * resolves, so ordering can be exercised deterministically.
 */
function createFakeTabs(initialTabs = [], { manual = false } = {}) {
  let tabs = [...initialTabs];
  let failQueries = false;
  const listeners = { onCreated: [], onRemoved: [], onUpdated: [], onReplaced: [] };
  const queries = [];
  const pending = [];

  const emit = (name, ...args) => {
    for (const fn of listeners[name]) fn(...args);
  };

  return {
    api: {
      query(queryInfo) {
        queries.push(queryInfo);
        if (failQueries) return Promise.reject(new Error('tabs unavailable'));
        const snapshot = tabs.map((tab) => ({ ...tab }));
        if (!manual) return Promise.resolve(snapshot);
        return new Promise((resolve, reject) => pending.push({ resolve, reject, snapshot }));
      },
      onCreated: { addListener: (fn) => listeners.onCreated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.onRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.onUpdated.push(fn) },
      onReplaced: { addListener: (fn) => listeners.onReplaced.push(fn) },
    },
    queryCount: () => queries.length,
    pendingQueryCount: () => pending.length,
    /** Resolve the n-th still-pending query, optionally with an explicit snapshot. */
    resolveQuery(index, snapshot) {
      const entry = pending.splice(index, 1)[0];
      if (!entry) throw new Error(`没有第 ${index} 个待决查询`);
      entry.resolve(snapshot ?? entry.snapshot);
    },
    failQueries(value = true) {
      failQueries = value;
    },
    setTabs(next) {
      tabs = [...next];
    },
    /** The creation event only, without altering the tab list. */
    async emitCreated(tab) {
      emit('onCreated', tab);
      await settle();
    },
    async addTab(tab) {
      tabs.push(tab);
      emit('onCreated', tab);
      await settle();
    },
    async removeTab(tabId) {
      tabs = tabs.filter((tab) => tab.id !== tabId);
      emit('onRemoved', tabId);
      await settle();
    },
    /** The removal event only, as when the worker wakes because a tab closed. */
    async emitRemoved(tabId) {
      emit('onRemoved', tabId);
      await settle();
    },
    async navigate(tabId, url) {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab));
      emit('onUpdated', tabId, { url });
      await settle();
    },
    async emitUpdated(tabId, changeInfo) {
      emit('onUpdated', tabId, changeInfo);
      await settle();
    },
    async replaceTab(addedTab, removedTabId) {
      tabs = tabs.filter((tab) => tab.id !== removedTabId);
      tabs.push(addedTab);
      emit('onReplaced', addedTab.id, removedTabId);
      await settle();
    },
  };
}

function createRecorder() {
  const seen = [];
  return { seen, onChange: (state, trigger) => seen.push({ ...state, trigger }) };
}

function createMemoryBinding(initial = null) {
  const writes = [];
  let stored = initial;
  return {
    writes,
    read: async () => stored,
    write: async (state) => {
      writes.push(state);
      stored = state;
    },
  };
}

test('requires a tabs API with query and the lifecycle events', () => {
  assert.throws(() => createWorkTabManager({ tabs: undefined }), TypeError);
  assert.throws(() => createWorkTabManager({ tabs: {} }), TypeError);
  assert.throws(() => createWorkTabManager({ tabs: { query: () => {} } }), TypeError);
  for (const missing of ['onCreated', 'onRemoved', 'onUpdated', 'onReplaced']) {
    const api = createFakeTabs().api;
    assert.throws(
      () => createWorkTabManager({ tabs: { ...api, [missing]: undefined } }),
      TypeError,
      `${missing} 缺失时应拒绝`,
    );
  }
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
    onReplaced: { addListener: () => {} },
  };
  const manager = createWorkTabManager({
    tabs,
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });

  await assert.doesNotReject(() => manager.refresh('test'));

  assert.equal(manager.tabId, null);
  assert.equal(warnings.length, 1);
});

test('a replaced tab does not leave a stale binding behind', async () => {
  // Prerendering hands the tab identity to a new id and Chrome fires onReplaced
  // instead of a create/remove pair.
  const fake = createFakeTabs([web(1, 'https://a.test/')]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('worker-start');
  assert.equal(manager.tabId, 1);

  await fake.replaceTab(web(2, 'https://a.test/'), 1);

  assert.equal(manager.tabId, 2, '必须指向替换后的 tabId');
});

test('a replacement that leaves no ordinary tab reports WORK_TAB_CLOSED', async () => {
  const fake = createFakeTabs([web(1, 'https://a.test/')]);
  const manager = createWorkTabManager({ tabs: fake.api });

  await manager.refresh('worker-start');
  await fake.replaceTab(browser(2, 'chrome://settings/'), 1);

  assert.equal(manager.tabId, null);
  assert.equal(manager.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('an out-of-order query result is discarded', async () => {
  const fake = createFakeTabs([web(1), web(2)], { manual: true });
  const manager = createWorkTabManager({ tabs: fake.api });

  // Two overlapping refreshes, as rapid tab events would produce.
  const older = manager.refresh('older');
  await settle();
  fake.setTabs([web(1)]); // the second tab closed in between
  const newer = manager.refresh('newer');
  await settle();
  assert.equal(fake.pendingQueryCount(), 2);

  // The newer query answers first, then the older one arrives with a snapshot
  // that is already obsolete.
  fake.resolveQuery(1, [web(1)]);
  fake.resolveQuery(0, [web(1), web(2)]);
  await Promise.all([older, newer]);

  assert.equal(manager.tabId, 1, '陈旧快照不得覆盖更新的结果');
  assert.equal(manager.reason, null);
});

test('a closure is still published when the follow-up query fails', async () => {
  const fake = createFakeTabs([web(5)]);
  const recorder = createRecorder();
  const manager = createWorkTabManager({ tabs: fake.api, onChange: recorder.onChange });

  await manager.refresh('worker-start');
  fake.failQueries();
  await fake.removeTab(5);

  assert.equal(
    recorder.seen.at(-1).reason,
    WORK_TAB_REASONS.WORK_TAB_CLOSED,
    '查询失败不应吞掉已经发生的关闭',
  );
});

test('a binding restored after worker suspension recognises the closure', async () => {
  // The worker was suspended with tab 5 bound; Chrome wakes it to deliver the
  // removal, so its in-memory binding is gone and only the persisted id remains.
  const fake = createFakeTabs([]);
  const binding = createMemoryBinding({ tabId: 5, boundTabWasClosed: false });
  const manager = createWorkTabManager({ tabs: fake.api, binding });

  await fake.emitRemoved(5);

  assert.equal(manager.tabId, null);
  assert.equal(
    manager.reason,
    WORK_TAB_REASONS.WORK_TAB_CLOSED,
    '恢复的绑定必须能识别出被关闭的 Work Tab',
  );
});

test('a restored closed-flag keeps the reason specific', async () => {
  const fake = createFakeTabs([]);
  const binding = createMemoryBinding({ tabId: null, boundTabWasClosed: true });
  const manager = createWorkTabManager({ tabs: fake.api, binding });

  await manager.refresh('worker-start');

  assert.equal(manager.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('the binding is persisted after each evaluation', async () => {
  const fake = createFakeTabs([web(4)]);
  const binding = createMemoryBinding(null);
  const manager = createWorkTabManager({ tabs: fake.api, binding });

  await manager.refresh('worker-start');
  await settle();

  assert.deepEqual(binding.writes.at(-1), { tabId: 4, boundTabWasClosed: false });
});

test('a failing binding read or write never breaks the manager', async () => {
  const fake = createFakeTabs([web(6)]);
  const warnings = [];
  const manager = createWorkTabManager({
    tabs: fake.api,
    binding: {
      read: async () => {
        throw new Error('session storage unavailable');
      },
      write: async () => {
        throw new Error('session storage unavailable');
      },
    },
    logger: { info: () => {}, warn: (...args) => warnings.push(args) },
  });

  await assert.doesNotReject(() => manager.refresh('worker-start'));
  await settle();

  assert.equal(manager.tabId, 6, '持久化失败不应影响内存中的绑定');
  assert.ok(warnings.length >= 2, '读取与写入失败都应记录');
});
