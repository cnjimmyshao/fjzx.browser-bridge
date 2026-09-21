import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

import {
  USER_SCRIPT_WORLD,
  createUserScriptExecutor,
  wrapScript,
} from '../src/lib/user-script-executor.js';

/**
 * A stand-in that behaves the way Chrome for Testing 153 does, which is the whole
 * point of the wrapper: a script that throws and a script that does not compile
 * both come back as a *resolved* call whose `result` is `null`, so the only way
 * to tell them apart from a script that returned `null` is the envelope.
 */
function createSimulatingApi({ sandbox = {} } = {}) {
  const injections = [];
  return {
    injections,
    async execute(injection) {
      injections.push(injection);
      const code = injection.js[0].code;
      const frameId = injection.target?.frameIds?.[0] ?? 0;
      try {
        const result = await runInNewContext(code, { ...sandbox });
        return [{ frameId, documentId: 'doc-1', result }];
      } catch {
        // Exactly what the browser does when the code never runs.
        return [{ frameId, documentId: 'doc-1', result: null }];
      }
    },
  };
}

/** A minimal DOM-ish node so the in-page guard has something to recognise. */
class FakeNode {}

function createExecutor(options = {}) {
  // `??` would treat an explicit `api: undefined` as "not provided" and quietly
  // substitute the simulating API, which is exactly what the test is negating.
  const api = Object.hasOwn(options, 'api') ? options.api : createSimulatingApi(options);
  return { executor: createUserScriptExecutor({ api }), api };
}

/**
 * Values cross a structured clone on the way out of the page, so compare what the
 * wire would carry rather than object identity across realms: a value built inside
 * the `vm` context has that context's prototypes.
 */
const asWire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

test('availability mirrors the API the platform exposes', () => {
  assert.equal(createUserScriptExecutor({ api: undefined }).isAvailable(), false);
  assert.equal(createUserScriptExecutor({ api: {} }).isAvailable(), false);
  assert.equal(createUserScriptExecutor({ api: { getScripts: () => {} } }).isAvailable(), false);
  assert.equal(createUserScriptExecutor({ api: { execute: () => {} } }).isAvailable(), true);
});

test('an unavailable API is reported with the fix an operator needs', async () => {
  const { executor } = createExecutor({ api: undefined });

  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'return 1;', input: null }),
    (error) => {
      assert.match(error.message, /Allow User Scripts/);
      return true;
    },
  );
});

test('the API is resolved per use, so allowing user scripts takes effect at once', async () => {
  // An operator can flip the permission while the worker is already running, so
  // the property must not be captured when the executor is constructed.
  const fake = createSimulatingApi();
  const hadChrome = Object.hasOwn(globalThis, 'chrome');
  const previous = globalThis.chrome;
  globalThis.chrome = {};

  try {
    const executor = createUserScriptExecutor();
    assert.equal(executor.isAvailable(), false);

    globalThis.chrome.userScripts = fake; // the operator allows user scripts
    assert.equal(executor.isAvailable(), true, '开关打开后应立即可用，无需重启 worker');
    assert.equal(await executor.execute({ tabId: 1, script: 'return 7;', input: null }), 7);
  } finally {
    if (hadChrome) globalThis.chrome = previous;
    else delete globalThis.chrome;
  }
});

test('a script value comes back unchanged, including nested structures', async () => {
  // A DOM-ish sandbox, so the script reads the page the way a real one would.
  const api = createSimulatingApi({ sandbox: { document: { title: 'page title' } } });
  const { executor } = createExecutor({ api });

  const value = await executor.execute({
    tabId: 7,
    script: "return { title: document.title, list: [1, 'two', null, false], deep: { a: { b: 1 } } };",
    input: null,
  });

  assert.deepEqual(asWire(value), {
    title: 'page title',
    list: [1, 'two', null, false],
    deep: { a: { b: 1 } },
  });
});

test('every JSON value type survives the round trip', async () => {
  const { executor } = createExecutor();
  const cases = [null, true, false, 0, -1.5, '', 'text', [], [1, [2, [3]]], {}, { a: 1 }];

  for (const expected of cases) {
    const actual = await executor.execute({
      tabId: 1,
      script: `return ${JSON.stringify(expected)};`,
      input: null,
    });
    assert.deepEqual(asWire(actual), expected);
  }
});

test('a script that throws fails the job instead of looking like null', async () => {
  const { executor } = createExecutor();

  // This is the case the API alone cannot express: the call resolves, so only the
  // envelope says whether the script ran to completion.
  await assert.rejects(
    () => executor.execute({ tabId: 1, script: "throw new Error('boom');", input: null }),
    /Error: boom/,
  );
});

