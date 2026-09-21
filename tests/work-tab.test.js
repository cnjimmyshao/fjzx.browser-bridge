import test from 'node:test';
import assert from 'node:assert/strict';

import { WORK_TAB_REASONS, createWorkTabTracker, isCandidateTab } from '../src/lib/work-tab.js';

const web = (id, url = 'https://example.test/page') => ({ id, url });
const browser = (id, url) => ({ id, url });

test('only ordinary web pages are candidates, whatever the host', () => {
  assert.equal(isCandidateTab(web(1, 'http://127.0.0.1:8080/')), true);
  assert.equal(isCandidateTab(web(2, 'https://anything.example/deep/path?q=1')), true);
  // No host inspection: an unknown site is as much a candidate as any other.
  assert.equal(isCandidateTab(web(3, 'https://some.site.never.seen.before/')), true);
});

test('browser surfaces and non-web documents are never candidates', () => {
  const rejected = [
    'chrome://extensions/',
    'chrome://settings/',
    'chrome-extension://abcdefghijklmnop/options/options.html',
    'devtools://devtools/bundled/inspector.html',
    'about:blank',
    'file:///C:/tmp/page.html',
    'ftp://example.test/file',
    'not a url',
  ];
  for (const url of rejected) {
    assert.equal(isCandidateTab(web(1, url)), false, `${url} 不应是候选`);
  }
});

test('a tab whose url is unavailable is not a candidate', () => {
  assert.equal(isCandidateTab({ id: 1 }), false);
  assert.equal(isCandidateTab({ id: 1, url: undefined }), false);
  assert.equal(isCandidateTab({ id: 1, url: 42 }), false);
  assert.equal(isCandidateTab({ url: 'https://example.test/' }), false);
  assert.equal(isCandidateTab({ id: '1', url: 'https://example.test/' }), false);
  assert.equal(isCandidateTab(null), false);
  assert.equal(isCandidateTab(undefined), false);
});

test('an empty profile reports NO_WORK_TAB', () => {
  const tracker = createWorkTabTracker();
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);

  tracker.applyTabs([]);
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.isBound, false);
  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('a profile holding only browser or extension pages reports NO_WORK_TAB', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([
    browser(1, 'chrome://extensions/'),
    browser(2, 'chrome-extension://abcdefghijklmnop/options/options.html'),
    browser(3, 'about:blank'),
  ]);

  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('exactly one ordinary tab is bound', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([browser(1, 'chrome://extensions/'), web(7)]);

  assert.equal(tracker.tabId, 7);
  assert.equal(tracker.isBound, true);
  assert.equal(tracker.reason, null);
});

test('several ordinary tabs report MULTIPLE_TABS and nothing is bound', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(1, 'https://a.test/'), web(2, 'https://b.test/')]);

  assert.equal(tracker.tabId, null, '多候选时不得任选一个');
  assert.equal(tracker.reason, WORK_TAB_REASONS.MULTIPLE_TABS);
});

test('navigation inside the bound tab keeps the binding', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(5, 'https://a.test/start')]);
  assert.equal(tracker.tabId, 5);

  tracker.applyTabs([web(5, 'https://a.test/next?step=2')]);
  assert.equal(tracker.tabId, 5, '同 tabId 内导航不改变身份');
  assert.equal(tracker.reason, null);

  // An unrelated navigation elsewhere must not steal or drop the binding.
  tracker.applyTabs([web(5, 'https://a.test/next?step=3'), browser(6, 'chrome://settings/')]);
  assert.equal(tracker.tabId, 5);
});

test('closing the bound tab reports WORK_TAB_CLOSED', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(9)]);

  tracker.noteRemoved(9);
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);

  // A subsequent evaluation of the now-empty profile keeps the specific reason.
  tracker.applyTabs([]);
  assert.equal(tracker.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('closing an unrelated tab changes nothing', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(3), browser(4, 'chrome://settings/')]);

  tracker.noteRemoved(4);
  assert.equal(tracker.tabId, 3);
  assert.equal(tracker.reason, null);
});

test('the bound tab navigating away from the web releases the binding', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(8, 'https://a.test/')]);

  tracker.applyTabs([browser(8, 'chrome://settings/')]);

  assert.equal(tracker.tabId, null);
  assert.equal(
    tracker.reason,
    WORK_TAB_REASONS.NO_WORK_TAB,
    '导航离开网页不是「被关闭」',
  );
});

