/**
 * Keeps the Service connection pointed at the persisted Service URL.
 *
 * Chrome delivers `chrome.storage.onChanged` and the result of an asynchronous
 * `chrome.storage.local.get()` on independent schedules. A read that started
 * before an operator saved a new URL can therefore resolve *after* the change
 * event was already applied, and applying it would silently revert the Bridge to
 * the previous endpoint until some other event corrected it.
 *
 * Every application of a configuration carries a revision; a read whose revision
 * is stale by the time it resolves is discarded instead of applied.
 *
 * Both dependencies are injected so the ordering can be exercised directly under
 * `node --test`.
 */

const NOOP_LOGGER = { info: () => {}, warn: () => {} };

export function createServiceConfigSync({ readServiceUrl, applyServiceUrl, logger = NOOP_LOGGER }) {
  if (typeof readServiceUrl !== 'function') {
    throw new TypeError('createServiceConfigSync 需要 readServiceUrl 函数。');
  }
  if (typeof applyServiceUrl !== 'function') {
    throw new TypeError('createServiceConfigSync 需要 applyServiceUrl 函数。');
  }

  let revision = 0;

  return {
    /**
     * A `chrome.storage.onChanged` payload arrived. It is newer than any read
     * already in flight, so it is applied immediately and invalidates them.
     *
     * @param {unknown} newValue
     */
    applyStorageChange(newValue) {
      revision += 1;
      const serviceUrl = typeof newValue === 'string' ? newValue : '';
      logger.info?.(`[bridge] service URL changed; switching connection`);
      applyServiceUrl(serviceUrl);
    },

    /**
     * Read the persisted configuration and apply it, unless a newer change
     * overtook the read while it was pending.
     *
     * @param {string} trigger what caused this sync, for diagnostics
     */
    async sync(trigger = 'sync') {
      const startedAt = revision;

      let serviceUrl;
      try {
        serviceUrl = await readServiceUrl();
      } catch (error) {
        logger.warn?.(`[bridge] ${trigger}: failed to read the service URL`, error);
        return;
      }

      if (startedAt !== revision) {
        logger.info?.(`[bridge] ${trigger}: superseded by a newer configuration change; ignoring`);
        return;
      }

      logger.info?.(
        `[bridge] ${trigger}: service URL ${serviceUrl === '' ? 'not configured' : 'configured'}`,
      );
      applyServiceUrl(serviceUrl);
    },
  };
}
