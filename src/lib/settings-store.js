import { SERVICE_URL_STORAGE_KEY, validateServiceUrl } from './service-url.js';

/**
 * Settings store for the single V1 configuration value.
 *
 * The storage area is injected rather than imported, so this module can run
 * under `node --test` with an in-memory fake; the options page passes
 * `chrome.storage.local`.
 *
 * @param {{get: Function, set: Function}} storageArea a `chrome.storage.StorageArea`-compatible object
 */
export function createSettingsStore(storageArea) {
  if (
    !storageArea ||
    typeof storageArea.get !== 'function' ||
    typeof storageArea.set !== 'function'
  ) {
    throw new TypeError('createSettingsStore 需要一个实现 get/set 的 storage area。');
  }

  return {
    /**
     * Read the configured Service URL.
     *
     * Never writes: an unconfigured profile stays unconfigured, and no implicit
     * default URL is introduced. A corrupted stored value is reported as
     * "not configured" instead of surfacing an invalid URL to the Service.
     *
     * @returns {Promise<string>} the stored URL, or `''` when not configured
     */
    async readServiceUrl() {
      const stored = await storageArea.get(SERVICE_URL_STORAGE_KEY);
      const result = validateServiceUrl(stored?.[SERVICE_URL_STORAGE_KEY]);
      return result.ok ? result.value : '';
    },

    /**
     * Persist the Service URL. An empty value explicitly clears the
     * configuration. Invalid input is rejected and nothing is written.
     *
     * @param {unknown} raw
     * @returns {Promise<{ok: true, value: string} | {ok: false, error: string}>}
     */
    async saveServiceUrl(raw) {
      const result = validateServiceUrl(raw);
      if (!result.ok) {
        return result;
      }
      await storageArea.set({ [SERVICE_URL_STORAGE_KEY]: result.value });
      return result;
    },
  };
}
