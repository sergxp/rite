import { readFileSync } from "fs";
import { callUtilityBlocking } from "../backends/utility.js";
import type { MemoryFile } from "../memory/types.js";
import type { RiteConfig } from "../config/types.js";
import { log } from "../utils/logger.js";

export interface DefaultReviewResult {
  passed: boolean;
  feedback: string;
}

// Sentinel appended to the response before review so tool calls are visible inline.
// index.tsx uses this same constant to build the section — single source of truth.
export const TOOL_EVIDENCE_HEADER = "--- Tool calls made during this response ---";

// Test seam (mirrors RITE_FAKE_BACKEND): when RITE_FAKE_REVIEW points to a JSONL
// file of {passed, feedback} verdicts, successive review calls return them in
// order so the correction loop can be driven deterministically without an LLM.
// Never set in normal use.
let _fakeReviewIndex = 0;
function fakeReviewVerdict(): DefaultReviewResult | null {
  const path = process.env.RITE_FAKE_REVIEW;
  if (!path) return null;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    const line = lines[_fakeReviewIndex++];
    if (!line) return { passed: true, feedback: "" };
    const v = JSON.parse(line) as { passed?: unknown; feedback?: unknown };
    return {
      passed: v.passed === true,
      feedback: typeof v.feedback === "string" ? v.feedback : "",
    };
  } catch {
    return { passed: true, feedback: "" };
  }
}

export async function checkMemoryCompliance(
  response: string,
  memories: MemoryFile[],
  config: RiteConfig,
  signal: AbortSignal | undefined,
  recentTurns: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<DefaultReviewResult> {
  if (signal?.aborted) return { passed: true, feedback: "" };
  const faked = fakeReviewVerdict();
  if (faked) return faked;

  const memoriesText = memories.map((m) => m.content).join("\n\n---\n\n");

  // Include recent conversation turns so the reviewer understands context and
  // doesn't flag choices that were reasonable given the flow of the exchange.
  const historySection =
    recentTurns.length > 0
      ? [
          "",
          "Recent conversation context (for understanding — not being reviewed):",
          recentTurns
            .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
            .join("\n\n"),
        ].join("\n")
      : ""

  const prompt = [
    "You are a behavioral compliance reviewer for an AI assistant. Your job is to catch CLEAR, SUBSTANTIVE violations of behavioral guidelines — not to nitpick.",
    "",
    "REVIEW PRINCIPLES:",
    "1. Be charitable. Read the response in the spirit of the conversation, not as an isolated string. If a reasonable person familiar with the context would consider the response acceptable, pass it.",
    "2. Only flag violations that are unambiguous. If a guideline could reasonably be interpreted in more than one way and the response satisfies any reasonable interpretation, pass it.",
    "3. Distinguish behavioral rules (what the assistant must/must not do, style, tone, process) from informational memories (facts, project context, user info, references). Only behavioral rules can be violated. Pass if the memories contain no behavioral rules.",
    "4. Judge by intent, not phrasing. If a guideline says \"verify before claiming\" and the assistant did verify (via tool evidence or by quoting the user's own statement), it has complied even if it didn't say the word \"verified\".",
    "5. Brevity, formatting, and tone rules apply to the response as a whole; minor stylistic blips don't constitute violation. Flag only when the response materially departs from the rule.",
    "6. Conversational responses (acknowledgements, clarifying questions, short answers) should be evaluated as conversation, not held to the same bar as substantive deliverables.",
    "7. If the user explicitly asked for something that conflicts with a guideline (e.g. \"give me a one-line answer\" vs. a verbosity rule), follow the user — that's not a violation.",
    "8. Tool evidence: any call to Read/Grep/Bash/Glob/etc. that touches the relevant file or command counts as verification. Don't require a specific phrasing in the response.",
    "9. When uncertain, pass. Corrections cost more than a missed minor issue; only flag what you are confident is wrong.",
    "",
    `IMPORTANT: The response may include a '${TOOL_EVIDENCE_HEADER}' section listing tool calls made during the turn. Treat these as verification evidence.`,
    "",
    "Behavioral guidelines (memories):",
    memoriesText,
    historySection,
    "",
    "Assistant response to check:",
    response,
    "",
    "Output: JSON only — no prose, no markdown fences. Exact format:",
    '  {"passed": true, "feedback": ""} when there are no clear, substantive violations',
    '  {"passed": false, "feedback": "<for each violation: which guideline, what the assistant did, and what to change>"} only when violations are unambiguous',
  ].join("\n");

  if (signal?.aborted) return { passed: true, feedback: "" };
  const rlog = log.child("review.compliance");
  rlog.debug("prompt.full", { promptLen: prompt.length, prompt });
  let raw: string;
  try {
    raw = await callUtilityBlocking(prompt, config, { maxTokens: 600, signal });
    if (signal?.aborted) return { passed: true, feedback: "" };
  } catch (err) {
    rlog.warn("call.failed", { err });
    return { passed: true, feedback: "" };
  }
  rlog.debug("response.raw", { rawLen: raw.length, raw });

  // Fail open: a reviewer that returns nothing (utility backend unavailable,
  // cancelled, or stubbed) has produced no verdict — that is not a violation.
  // Treating empty/unparseable output as a failure would fabricate correction
  // loops with no actual feedback.
  if (!raw.trim()) return { passed: true, feedback: "" };

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

  // No JSON verdict found. Only treat as a violation when the reviewer
  // explicitly said so; otherwise fail open.
  const lower = raw.toLowerCase();
  if (lower.includes('"passed":false') || lower.includes('"passed": false')) {
    return { passed: false, feedback: raw.trim() };
  }
  return { passed: true, feedback: "" };
}