test('a script that rejects asynchronously fails the job too', async () => {
  const { executor } = createExecutor();

  await assert.rejects(
    () => executor.execute({ tabId: 1, script: "await null; throw new Error('later');", input: null }),
    /Error: later/,
  );
});

test('a script that does not compile fails the job', async () => {
  const { executor } = createExecutor();

  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'this is not javascript', input: null }),
    /语法错误/,
  );
});

test('returning null is a success, and is still distinguishable from throwing', async () => {
  const { executor } = createExecutor();

  assert.equal(await executor.execute({ tabId: 1, script: 'return null;', input: null }), null);
  assert.equal(await executor.execute({ tabId: 1, script: 'return undefined;', input: null }), null);
  assert.equal(await executor.execute({ tabId: 1, script: '', input: null }), null);

  await assert.rejects(() => executor.execute({ tabId: 1, script: 'throw 1;', input: null }));
});

test('a thrown non-Error value is reported without blowing up', async () => {
  const { executor } = createExecutor();

  await assert.rejects(
    () => executor.execute({ tabId: 1, script: "throw { name: 'Weird', message: 'odd' };", input: null }),
    /Weird: odd/,
  );
  await assert.rejects(() => executor.execute({ tabId: 1, script: 'throw "plain string";', input: null }));
});

test('input reaches the script as its parameter', async () => {
  const { executor } = createExecutor();

  const value = await executor.execute({
    tabId: 1,
    script: 'return { n: input.n, nested: input.nested.deep };',
    input: { n: 42, nested: { deep: 'yes' } },
  });

  assert.deepEqual(asWire(value), { n: 42, nested: 'yes' });
});

test('input defaults to null rather than undefined when omitted', async () => {
  const { executor } = createExecutor();

  assert.equal(await executor.execute({ tabId: 1, script: 'return input === null;', input: undefined }), true);
});

test('input survives characters that used to break injected source', async () => {
  const { executor } = createExecutor();
  const input = { text: 'line\u2028separator\u2029and "quotes" \\ and \n newline' };

  const value = await executor.execute({ tabId: 1, script: 'return input.text;', input });

  assert.equal(value, input.text);
});

test('the script is injected into the USER_SCRIPT world, main frame only', async () => {
  const { executor, api } = createExecutor();

  await executor.execute({ tabId: 42, script: 'return 1;', input: null });

  assert.equal(api.injections.length, 1);
  const [injection] = api.injections;
  assert.equal(injection.world, USER_SCRIPT_WORLD);
  assert.deepEqual(injection.target, { tabId: 42, frameIds: [0] });
  assert.equal(typeof injection.js[0].code, 'string');
  assert.equal(injection.js.length, 1);
});

test('an unsupported return type is refused rather than silently flattened', async () => {
  const api = createSimulatingApi({ sandbox: { Node: FakeNode } });
  const { executor } = createExecutor({ api });

  // A DOM node would otherwise arrive as {} after the structured clone.
  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'return new Node();', input: null }),
    /DOM 节点/,
  );
  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'return () => {};', input: null }),
    /不受支持/,
  );
  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'return globalThis;', input: null }),
    /window/,
  );
});

test('a result without the envelope means the code never ran', async () => {
  const api = { execute: async () => [{ frameId: 0, documentId: 'd', result: null }] };
  const { executor } = createExecutor({ api });

  await assert.rejects(
    () => executor.execute({ tabId: 1, script: 'return 1;', input: null }),
    /没有完成执行/,
  );
});

test('an empty or malformed API result is refused', async () => {
  for (const results of [[], undefined, null, 'nope']) {
    const api = { execute: async () => results };
    const { executor } = createExecutor({ api });
    await assert.rejects(() => executor.execute({ tabId: 1, script: 'return 1;', input: null }));
  }
});

test('a failing API call propagates as a job failure', async () => {
  const api = {
    execute: async () => {
      throw new Error('No tab with id: 999');
    },
  };
  const { executor } = createExecutor({ api });

  await assert.rejects(
    () => executor.execute({ tabId: 999, script: 'return 1;', input: null }),
    /No tab with id: 999/,
  );
});

test('a non-string script is refused before anything is injected', async () => {
  const { executor, api } = createExecutor();

  await assert.rejects(() => executor.execute({ tabId: 1, script: 42, input: null }), /字符串/);
  assert.equal(api.injections.length, 0);
});

test('the wrapper is a function body, so the script may use return and await', () => {
  const code = wrapScript("await null;\nreturn 1;", { a: 1 });

  assert.match(code, /async \(input\) =>/);
  assert.match(code, /await \(async \(\) => \{/);
  assert.match(code, /"a":1/);
});
