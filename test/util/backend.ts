import type { BackendFn } from "../../src/backends/index.js";
import type { BackendEvent } from "../../src/backends/types.js";

/**
 * A programmatic scripted backend for in-process tests: yields the given events
 * in order, optionally honouring an abort signal between events. Pair with
 * `setBackendOverride(scriptedBackend([...]))`.
 */
export function scriptedBackend(events: BackendEvent[]): BackendFn {
  return async function* (_prompt, signal) {
    for (const event of events) {
      if (signal?.aborted) return;
      yield event;
    }
  };
}
