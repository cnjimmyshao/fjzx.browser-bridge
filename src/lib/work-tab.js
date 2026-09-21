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

/** @param {unknown} url */
function isCandidateUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    return CANDIDATE_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * @param {{id?: unknown, url?: unknown}} tab
 * @returns {boolean}
 */
export function isCandidateTab(tab) {
  return Boolean(tab) && typeof tab.id === 'number' && isCandidateUrl(tab.url);
}

/**
 * Track which tab is bound, and why nothing is bound when nothing is.
 *
 * Ambiguity is never resolved by guessing: two candidates mean MULTIPLE_TABS,
 * not "pick one", because choosing which of two ordinary tabs is *the* Work Tab
 * would require exactly the site knowledge Bridge must not have.
 *
 * `rememberedTabId` is the one piece of durable memory: the last tab Bridge was
 * driving. `applyTabs` decides closure by asking whether that tab is still in the
 * profile at all, which makes the answer independent of which lifecycle event
 * happens to arrive first — including the event that wakes a suspended worker.
 * The synchronous `note*` methods only cover the cases where the event itself
 * carries information the next query cannot recover.
 *
 * @param {{rememberedTabId?: number | null, boundTabWasClosed?: boolean}} [options]
 */
export function createWorkTabTracker(options = {}) {
  const { rememberedTabId: restoredTabId = null, boundTabWasClosed: restoredClosed = false } =
    options;

  let tabId = null;
  let rememberedTabId = typeof restoredTabId === 'number' ? restoredTabId : null;
  let boundTabWasClosed = restoredClosed === true;
  let reason = boundTabWasClosed
    ? WORK_TAB_REASONS.WORK_TAB_CLOSED
    : WORK_TAB_REASONS.NO_WORK_TAB;

  function bind(candidateId) {
    tabId = candidateId;
    rememberedTabId = candidateId;
    boundTabWasClosed = false;
    reason = null;
  }

  function release(newReason) {
    tabId = null;
    rememberedTabId = null;
    reason = newReason;
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
    /** The durable memory, for the manager to persist across suspension. */
    get persisted() {
      return { rememberedTabId, boundTabWasClosed };
    },

    /**
     * Re-evaluate against the current tab list.
     *
     * The result is a pure function of the list plus the remembered tab: 0, 1 or
     * N candidates map to NO_WORK_TAB, a binding, or MULTIPLE_TABS. There is
     * deliberately no hysteresis that would let a previous binding outlive an
     * ambiguous profile — once two ordinary tabs exist, Bridge genuinely cannot
     * tell which one the Service is driving, and saying so is more useful than
     * silently continuing with a stale guess.
     *
     * Navigation inside the bound tab needs no special case: the tab is still the
     * single candidate, so the same tabId is bound again.
     *
     * @param {Array<{id: number, url?: string}>} tabs every tab, not only candidates
     */
    applyTabs(tabs) {
      const all = (Array.isArray(tabs) ? tabs : []).filter(
        (tab) => tab && typeof tab.id === 'number',
      );
      const candidates = all.filter(isCandidateTab);
      const rememberedStillPresent =
        rememberedTabId !== null && all.some((tab) => tab.id === rememberedTabId);

      if (candidates.length === 1) {
        bind(candidates[0].id);
        return;
      }

      tabId = null;

      // A remembered tab that has left the profile entirely was closed. Deriving
      // this from the list rather than from a removal event is what makes the
      // answer independent of event ordering, and it distinguishes a closure from
      // a tab that merely navigated away — still present, just no longer an
      // ordinary page.
      if (rememberedTabId !== null && !rememberedStillPresent) {
        boundTabWasClosed = true;
      }
      rememberedTabId = null;

      if (candidates.length === 0) {
        reason = boundTabWasClosed
          ? WORK_TAB_REASONS.WORK_TAB_CLOSED
          : WORK_TAB_REASONS.NO_WORK_TAB;
        return;
      }

      reason = WORK_TAB_REASONS.MULTIPLE_TABS;
    },

    /**
     * A tab navigated. Called synchronously from `tabs.onUpdated`, because only
     * the event carries the new URL: once the navigation is done the query can no
     * longer tell whether the tab was ever a candidate.
     *
     * @param {number} navigatedTabId
     * @param {unknown} url
     */
    noteNavigated(navigatedTabId, url) {
      if (navigatedTabId !== tabId && navigatedTabId !== rememberedTabId) return;
      if (isCandidateUrl(url)) return;
      // Still in the profile, just no longer an ordinary page: the binding is
      // released, but this is not the Work Tab being closed.
      release(WORK_TAB_REASONS.NO_WORK_TAB);
    },

    /**
     * A tab was closed. Called synchronously from `tabs.onRemoved`.
     *
     * Only a tab that is bound *right now* proves a closure. A remembered-but-
     * unbound id is left to `applyTabs`, which can tell a closure from a
     * navigation by looking at whether the tab is still there.
     *
     * @param {number} removedTabId
     */
    noteRemoved(removedTabId) {
      if (removedTabId !== tabId) return;
      tabId = null;
      rememberedTabId = null;
      boundTabWasClosed = true;
      reason = WORK_TAB_REASONS.WORK_TAB_CLOSED;
    },

    /**
     * A tab was replaced by another tab id (prerendering or Instant). The logical
     * tab was not closed, so its identity is transferred rather than released.
     *
     * @param {number} addedTabId
     * @param {number} removedTabId
     */
    noteReplaced(addedTabId, removedTabId) {
      if (removedTabId !== tabId && removedTabId !== rememberedTabId) return;
      if (tabId === removedTabId) tabId = addedTabId;
      rememberedTabId = addedTabId;
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
 *     read: () => Promise<{rememberedTabId?: number | null, boundTabWasClosed?: boolean} | null>,
 *     write: (state: {rememberedTabId: number | null, boundTabWasClosed: boolean}) => Promise<void>,
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
  /** Writes are chained so an older snapshot can never land after a newer one. */
  let persistChain = Promise.resolve();

  /**
   * Read the memory a previous worker lifetime left behind. Manifest V3 may
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
    tracker = createWorkTabTracker({
      rememberedTabId: previous?.rememberedTabId ?? null,
      boundTabWasClosed: previous?.boundTabWasClosed ?? false,
    });
  })();

  function persist() {
    if (!binding || typeof binding.write !== 'function' || !tracker) return;
    const state = tracker.persisted;
    persistChain = persistChain
      .then(() => binding.write(state))
      .catch((error) => {
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
      // The current state is published and persisted either way: it may already
      // have been changed synchronously by the event that triggered this refresh.
      publish(trigger);
      persist();
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

  /** Run `work` once the restored memory is in place, in event order. */
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
    afterSeed(() => {
      tracker.noteRemoved(removedTabId);
      void refresh('tab-removed');
    });
  });

  tabs.onUpdated.addListener((_tabId, changeInfo) => {
    // Only a URL change can alter candidacy, so status churn is ignored.
    if (!changeInfo || changeInfo.url === undefined) return;
    afterSeed(() => {
      tracker.noteNavigated(_tabId, changeInfo.url);
      void refresh('tab-updated');
    });
  });

  tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    // Prerendering hands a tab's identity to a new id. Chrome fires this instead
    // of the create/remove pair, so the logical tab is not a closure.
    afterSeed(() => {
      tracker.noteReplaced(addedTabId, removedTabId);
      persist();
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
