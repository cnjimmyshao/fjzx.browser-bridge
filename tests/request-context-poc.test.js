import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONTEXT_ERROR_CODES,
  TARGET_SCOPES,
  buildCookieHeader,
  buildRequestContext,
  describeCookies,
  describeError,
  isSameOrigin,
  maskCookieHeader,
  mergeCookieSets,
  normalizeTargetUrl,
  normalizeTopLevelSite,
} from '../poc/extension/lib/request-context.js';

/**
 * The request-context POC's pure logic.
 *
 * The module is deliberately free of `chrome.*`: every decision the POC makes
 * about scope, cookie ordering and what may be logged is a function of plain
 * data, so it is exercised here without a browser. The browser APIs themselves
 * are covered by `poc/service/run-poc.mjs`, which drives real Chrome for Testing.
 */

const modulePath = join(import.meta.dirname, '..', 'poc', 'extension', 'lib', 'request-context.js');
const moduleSource = readFileSync(modulePath, 'utf8');

test('the POC logic stays liftable into src/lib (no chrome.* dependency)', () => {
  // The point of the POC is to answer what the browser allows; the code that
  // would ship in `src/lib/request-context.js` must therefore be the same code
  // that was exercised. A `chrome.` reference outside a comment would mean the
  // module can only run inside an extension. Comments are stripped first, since
  // they legitimately talk *about* `chrome.cookies`.
  const withoutComments = moduleSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/chrome\./.test(withoutComments), false);
  const imports = [...withoutComments.matchAll(/^import .*?from '([^']+)';$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, [], '纯逻辑模块不应有 import');
});

test('normalizeTargetUrl accepts http(s) and drops the fragment', () => {
  assert.deepEqual(normalizeTargetUrl('https://example.test/a/b?c=1#frag'), {
    ok: true,
    url: 'https://example.test/a/b?c=1',
  });
  // A fragment is never sent, so two URLs that differ only there are one context.
  assert.deepEqual(normalizeTargetUrl('http://127.0.0.1:8080/x#one'), normalizeTargetUrl('http://127.0.0.1:8080/x#two'));
});

