import { callClaude } from "./claude.js";
import { callCodex } from "./codex.js";

export type BackendName = "claude" | "codex";
export type BackendFn = (prompt: string) => AsyncIterable<string>;

export function getBackend(name: BackendName): BackendFn {
  switch (name) {
    case "claude":
      return callClaude;
    case "codex":
      return callCodex;
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown backend: ${_exhaustive}`);
    }
  }
}