test('after a closure, a single new ordinary tab is adopted and the reason clears', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(1)]);
  tracker.noteRemoved(1);

  tracker.applyTabs([web(2)]);
  assert.equal(tracker.tabId, 2);
  assert.equal(tracker.reason, null);
});

test('after a closure, two new ordinary tabs are ambiguous rather than a guess', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(1)]);
  tracker.noteRemoved(1);

  tracker.applyTabs([web(2), web(3)]);
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.MULTIPLE_TABS);
});

test('a second ordinary tab makes the profile ambiguous again', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(4)]);
  assert.equal(tracker.tabId, 4);

  // Bridge cannot tell which of the two the Service is driving, so it stops
  // claiming to know rather than silently keeping a possibly stale binding.
  tracker.applyTabs([web(4), web(5)]);
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.MULTIPLE_TABS);

  // Once the profile is unambiguous again, the surviving tab is adopted.
  tracker.applyTabs([web(5)]);
  assert.equal(tracker.tabId, 5);
  assert.equal(tracker.reason, null);
});

test('applyTabs tolerates a malformed tab list', () => {
  const tracker = createWorkTabTracker();
  assert.doesNotThrow(() => tracker.applyTabs(undefined));
  assert.doesNotThrow(() => tracker.applyTabs(null));
  assert.doesNotThrow(() => tracker.applyTabs([null, {}, { id: 1 }]));
  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('a remembered binding restored after suspension recognises the closure', () => {
  // The worker was suspended while tab 5 was bound, so only the persisted memory
  // survives; the tab is already gone by the time the worker looks again.
  const tracker = createWorkTabTracker({ rememberedTabId: 5 });

  tracker.applyTabs([]);

  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('a restored closed-flag keeps the reason specific on the next evaluation', () => {
  const tracker = createWorkTabTracker({ boundTabWasClosed: true });
  tracker.applyTabs([]);
  assert.equal(tracker.reason, WORK_TAB_REASONS.WORK_TAB_CLOSED);
});

test('a remembered tab that navigated away is not reported as closed', () => {
  const tracker = createWorkTabTracker({ rememberedTabId: 5 });

  // Tab 5 is still in the profile, just no longer an ordinary page.
  tracker.applyTabs([browser(5, 'chrome://settings/')]);

  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('noteNavigated releases the binding only when the tab leaves the web', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(5, 'https://a.test/')]);

  tracker.noteNavigated(5, 'https://a.test/next');
  assert.equal(tracker.tabId, 5, '网页之间导航不释放绑定');

  tracker.noteNavigated(5, 'chrome://settings/');
  assert.equal(tracker.tabId, null);
  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('noteNavigated ignores tabs it is not driving', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(1)]);

  tracker.noteNavigated(2, 'chrome://settings/');

  assert.equal(tracker.tabId, 1);
});

test('noteReplaced transfers the identity instead of reporting a closure', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(5, 'https://a.test/')]);

  tracker.noteReplaced(9, 5);

  assert.equal(tracker.tabId, 9, '身份应转移到新 id');
  assert.equal(tracker.reason, null, '替换不是关闭');
  assert.deepEqual(tracker.persisted, { rememberedTabId: 9, boundTabWasClosed: false });
});

test('noteRemoved only claims a closure when the tab is bound right now', () => {
  const tracker = createWorkTabTracker({ rememberedTabId: 5 });

  // Nothing is bound yet, so a removal cannot prove a closure; that judgement is
  // left to applyTabs, which can see whether the tab is still in the profile.
  tracker.noteRemoved(5);

  assert.equal(tracker.reason, WORK_TAB_REASONS.NO_WORK_TAB);
});

test('persisted state carries the remembered tab, not just the live binding', () => {
  const tracker = createWorkTabTracker();
  tracker.applyTabs([web(3)]);
  assert.deepEqual(tracker.persisted, { rememberedTabId: 3, boundTabWasClosed: false });

  // A tab that leaves the web clears the binding but must not be remembered as a
  // closure waiting to happen.
  tracker.applyTabs([browser(3, 'chrome://settings/')]);
  assert.deepEqual(tracker.persisted, { rememberedTabId: null, boundTabWasClosed: false });
});
