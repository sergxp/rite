import { SessionStore } from "./store.js"
import { callUtilityBlocking } from "../backends/utility.js"
import type { RiteConfig } from "../config/types.js"
import type { Turn } from "./types.js"

const NAMER_SYSTEM_PROMPT = `You are a session title generator. Your only job is to output a short, descriptive title for a conversation session.

RULES:
- Output ONLY the title. No quotes, no punctuation at the end, no explanation.
- 3–6 words maximum.
- Use title case (capitalize main words).
- Make it specific to what was actually discussed, not generic.
- Examples: "Fix Auth Token Refresh Bug", "Refactor Memory Storage Layer", "Deploy Relay Desk to Azure", "Audit DB Secret Exposure"`

function cleanName(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[.!?]+$/, "")
    .slice(0, 60)
}

/**
 * Generate a short LLM-derived name for a session from its first turn,
 * then persist it. Runs in the background — errors are silently swallowed.
 * onNamed is called with the final name so callers can update in-memory state.
 */
export async function autoNameSession(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  config: RiteConfig,
  onNamed?: (name: string) => void,
): Promise<void> {
  try {
    const prompt = [
      "Generate a short session title (3–6 words, title case) for this conversation turn.",
      "",
      "<user>",
      userMessage.slice(0, 500),
      "</user>",
      "",
      "<assistant>",
      assistantResponse.slice(0, 800),
      "</assistant>",
    ].join("\n")

    const raw = await callUtilityBlocking(prompt, config, {
      systemPrompt: NAMER_SYSTEM_PROMPT,
      maxTokens: 32,
    })

    const name = cleanName(raw)
    if (name) {
      await SessionStore.rename(sessionId, name, process.cwd())
      onNamed?.(name)
    }
  } catch {
    // Best-effort — never crash the UI over a session name.
  }
}

export async function autoNameForkSession(
  sessionId: string,
  turns: Turn[],
  config: RiteConfig,
  onNamed?: (name: string) => void,
): Promise<void> {
  try {
    const recent = turns.slice(-4)
    if (recent.length === 0) return

    const prompt = [
      "Generate a short session title (3–6 words, title case) for a forked branch of this conversation.",
      "Focus on the most recent direction, experiment, or sub-problem.",
      "",
      ...recent.map((t) => [
        `<${t.role}>`,
        t.content.slice(0, 400),
        `</${t.role}>`,
      ].join("\n")),
    ].join("\n")

    const raw = await callUtilityBlocking(prompt, config, {
      systemPrompt: NAMER_SYSTEM_PROMPT,
      maxTokens: 32,
    })

    const name = cleanName(raw)
    if (name) {
      await SessionStore.rename(sessionId, name, process.cwd())
      onNamed?.(name)
    }
  } catch {
    // Best-effort — never crash the UI over a session name.
  }
}
