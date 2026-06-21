import type { BackendName } from "../config/types.js"

export interface SessionMemoryRef {
  name: string
  tier: "global" | "workspace" | "project"
  inject: "always" | "semantic" | "never"
}

export type Turn = { role: "user" | "assistant"; content: string }

export type DisplayItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; streaming?: boolean }
  | { kind: "thinking"; content: string; streaming?: boolean }
  | { kind: "tool"; name: string; inputJson: string; result: string; isError: boolean; durationMs: number; running?: boolean }
  | { kind: "system"; content: string }
  | { kind: "loop-step"; loopName: string; stepId: string; stepLabel: string; stepType: string; stepIndex: number; stepTotal: number }

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
  model?: string
  activeLoop?: string
  loopName?: string
  loopContext?: string
  stepOutputs?: Record<string, string>
  groupId?: string
  displayItems?: DisplayItem[]
}
