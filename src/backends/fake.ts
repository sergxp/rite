import { readFileSync } from "fs";
import type { BackendFn } from "./index.js";
import type { BackendEvent } from "./types.js";

/**
 * A deterministic backend that replays a scripted event stream instead of
 * shelling out to a real CLI. Used as a test seam (see `getBackend`):
 *
 *   - In-process tests call `setBackendOverride(...)` with a programmatic stream.
 *   - Out-of-process / PTY e2e tests set `RITE_FAKE_BACKEND=<file.jsonl>`, where
 *     each line is one JSON-encoded BackendEvent, and this replays it.
 *
 * Keeping the seam in production code (guarded by an env var that is never set in
 * normal use) is what makes the streaming UI testable without a network/LLM.
 */
export function createScriptedBackendFromFile(path: string): BackendFn {
  return async function* scriptedBackend() {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield JSON.parse(trimmed) as BackendEvent;
    }
  };
}
