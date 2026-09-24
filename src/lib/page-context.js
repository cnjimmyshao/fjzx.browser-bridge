/**
 * Page context: what the Work Tab *is*, as one document snapshot.
 *
 * This answers a different question than a request context does. There is no
 * target URL here and nothing site-specific: the object describes the page the
 * Service is looking at, so that a Job's technical result can be tied to the
 * document it came from. Cookies, partition keys and any other target-specific
 * data belong to the request context and must never appear in this object.
 *
 * The fields are the minimum that makes the page identifiable and comparable
 * across Jobs:
 *
 * - `workTabUrl` — the page's own `location.href`, verbatim. A fragment is kept:
 *   it is part of what the page reports, and dropping it would be a lossy
 *   rewrite of a page fact. (The request context reports a fragment-free URL for
 *   a different reason: a fragment is never sent in a request.)
 * - `userAgent` — the *page's* `navigator.userAgent`. A page-level override
 *   (device emulation) changes it without changing the worker's own navigator.
 * - `documentReferrer` — `document.referrer`, i.e. what the page itself says it
 *   came from. `""` is a real value: the document had no referrer.
 * - `documentId` — the browser's identifier for the document the facts were read
 *   from, and the only field that distinguishes a reload of the same URL from
 *   the page it replaced.
 *
 * Kept free of `chrome.*` so `node --test` can drive every decision without a
 * browser; `page-context-source.js` is the layer that talks to the browser.
 */

/**
 * Why Bridge could not report page facts for a Job that did succeed.
 *
 * Both values describe Bridge's own technical situation. Neither is a statement
 * about what the page contains, and neither may be dressed up as a page fact.
 */
export const PAGE_CONTEXT_REASONS = Object.freeze({
  /** The Job finished, but the Work Tab is no longer bound to that tab. */
  WORK_TAB_UNAVAILABLE: 'WORK_TAB_UNAVAILABLE',
  /** The Work Tab is bound, but its document could not be read. */
  PAGE_FACTS_UNAVAILABLE: 'PAGE_FACTS_UNAVAILABLE',
});

/**
 * The page facts every `pageContext` carries. Always all four keys, so a Service
 * never has to tell "absent" from "null".
 */
const FACT_FIELDS = Object.freeze(['workTabUrl', 'userAgent', 'documentReferrer', 'documentId']);

function nullFacts() {
  const facts = {};
  for (const field of FACT_FIELDS) facts[field] = null;
  return facts;
}

/**
 * Assemble a page context from one document's facts.
 *
 * A field the browser did not report is `null` rather than a substitute: Bridge
 * never invents a page fact. The caller is responsible for having read every
 * field in a *single* injection, which is what makes the result one document
 * snapshot instead of a mixture of two.
 *
 * @param {{
 *   workTabUrl?: unknown,
 *   userAgent?: unknown,
 *   documentReferrer?: unknown,
 *   documentId?: unknown,
 * }} facts
 */
export function buildPageContext(facts = {}) {
  return {
    available: true,
    workTabUrl: typeof facts.workTabUrl === 'string' ? facts.workTabUrl : null,
    userAgent: typeof facts.userAgent === 'string' ? facts.userAgent : null,
    // `document.referrer` is `""` when there is none — an answer, not a missing
    // value, so it is passed through as it is.
    documentReferrer:
      typeof facts.documentReferrer === 'string' ? facts.documentReferrer : null,
    documentId: typeof facts.documentId === 'string' ? facts.documentId : null,
  };
}

/**
 * The explicit "no page facts" answer.
 *
 * Every successful RESULT carries a `pageContext`, so the unavailable case is a
 * value rather than a missing key: a Service can tell "Bridge sampled the page
 * and could not read it" from "a Bridge that predates this field", and there is
 * no half-filled object to misread as a page fact.
 *
 * @param {string} reason one of `PAGE_CONTEXT_REASONS`
 */
export function unavailablePageContext(reason) {
  return { available: false, reason, ...nullFacts() };
}
