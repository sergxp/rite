import type { RiteConfig } from "../config/types.js"
import { callClaudeCliBlocking } from "./claude.js"

export interface UtilityCallOptions {
  systemPrompt?: string
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Blocking utility call for background LLM work (session naming, memory
 * extraction, history summarization). Claude CLI subprocess — no API key
 * required. noHooks passes a minimal settings file so a SessionStart hook
 * can't inject context that overrides the utility system prompt.
 */
export async function callUtilityBlocking(
  prompt: string,
  _config: RiteConfig,
  options?: UtilityCallOptions,
): Promise<string> {
  // Test seam: when the scripted backend is active, background utility work
  // (naming, extraction, summaries) must not shell out to the real CLI.
  if (process.env.RITE_FAKE_BACKEND) return ""
  return callClaudeCliBlocking(prompt, {
    model: "haiku",
    noHooks: true,
    systemPrompt: options?.systemPrompt,
    signal: options?.signal,
  })
}
