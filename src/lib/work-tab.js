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
 *
 * @param {{previouslyBoundTabId?: number | null}} [options] the binding restored
 *   from an earlier worker lifetime, so a closure that happens right after the
 *   worker wakes is still recognised. See `createWorkTabManager`.
 */
export function createWorkTabTracker(options = {}) {
  const { previouslyBoundTabId = null } = options;

  let tabId = null;
  /**
   * The last tab this tracker bound, or was told it had bound, whether or not it
   * is still around. `tabs.onRemoved` only carries an id, so recognising that
   * the Work Tab went away requires remembering the id rather than the tab.
   */
  let lastBoundTabId = typeof previouslyBoundTabId === 'number' ? previouslyBoundTabId : null;
  let reason = WORK_TAB_REASONS.NO_WORK_TAB;
  /**
   * Distinguishes "the tab we were bound to was closed" from "there never was
   * one". It survives until something is successfully bound, so a closure stays
   * diagnosable while the profile is momentarily empty.
   */
  let boundTabWasClosed = false;

  function bind(candidateId) {
    tabId = candidateId;
    lastBoundTabId = candidateId;
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
    /** Snapshot for the manager to persist across worker suspension. */
    get persisted() {
      return { tabId, boundTabWasClosed };
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
     * Record that a tab went away. Closing an unrelated tab changes nothing;
     * closing the tab we bound — now or in an earlier worker lifetime — does.
     *
     * @param {number} removedTabId
     */
    handleTabRemoved(removedTabId) {
      if (removedTabId !== tabId && removedTabId !== lastBoundTabId) return;
      tabId = null;
      lastBoundTabId = null;
      boundTabWasClosed = true;
      reason = WORK_TAB_REASONS.WORK_TAB_CLOSED;
    },

    /** Restore the closed-flag that a previous worker lifetime persisted. */
    restoreClosedFlag(wasClosed) {
      if (wasClosed === true) boundTabWasClosed = true;
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
 *   tabs: {
 *     query: Function,
 *     onCreated: object,
 *     onRemoved: object,
 *     onUpdated: object,
 *     onReplaced: object,
 *   },
 *   binding?: {
 *     read: () => Promise<{tabId?: number | null, boundTabWasClosed?: boolean} | null>,
 *     write: (state: {tabId: number | null, boundTabWasClosed: boolean}) => Promise<void>,
 *   },
 *   onChange?: (state: {tabId: number | null, reason: string | null}, trigger: string) => void,
 *   logger?: {info?: Function, warn?: Function},
 * }} options
 */
export function createWorkTabManager({ tabs, binding, onChange, logger = {} }) {
  if (!tabs || typeof tabs.query !== 'function') {
    throw new TypeError('createWorkTabManager 需要一个实现 query 的 tabs API。');
  }
  for (const event of ['onCreated', 'onRemoved', 'onUpdated', 'onReplaced']) {
    if (!tabs[event] || typeof tabs[event].addListener !== 'function') {
      throw new TypeError(`createWorkTabManager 需要 tabs.${event}.addListener。`);
    }
  }

  let tracker = null;
  let lastPublished = null;
  /**
   * `chrome.tabs.query` is asynchronous and overlapping calls may resolve out of
   * order, so a result is applied only if no newer query has started since.
   * Otherwise a slow snapshot could restore state that a newer one already
   * corrected, and nothing would be guaranteed to fix it again.
   */
  let queryRevision = 0;

  /**
   * Read the binding a previous worker lifetime left behind. Manifest V3 may
   * suspend this worker while the Work Tab is still open, so without this the
   * closure of that tab would look like "there was never a tab".
   */
  const seeded = (async () => {
    let previous = null;
    if (binding && typeof binding.read === 'function') {
      try {
        previous = await binding.read();
      } catch (error) {
        logger.warn?.('[bridge] failed to restore the previous work tab binding', error);
      }
    }
    tracker = createWorkTabTracker({ previouslyBoundTabId: previous?.tabId ?? null });
    tracker.restoreClosedFlag(previous?.boundTabWasClosed);
  })();

  function persist() {
    if (!binding || typeof binding.write !== 'function' || !tracker) return;
    const state = tracker.persisted;
    Promise.resolve(binding.write(state)).catch((error) => {
      logger.warn?.('[bridge] failed to persist the work tab binding', error);
    });
  }

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
    await seeded;
    const revision = (queryRevision += 1);

    let found;
    try {
      found = await tabs.query({});
    } catch (error) {
      logger.warn?.('[bridge] failed to list tabs', error);
      // The tracker may already have changed — a tab removal is recorded before
      // this query runs — so the current state is published either way.
      publish(trigger);
      return;
    }

    if (revision !== queryRevision) {
      logger.info?.(`[bridge] ${trigger}: superseded by a newer tab query; ignoring`);
      return;
    }

    tracker.applyTabs(found);
    publish(trigger);
    persist();
  }

  /** Run `work` once the restored binding is in place, in event order. */
  function afterSeed(work) {
    void (async () => {
      await seeded;
      work();
    })();
  }

  tabs.onCreated.addListener(() => {
    void refresh('tab-created');
  });

  tabs.onRemoved.addListener((removedTabId) => {
    // Record the closure before re-querying, so an emptied profile still reports
    // WORK_TAB_CLOSED rather than the generic NO_WORK_TAB.
    afterSeed(() => {
      tracker.handleTabRemoved(removedTabId);
      void refresh('tab-removed');
    });
  });

  tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // Only a URL change can alter candidacy, so status churn is ignored.
    if (!changeInfo || changeInfo.url === undefined) return;
    void refresh('tab-updated');
  });

  tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
    // Prerendering hands a tab's identity to a new tab id. Chrome fires this
    // instead of the create/remove pair, so without listening the manager would
    // keep pointing at an id that no longer exists.
    afterSeed(() => {
      tracker.handleTabRemoved(removedTabId);
      void refresh('tab-replaced');
    });
  });

  return {
    get tabId() {
      return tracker ? tracker.tabId : null;
    },
    get reason() {
      // `null` is a meaningful value here ("a tab is bound"), so it must not be
      // collapsed into the not-ready default by a nullish fallback.
      return tracker ? tracker.reason : WORK_TAB_REASONS.NO_WORK_TAB;
    },
    get isBound() {
      return this.tabId !== null;
    },
    refresh,
  };
}
