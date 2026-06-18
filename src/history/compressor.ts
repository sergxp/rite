import { estimateTokens } from "../utils/tokens.js";
import { callUtilityBlocking } from "../backends/utility.js";
import type { ConversationHistory } from "./history.js";
import type { RiteConfig } from "../config/types.js";

export async function compressHistoryIfNeeded(
  history: ConversationHistory,
  config: RiteConfig,
  signal?: AbortSignal,
  onStatus?: (status: string) => void
): Promise<void> {
  const formatted = history.getFormatted();
  if (estimateTokens(formatted) <= config.tokenBudget) return;

  const turns = history.getTurns();
  if (turns.length < 2) return;

  const oldestCount = Math.floor(turns.length / 2);
  if (oldestCount === 0) return;

  const oldestFormatted = turns
    .slice(0, oldestCount)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");

  onStatus?.("✻ compressing history…");

  try {
    const summary = await callUtilityBlocking(oldestFormatted, config, {
      systemPrompt:
        "You are a conversation summarizer. Summarize the provided conversation turns into a single compact paragraph preserving key decisions, facts, and context. Be concise.",
      maxTokens: 256,
      signal,
    });
    history.replaceOldest(oldestCount, summary.trim() || "Earlier conversation omitted.");
  } catch {
    history.replaceOldest(oldestCount, "Earlier conversation omitted.");
  }
}