test('normalizeTargetUrl refuses everything that is not an absolute http(s) URL', () => {
  for (const raw of ['', 'media/1', '/media/1', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/plain,x', 'chrome://settings', 42, null, undefined]) {
    const result = normalizeTargetUrl(raw);
    assert.equal(result.ok, false, `${String(raw)} 不应被接受`);
    assert.equal(typeof result.reason, 'string');
  }
});

test('normalizeTargetUrl refuses embedded credentials instead of rewriting them', () => {
  const result = normalizeTargetUrl('https://user:secret@example.test/media');
  assert.equal(result.ok, false);
});

test('isSameOrigin compares origins, never site names', () => {
  assert.equal(isSameOrigin('https://a.test/x', 'https://a.test/y?z'), true);
  assert.equal(isSameOrigin('https://a.test/x', 'https://b.a.test/x'), false);
  assert.equal(isSameOrigin('https://a.test/x', 'http://a.test/x'), false);
  assert.equal(isSameOrigin('https://a.test:443/x', 'https://a.test/y'), true);
  assert.equal(isSameOrigin('not a url', 'https://a.test'), false);
});

test('buildCookieHeader orders longer paths first but keeps the browser order within a path', () => {
  const cookies = [
    { name: 'b', value: '1', path: '/' },
    { name: 'a', value: '2', path: '/deep/path' },
    { name: 'c', value: '3', path: '/deep' },
  ];
  assert.equal(buildCookieHeader(cookies), 'a=2; c=3; b=1');
});

test('buildCookieHeader does not reorder cookies of equal path length', () => {
  // Measured on Chrome for Testing 153: `chrome.cookies.getAll({url})` returns the
  // cookies in the order the browser itself sends them, and there is no creation
  // timestamp in the API to reproduce that order any other way. Sorting by name
  // would change a header the Service is trying to reproduce byte for byte.
  const cookies = [
    { name: 'sid', value: '1', path: '/' },
    { name: 'theme', value: '2', path: '/' },
    { name: 'strict', value: '3', path: '/' },
  ];
  assert.equal(buildCookieHeader(cookies), 'sid=1; theme=2; strict=3');
});

test('normalizeTopLevelSite keeps the origin and nothing else', () => {
  assert.deepEqual(normalizeTopLevelSite('https://top.test/page?x=1#frag'), {
    ok: true,
    topLevelSite: 'https://top.test',
  });
  assert.equal(normalizeTopLevelSite('file:///tmp/x').ok, false);
  assert.equal(normalizeTopLevelSite(undefined).ok, false);
});

test('mergeCookieSets concatenates both partition answers', () => {
  const unpartitioned = [{ name: 'sid' }];
  const partitioned = [{ name: 'part' }];
  assert.deepEqual(mergeCookieSets(unpartitioned, partitioned).map((cookie) => cookie.name), ['sid', 'part']);
  assert.deepEqual(mergeCookieSets(undefined, undefined), []);
});

test('buildCookieHeader is total and never invents a value', () => {
  assert.equal(buildCookieHeader(undefined), '');
  assert.equal(buildCookieHeader([null, {}, { name: '' }, { name: 'ok' }]), 'ok=');
});

test('describeCookies reports metadata and never a value', () => {
  const described = describeCookies([
    {
      name: 'sid',
      value: 'super-secret',
      domain: 'example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      partitionKey: { topLevelSite: 'https://top.test' },
    },
  ]);
  assert.deepEqual(described, [
    {
      name: 'sid',
      domain: 'example.test',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
      partitioned: true,
      topLevelSite: 'https://top.test',
    },
  ]);
  assert.equal(JSON.stringify(described).includes('super-secret'), false);
});

test('maskCookieHeader keeps names and removes every value', () => {
  assert.equal(maskCookieHeader('sid=abc; theme=dark'), 'sid=***; theme=***');
  assert.equal(maskCookieHeader(''), '');
  assert.equal(maskCookieHeader('flag'), 'flag=***');
});

test('buildRequestContext returns only the fields the Service must have', () => {
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1?sign=a',
    scope: TARGET_SCOPES.WORK_TAB_ORIGIN,
    workTabUrl: 'https://cdn.test/feed#top',
    cookies: [
      { name: 'sid', value: 'v1', path: '/', httpOnly: true, sameSite: 'lax' },
      { name: 'theme', value: 'dark', path: '/', httpOnly: false },
    ],
    userAgent: 'UA/1.0',
    userAgentSource: 'work-tab-page',
    observedAt: '2026-01-01T00:00:00.000Z',
    documentReferrer: 'https://other.test/from',
    referrerPolicy: 'strict-origin-when-cross-origin',
    serviceWorkerUserAgent: 'UA/1.0',
  });

  assert.equal(context.cookieHeader, 'sid=v1; theme=dark');
  assert.equal(context.targetOrigin, 'https://cdn.test');
  assert.equal(context.httpOnlyCookieCount, 1);
  assert.equal(context.observedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(context.workTabUrl, 'https://cdn.test/feed#top');
  // `referer` is Bridge's suggestion; the page's own view travels separately so
  // the Service can tell an observed fact from a derived one.
  assert.equal(context.referer, 'https://cdn.test/feed#top');
  assert.equal(context.documentReferrer, 'https://other.test/from');
  assert.equal(context.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.equal('input' in context, false);
});

test('buildRequestContext refuses to invent a work tab URL', () => {
  const context = buildRequestContext({
    targetUrl: 'https://cdn.test/media/1',
    scope: TARGET_SCOPES.TARGET_ONLY,
    workTabUrl: undefined,
    cookies: [],
    userAgent: null,
    userAgentSource: 'extension-service-worker',
    observedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(context.referer, '');
  assert.equal(context.cookieHeader, '');
  assert.equal(context.userAgent, null);
  assert.equal(context.documentReferrer, null);
  assert.equal(context.referrerPolicy, null);
});

test('the POC error codes stay a small, machine-readable set', () => {
  assert.deepEqual(Object.values(CONTEXT_ERROR_CODES).sort(), [
    'CONTEXT_FAILED',
    'INVALID_TARGET_URL',
    'NOT_READY',
    'TARGET_OUT_OF_SCOPE',
  ]);
});

test('describeError survives a value that cannot be described', () => {
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError('plain'), 'plain');
  const hostile = {
    get message() {
      throw new Error('nope');
    },
  };
  assert.equal(typeof describeError(hostile), 'string');
});
