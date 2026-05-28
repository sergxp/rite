import { renameSession } from "./store.js";
import { callUtilityBlocking } from "../backends/utility.js";
import type { RiteConfig } from "../config/types.js";

const NAMER_SYSTEM_PROMPT = `You are a session title generator. Your only job is to output a short, descriptive title for a conversation session.

RULES:
- Output ONLY the title. No quotes, no punctuation at the end, no explanation.
- 3–6 words maximum.
- Use title case (capitalize main words).
- Make it specific to what was actually discussed, not generic.
- Examples: "Fix Auth Token Refresh Bug", "Refactor Memory Storage Layer", "Deploy Relay Desk to Azure", "Audit DB Secret Exposure"`;

/**
 * Generate a short LLM-derived name for a session from its first turn,
 * then persist it. Runs in the background — errors are silently swallowed.
 */
export async function autoNameSession(
  sessionId: string,
  userMessage: string,
  assistantResponse: string,
  config: RiteConfig
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
    ].join("\n");

    const raw = await callUtilityBlocking(prompt, config, {
      systemPrompt: NAMER_SYSTEM_PROMPT,
      maxTokens: 32,
    });

    const name = raw
      .trim()
      .replace(/^["']|["']$/g, "") // strip surrounding quotes
      .replace(/[.!?]+$/, "")       // strip trailing punctuation
      .slice(0, 60);                // hard cap

    if (name) {
      renameSession(sessionId, name);
    }
  } catch {
    // Best-effort — never crash the REPL over a session name.
  }
}
