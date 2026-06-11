import type { BackendName } from "../config/types.js"

export interface SessionMemoryRef {
  name: string
  tier: "global" | "workspace" | "project"
  inject: "always" | "semantic" | "never"
}

export type Turn = { role: "user" | "assistant"; content: string }

export interface Session {
  id: string
  name: string | null
  createdAt: string
  updatedAt: string
  workingDir: string
  backend: BackendName
  type: "repl" | "loop"
  turns: Turn[]
  memoriesActive: SessionMemoryRef[]
  claudeSessionId?: string
  loopName?: string
  loopContext?: string
  stepOutputs?: Record<string, string>
}
