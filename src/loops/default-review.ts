import { callUtilityBlocking } from "../backends/utility.js";
import type { MemoryFile } from "../memory/types.js";
import type { RiteConfig } from "../config/types.js";

export interface DefaultReviewResult {
  passed: boolean;
  feedback: string;
}

// Sentinel appended to the response before review so tool calls are visible inline.
// index.tsx uses this same constant to build the section — single source of truth.
export const TOOL_EVIDENCE_HEADER = "--- Tool calls made during this response ---";

export async function checkMemoryCompliance(
  response: string,
  memories: MemoryFile[],
  config: RiteConfig,
  signal?: AbortSignal,
): Promise<DefaultReviewResult> {
  const memoriesText = memories.map((m) => m.content).join("\n\n---\n\n");

  const prompt = [
    "You are a behavioral compliance checker for an AI assistant.",
    "Check whether the assistant response followed all BEHAVIORAL guidelines from the memories below.",
    "Only flag violations of explicit rules, instructions, or style guidelines.",
    "Ignore informational memories (facts, references, project context, user descriptions) — those don't require compliance.",
    "If there are no behavioral guidelines in the memories, respond with passed: true.",
    `IMPORTANT: The response may include a '${TOOL_EVIDENCE_HEADER}' section. Treat those tool calls as verification evidence. If the assistant called Read/Grep/Bash/etc. on a file before making claims about it, the verification requirement is satisfied.`,
    "",
    "Memory content:",
    memoriesText,
    "",
    "Assistant response to check:",
    response,
    "",
    'Respond with JSON only — no prose, no markdown fences. Exact format: {"passed": true, "feedback": ""} or {"passed": false, "feedback": "List each violated guideline and what should change"}',
  ].join("\n");

  if (signal?.aborted) return { passed: true, feedback: "" };
  let raw: string;
  try {
    raw = await callUtilityBlocking(prompt, config, { maxTokens: 600, signal });
    if (signal?.aborted) return { passed: true, feedback: "" };
  } catch {
    // If the reviewer fails, don't block the response.
    return { passed: true, feedback: "" };
  }

  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { passed?: unknown; feedback?: unknown };
      return {
        passed: parsed.passed === true,
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      };
    } catch {
      // fall through to heuristic
    }
  }

  const lower = raw.toLowerCase();
  const passed = lower.includes('"passed":true') || lower.includes('"passed": true');
  return { passed, feedback: passed ? "" : raw.trim() };
}
