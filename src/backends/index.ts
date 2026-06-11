import type { BackendName } from "../config/types.js"
import type { Backend } from "./types.js"
import { ClaudeBackend } from "./claude.js"

const registry = new Map<BackendName, Backend>()

registry.set("claude", new ClaudeBackend())

export const BackendRegistry = {
  get(name: BackendName): Backend {
    const b = registry.get(name)
    if (!b) throw new Error(`Unknown backend: ${name}`)
    return b
  },

  register(name: BackendName, backend: Backend): void {
    registry.set(name, backend)
  },
}
