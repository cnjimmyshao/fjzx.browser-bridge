import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeState } from '../src/lib/bridge-state.js';
import {
  PAGE_CONTEXT_REASONS,
  buildPageContext,
  unavailablePageContext,
} from '../src/lib/page-context.js';
import { createPageContextSource, createPageFactsReader } from '../src/lib/page-context-source.js';
import { createRequestContextSource } from '../src/lib/request-context-source.js';
import { ERROR_CODES } from '../src/lib/protocol.js';

/**
 * The page context: the Work Tab's own facts, carried by every successful RESULT.
 *
 * Three layers, each of which can fail on its own: the pure assembly (no browser),
 * the injectable `chrome.scripting` reader, and the state machine that samples it
 * for a Job. The last one also pins the boundary that matters most here — the
 * ordinary EXECUTE path reads page facts and *never* a target-specific cookie.
 */

const WORK_TAB_URL = 'https://app.test/feed#section';
const PAGE_FACTS = {
  userAgent: 'PageUA/1.0',
  documentReferrer: 'https://app.test/from',
  referrerPolicy: null,
  pageUrl: WORK_TAB_URL,
};

/** `chrome.scripting` stand-in that records every injection it is asked for. */
function createStubScripting({ facts = PAGE_FACTS, documentId = 'doc-1', fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async executeScript(details) {
      calls.push(details);
      if (fail !== null) throw fail;
      return [{ result: facts, ...(documentId === undefined ? {} : { documentId }) }];
    },
  };
}

const createSource = (scripting) => createPageContextSource({ scripting, logger: {} });

// ---------------------------------------------------------------------------
// The pure assembly
// ---------------------------------------------------------------------------

test('a page context carries exactly the four documented page facts', () => {
  const context = buildPageContext({
    workTabUrl: WORK_TAB_URL,
    userAgent: 'UA/1.0',
    documentReferrer: 'https://app.test/from',
    documentId: 'doc-1',
    // Nothing below may travel: cookies and anything target-specific belong to the
    // request context, and a future field on the reader's object must not leak in.
    cookieHeader: 'sid=secret',
    targetUrl: 'https://cdn.test/media/1',
  });

  assert.deepEqual(context, {
    available: true,
    workTabUrl: WORK_TAB_URL,
    userAgent: 'UA/1.0',
    documentReferrer: 'https://app.test/from',
    documentId: 'doc-1',
  });
});

test('an empty referrer is an answer, while anything unreadable stays null', () => {
  const context = buildPageContext({
    workTabUrl: WORK_TAB_URL,
    userAgent: 'UA/1.0',
    // A document opened directly has no referrer; that is not a missing value.
    documentReferrer: '',
    documentId: undefined,
  });

  assert.equal(context.documentReferrer, '');
  assert.equal(context.documentId, null, '浏览器没给 documentId 时不得伪造');
  assert.deepEqual(buildPageContext({}), {
    available: true,
    workTabUrl: null,
    userAgent: null,
    documentReferrer: null,
    documentId: null,
  });
});

test('the unavailable answer names a reason and fakes no fact', () => {
  assert.deepEqual(unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE), {
    available: false,
    reason: 'PAGE_FACTS_UNAVAILABLE',
    workTabUrl: null,
    userAgent: null,
    documentReferrer: null,
    documentId: null,
  });
  assert.deepEqual(Object.values(PAGE_CONTEXT_REASONS), [
    'WORK_TAB_UNAVAILABLE',
    'PAGE_FACTS_UNAVAILABLE',
  ]);
});

// ---------------------------------------------------------------------------
// The injectable browser adapter
// ---------------------------------------------------------------------------

test('one injection reads the main frame of the bound tab, with its document id', async () => {
  const scripting = createStubScripting();
  const reader = createPageFactsReader({ scripting, logger: {} });

  const outcome = await reader.read(42);

  assert.equal(reader.isAvailable(), true);
  assert.deepEqual(scripting.calls, [{ target: { tabId: 42, frameIds: [0] }, func: scripting.calls[0].func }]);
  assert.equal(typeof scripting.calls[0].func, 'function', '页面事实必须由注入的函数读取');
  assert.deepEqual(outcome.facts, { ...PAGE_FACTS, documentId: 'doc-1' });
});

test('a browser that does not report documentId yields null rather than an invention', async () => {
  // Modelled exactly: the injection result simply has no `documentId` key.
  const scripting = { async executeScript() { return [{ result: PAGE_FACTS }]; } };
  const reader = createPageFactsReader({ scripting, logger: {} });

  const outcome = await reader.read(1);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.facts.documentId, null);
});

test('a page that returns nothing usable is a failure, not an empty page fact', async () => {
  const reader = createPageFactsReader({ scripting: createStubScripting({ facts: {} }), logger: {} });

  const outcome = await reader.read(1);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.facts, undefined);
});

