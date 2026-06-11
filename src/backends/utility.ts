import type { RiteConfig } from "../config/types.js";
import { callClaudeCliBlocking } from "./claude.js";
import { callCodexBlocking } from "./codex.js";

export interface UtilityCallOptions {
  systemPrompt?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

function composeCodexPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) return prompt;
  return ["System instructions:", systemPrompt, "", "Task:", prompt].join("\n");
}

export async function callUtilityBlocking(
  prompt: string,
  config: RiteConfig,
  options?: UtilityCallOptions
): Promise<string> {
  if (config.utilityBackend === "codex") {
    return callCodexBlocking(composeCodexPrompt(prompt, options?.systemPrompt));
  }

  // Default: claude CLI subprocess — no API key required.
  // noHooks passes a minimal settings file so the SessionStart hook doesn't
  // inject project/Engram context that overrides the extraction system prompt.
  return callClaudeCliBlocking(prompt, {
    model: "haiku",
    noHooks: true,
    systemPrompt: options?.systemPrompt,
    signal: options?.signal,
  });
}
