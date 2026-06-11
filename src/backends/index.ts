import { callClaude } from "./claude.js"
import { createScriptedBackendFromFile } from "./fake.js"
import type { BackendName } from "../config/types.js"
import type { BackendCallOpts, BackendEvent, BackendFn } from "./types.js"
export type { BackendCallOpts, BackendEvent, BackendFn }

// Test seam — when set, every getBackend() call returns this fn instead of a
// real backend. In-process tests use this to inject a scripted event stream.
let _override: BackendFn | null = null
export function setBackendOverride(fn: BackendFn | null): void {
  _override = fn
}

export function getBackend(name: BackendName): BackendFn {
  if (_override) return _override
  // Out-of-process seam for PTY/e2e tests: replay a scripted JSONL event stream.
  const fakePath = process.env.RITE_FAKE_BACKEND
  if (fakePath) return createScriptedBackendFromFile(fakePath)
  if (name !== "claude") {
    throw new Error(`Backend "${name}" is not available in Rite v2 (claude only)`)
  }
  return callClaude
}