test('an injection failure is reported by kind only, never by the API text', async () => {
  const warnings = [];
  const scripting = createStubScripting({
    fail: Object.assign(new Error('Cannot access contents of url https://app.test/feed?sig=SECRET'), {
      name: 'ExtensionManifestError',
    }),
  });
  const reader = createPageFactsReader({ scripting, logger: { warn: (line) => warnings.push(line) } });

  const outcome = await reader.read(7);

  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /ExtensionManifestError/);
  assert.doesNotMatch(outcome.reason, /SECRET|sig=/);
  assert.doesNotMatch(warnings.join('\n'), /SECRET|sig=/);
});

test('without the scripting permission the reader says so instead of throwing', async () => {
  const reader = createPageFactsReader({ scripting: undefined, logger: {} });

  assert.equal(reader.isAvailable(), false);
  const outcome = await reader.read(1);
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /scripting/);
});

test('a page context source never rejects and never invents facts', async () => {
  const working = await createSource(createStubScripting()).read({ tabId: 1 });
  assert.deepEqual(working, {
    available: true,
    workTabUrl: WORK_TAB_URL,
    userAgent: 'PageUA/1.0',
    documentReferrer: 'https://app.test/from',
    documentId: 'doc-1',
  });
  // The fragment is kept: the page reported it, and dropping it would be a lossy
  // rewrite of a page fact.
  assert.match(working.workTabUrl, /#section$/);

  const broken = await createSource(
    createStubScripting({ fail: new Error('frame was removed') }),
  ).read({ tabId: 1 });
  assert.deepEqual(broken, unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE));

  const throwing = await createPageContextSource({
    scripting: {
      executeScript() {
        throw new Error('同步抛出');
      },
    },
    logger: {},
  }).read({ tabId: 1 });
  assert.deepEqual(throwing, unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE));
});

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

function createFakeConnection() {
  const sent = [];
  return {
    sent,
    url: 'ws://service.test',
    send(text) {
      sent.push(JSON.parse(text));
      return true;
    },
  };
}

/**
 * A bridge whose request context is real (stub `chrome.cookies`, so every read is
 * visible) and whose page context is either given or a working stub.
 */
function createHarness({ pageContext, executor = async () => 'ok' } = {}) {
  const connection = createFakeConnection();
  const cookies = [];
  const workTab = { isBound: true, tabId: 5, reason: null };
  const bridge = createBridgeState({
    connection,
    workTab,
    executor: { execute: executor },
    pageContext: pageContext ?? createPageContextSource({ scripting: createStubScripting(), logger: {} }),
    requestContext: createRequestContextSource({
      cookies: {
        async getAll(details) {
          cookies.push(details);
          return [];
        },
        async getAllCookieStores() {
          return [{ id: '0', tabIds: [5] }];
        },
      },
      tabs: { async get() { return { id: 5, url: WORK_TAB_URL }; } },
      scripting: createStubScripting(),
      ancestorBitSupport: () => true,
      logger: {},
    }),
    logger: {},
  });
  return { bridge, connection, cookies };
}

const execute = (jobId) => JSON.stringify({ type: 'EXECUTE', jobId, script: 'return 1;' });

test('every successful RESULT carries the page facts of the tab the Job ran on', async () => {
  const h = createHarness();

  await h.bridge.handleMessage(execute('job-1'));
  await h.bridge.handleMessage(execute('job-2'));

  const results = h.connection.sent.filter((message) => message.type === 'RESULT');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.ok, true);
    assert.equal(result.pageContext.available, true);
    assert.equal(result.pageContext.workTabUrl, WORK_TAB_URL);
    assert.equal(result.pageContext.userAgent, 'PageUA/1.0');
    assert.equal(result.pageContext.documentId, 'doc-1');
  }
});

test('an unreadable page degrades the page context, never the Job', async () => {
  const h = createHarness({
    pageContext: createPageContextSource({ scripting: createStubScripting({ fail: new Error('nope') }), logger: {} }),
  });

  await h.bridge.handleMessage(execute('job-3'));

  const result = h.connection.sent.at(-1);
  assert.equal(result.ok, true, 'Job 真的执行成功了');
  assert.equal(result.data, 'ok');
  assert.deepEqual(result.pageContext, unavailablePageContext(PAGE_CONTEXT_REASONS.PAGE_FACTS_UNAVAILABLE));
});

test('a failed Job carries no page context at all', async () => {
  const h = createHarness({
    executor: async () => {
      throw new Error('boom');
    },
  });

  await h.bridge.handleMessage(execute('job-4'));

  const result = h.connection.sent.at(-1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, ERROR_CODES.SCRIPT_EXECUTION_FAILED);
  assert.equal('pageContext' in result, false, '失败的 RESULT 不附带页面事实');
});

test('an ordinary EXECUTE reads page facts and no target-specific cookie', async () => {
  const h = createHarness();

  await h.bridge.handleMessage(execute('job-5'));

  assert.equal(h.connection.sent.at(-1).pageContext.available, true, '页面事实应已读取');
  assert.deepEqual(h.cookies, [], '不调用 GET_REQUEST_CONTEXT 时不得查询任何 cookie');
});
