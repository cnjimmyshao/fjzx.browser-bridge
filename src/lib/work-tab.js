/**
 * The single Work Tab.
 *
 * A dedicated Browser/Profile normally holds exactly one ordinary business tab,
 * and Bridge binds that tab without ever asking what site it is. It never looks
 * at a hostname, a domain or a platform: the only question it answers is whether
 * a tab is an ordinary web page rather than browser chrome or an extension page.
 *
 * The evaluation is a pure function of the tab list, so the whole lifecycle —
 * zero, one and many candidates, navigation, and the bound tab being closed — is
 * exercised by `node --test` without a browser.
 */

/**
 * Why no Work Tab is bound. These describe Bridge technical state only: they say
 * nothing about page content, and no website business meaning is attached to any
 * of them. Interpreting a page — including deciding that it is refusing to
 * cooperate — is the Service's job, not Bridge's.
 */
export const WORK_TAB_REASONS = Object.freeze({
  NO_WORK_TAB: 'NO_WORK_TAB',
  MULTIPLE_TABS: 'MULTIPLE_TABS',
  WORK_TAB_CLOSED: 'WORK_TAB_CLOSED',
});

/**
 * What counts as an "ordinary web page".
 *
 * This is a statement about the kind of document, not about which site it is:
 * `chrome://`, `chrome-extension://`, `devtools://`, `about:` and friends are
 * browser surfaces, so they can never be a Work Tab. Nothing here inspects the
 * host or the path.
 */
const CANDIDATE_PROTOCOLS = ['http:', 'https:'];

/**
 * @param {{id?: unknown, url?: unknown}} tab
 * @returns {boolean}
 */
export function isCandidateTab(tab) {
  if (!tab || typeof tab.id !== 'number' || typeof tab.url !== 'string') return false;
  try {
    return CANDIDATE_PROTOCOLS.includes(new URL(tab.url).protocol);
  } catch {
    return false;
  }
}

/**
 * Track which tab is bound, and why nothing is bound when nothing is.
 *
 * Ambiguity is never resolved by guessing: two candidates mean MULTIPLE_TABS,
 * not "pick one", because choosing which of two ordinary tabs is *the* Work Tab
 * would require exactly the site knowledge Bridge must not have.
 */
export function createWorkTabTracker() {
  let tabId = null;
  let reason = WORK_TAB_REASONS.NO_WORK_TAB;
  /**
   * Distinguishes "the tab we were bound to was closed" from "there never was
   * one". It survives until something is successfully bound, so a closure stays
   * diagnosable while the profile is momentarily empty.
   */
  let boundTabWasClosed = false;

  function bind(candidateId) {
    tabId = candidateId;
    boundTabWasClosed = false;
    reason = null;
  }

  return {
    get tabId() {
      return tabId;
    },
    /** `null` while a tab is bound; otherwise one of `WORK_TAB_REASONS`. */
    get reason() {
      return reason;
    },
    get isBound() {
      return tabId !== null;
    },

    /**
     * Re-evaluate against the current tab list.
     *
     * The result is a pure function of the list: 0, 1 or N candidates map to
     * NO_WORK_TAB, a binding, or MULTIPLE_TABS. There is deliberately no
     * hysteresis that would let a previous binding outlive an ambiguous profile —
     * once two ordinary tabs exist, Bridge genuinely cannot tell which one the
     * Service is driving, and saying so is more useful than silently continuing
     * with a stale guess.
     *
     * Navigation inside the bound tab needs no special case: the tab is still the
     * single candidate, so the same tabId is bound again.
     *
     * @param {Array<{id: number, url?: string}>} tabs
     */
    applyTabs(tabs) {
      const candidates = (Array.isArray(tabs) ? tabs : []).filter(isCandidateTab);

      if (candidates.length === 1) {
        bind(candidates[0].id);
        return;
      }

      tabId = null;

      if (candidates.length === 0) {
        reason = boundTabWasClosed
          ? WORK_TAB_REASONS.WORK_TAB_CLOSED
          : WORK_TAB_REASONS.NO_WORK_TAB;
        return;
      }

      reason = WORK_TAB_REASONS.MULTIPLE_TABS;
    },

    /**
     * Record that a tab went away. Only the bound tab changes anything; closing
     * some unrelated tab is handled by the next `applyTabs`.
     *
     * @param {number} removedTabId
     */
    handleTabRemoved(removedTabId) {
      if (removedTabId !== tabId) return;
      tabId = null;
      boundTabWasClosed = true;
      reason = WORK_TAB_REASONS.WORK_TAB_CLOSED;
    },
  };
}

/**
 * Keep the tracker fed from a `chrome.tabs`-compatible API.
 *
 * Only tab lifecycle events are observed. Bridge never creates, closes, restores
 * or reorders a tab, and never remembers the Initial URL — the Service owns all
 * of that.
 *
 * @param {{
 *   tabs: {query: Function, onCreated: object, onRemoved: object, onUpdated: object},
 *   onChange?: (state: {tabId: number | null, reason: string | null}, trigger: string) => void,
 *   logger?: {info?: Function, warn?: Function},
 * }} options
 */
export function createWorkTabManager({ tabs, onChange, logger = {} }) {
  if (!tabs || typeof tabs.query !== 'function') {
    throw new TypeError('createWorkTabManager 需要一个实现 query 的 tabs API。');
  }
  for (const event of ['onCreated', 'onRemoved', 'onUpdated']) {
    if (!tabs[event] || typeof tabs[event].addListener !== 'function') {
      throw new TypeError(`createWorkTabManager 需要 tabs.${event}.addListener。`);
    }
  }

  const tracker = createWorkTabTracker();
  let lastPublished = null;

  function publish(trigger) {
    const state = { tabId: tracker.tabId, reason: tracker.reason };
    const signature = `${state.tabId}:${state.reason}`;
    if (signature === lastPublished) return;
    lastPublished = signature;

    logger.info?.(
      state.tabId === null
        ? `[bridge] work tab: none (${state.reason})`
        : `[bridge] work tab: tab ${state.tabId}`,
    );
    try {
      onChange?.(state, trigger);
    } catch (error) {
      logger.warn?.('[bridge] work tab change handler failed', error);
    }
  }

  /** @param {string} trigger */
  async function refresh(trigger) {
    let found;
    try {
      found = await tabs.query({});
    } catch (error) {
      logger.warn?.('[bridge] failed to list tabs', error);
      return;
    }
    tracker.applyTabs(found);
    publish(trigger);
  }

  tabs.onCreated.addListener(() => {
    void refresh('tab-created');
  });

  tabs.onRemoved.addListener((removedTabId) => {
    // Record the closure first so an empty profile still reports WORK_TAB_CLOSED
    // rather than the generic NO_WORK_TAB.
    tracker.handleTabRemoved(removedTabId);
    void refresh('tab-removed');
  });

  tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // Only a URL change can alter candidacy, so status churn is ignored.
    if (!changeInfo || changeInfo.url === undefined) return;
    void refresh('tab-updated');
  });

  return {
    get tabId() {
      return tracker.tabId;
    },
    get reason() {
      return tracker.reason;
    },
    get isBound() {
      return tracker.isBound;
    },
    refresh,
  };
}
