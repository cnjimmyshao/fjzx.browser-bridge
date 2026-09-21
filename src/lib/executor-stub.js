/**
 * Placeholder executor for V1.4.
 *
 * It performs no page work at all. It exists so the protocol and the state
 * machine can be exercised end to end before real execution lands; the next issue
 * replaces this one dependency and nothing else.
 *
 * The small delay is deliberate: with an instantaneous stub the RUNNING state
 * would be unobservable from outside, which makes a manual POC harder to trust.
 */

export const DEFAULT_STUB_DELAY_MS = 50;

/**
 * @param {{delayMs?: number, setTimer?: typeof setTimeout}} [options]
 */
export function createExecutorStub(options = {}) {
  const { delayMs = DEFAULT_STUB_DELAY_MS, setTimer = setTimeout } = options;

  return {
    /**
     * @param {{tabId: number, script: string, input: unknown}} job
     * @returns {Promise<null>} always JSON-compatible, never page-derived
     */
    async execute() {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimer(resolve, delayMs));
      }
      return null;
    },
  };
}
