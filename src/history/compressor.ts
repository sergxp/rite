import Anthropic from "@anthropic-ai/sdk";
import { estimateTokens } from "../utils/tokens.js";
import type { ConversationHistory } from "../repl/history.js";
import type { RiteConfig } from "../config/types.js";

export async function compressHistoryIfNeeded(
  history: ConversationHistory,
  config: RiteConfig
): Promise<void> {
  const formatted = history.getFormatted();
  if (estimateTokens(formatted) <= config.tokenBudget) return;

  const turns = history.getTurns();
  if (turns.length < 2) return;

  const oldestCount = Math.floor(turns.length / 2);
  if (oldestCount === 0) return;

  const oldestTurns = turns.slice(0, oldestCount);
  const oldestFormatted = oldestTurns
    .map((t) => {
      const label = t.role === "user" ? "User" : "Assistant";
      return `${label}: ${t.content}`;
    })
    .join("\n\n");

  const apiKey =
    process.env.ANTHROPIC_API_KEY || config.anthropicApiKey || "";

  if (!apiKey) {
    history.replaceOldest(oldestCount, "Earlier conversation omitted.");
    return;
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system:
        "You are a conversation summarizer. Summarize the provided conversation turns into a single compact paragraph preserving key decisions, facts, and context. Be concise.",
      messages: [
        {
          role: "user",
          content: oldestFormatted,
        },
      ],
    });

    const summaryText =
      response.content[0]?.type === "text"
        ? response.content[0].text.trim()
        : "Earlier conversation omitted.";

    history.replaceOldest(oldestCount, summaryText);
  } catch {
    history.replaceOldest(oldestCount, "Earlier conversation omitted.");
  }
}
