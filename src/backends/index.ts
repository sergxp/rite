import { callClaude } from "./claude.js";
import { callCodex } from "./codex.js";
import { callCopilot } from "./copilot.js";
import type { BackendName } from "../config/types.js";
import type { BackendEvent } from "./events.js";
export type { BackendEvent };
export type BackendFn = (prompt: string, signal?: AbortSignal) => AsyncIterable<BackendEvent>;

export function getBackend(name: BackendName): BackendFn {
  switch (name) {
    case "claude":
      return callClaude;
    case "codex":
      return callCodex;
    case "copilot":
      return callCopilot;
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown backend: ${_exhaustive}`);
    }
  }
}
