import type { RiteConfig } from "../config/types.js";
import { callClaudeBlocking } from "./claude.js";
import { callCodexBlocking } from "./codex.js";

export interface UtilityCallOptions {
  systemPrompt?: string;
  maxTokens?: number;
}

function composeCodexPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) return prompt;
  return [
    "System instructions:",
    systemPrompt,
    "",
    "Task:",
    prompt,
  ].join("\n");
}

export async function callUtilityBlocking(
  prompt: string,
  config: RiteConfig,
  options?: UtilityCallOptions
): Promise<string> {
  if (config.utilityBackend === "codex") {
    return callCodexBlocking(composeCodexPrompt(prompt, options?.systemPrompt));
  }

  return callClaudeBlocking(prompt, {
    model: "claude-3-5-haiku-latest",
    maxTokens: options?.maxTokens ?? 1024,
    systemPrompt: options?.systemPrompt,
    apiKey: config.anthropicApiKey,
  });
}
