import { callUtilityBlocking } from "../backends/utility.js";
import type { MemoryFile } from "../memory/types.js";
import type { RiteConfig } from "../config/types.js";
import { log } from "../utils/logger.js";

const slog = log.child("rule.select");

export interface SelectionResult {
  selected: MemoryFile[];
  rationale: string;
  selectedNames: string[];
}

/**
 * Default-loop pre-agent step: ask the utility LLM which of the candidate
 * memory rules actually apply to the user's current request. The selected
 * subset is what gets injected into the agent prompt AND what the review
 * step later checks against — so a single decision drives both the injected
 * context and the compliance bar.
 *
 * Failure modes (utility unavailable, parse error, empty selection) fall
 * back to returning ALL candidates so behavior is never less safe than the
 * pre-selector flow.
 */
export async function selectApplicableRules(
  userRequest: string,
  candidates: MemoryFile[],
  config: RiteConfig,
  signal: AbortSignal | undefined,
  recentTurns: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<SelectionResult> {
  if (candidates.length === 0) {
    return { selected: [], rationale: "no candidates", selectedNames: [] };
  }
  if (signal?.aborted) {
    return { selected: candidates, rationale: "aborted — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }

  const candidateList = candidates
    .map((m, idx) => {
      // Compact one-liner: name + tier + tags + first non-empty content line.
      // Haiku is plenty smart enough to pick relevant rules from a single
      // descriptive line — bigger summaries inflate the prompt and slow
      // selection (was 13–20s with 8-line summaries) without improving
      // accuracy. Fall back gracefully when fields are missing.
      const tags = (m.frontmatter.tags ?? []).slice(0, 4).join(",");
      const firstLine = ((m.content ?? "").split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 140);
      const meta = tags ? `${m.tier}, tags: ${tags}` : m.tier;
      return `[${idx}] ${m.frontmatter.name} (${meta}) — ${firstLine}`;
    })
    .join("\n");

  const historySection =
    recentTurns.length > 0
      ? [
          "",
          "Recent context (intent only):",
          recentTurns
            .map((t) => `${t.role === "user" ? "U" : "A"}: ${t.content.slice(0, 200)}`)
            .join("\n"),
        ].join("\n")
      : "";

  const prompt = [
    "Pick which behavioral rules apply to the user's CURRENT request. Your output is injected into the agent prompt AND used to grade the response.",
    "Be inclusive when in doubt; exclude rules clearly outside this request's domain.",
    "",
    `Request: ${userRequest}`,
    historySection,
    "",
    `Rules (${candidates.length}):`,
    candidateList,
    "",
    'Output JSON only: {"selected":[<indices>],"rationale":"<one short sentence>"}',
  ].join("\n");

  slog.debug("prompt.full", { promptLen: prompt.length, candidateCount: candidates.length });
  const t0 = Date.now();
  let raw: string;
  try {
    raw = await callUtilityBlocking(prompt, config, { maxTokens: 200, signal });
  } catch (err) {
    slog.warn("call.failed", { err, durationMs: Date.now() - t0 });
    return { selected: candidates, rationale: "utility call failed — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }
  slog.debug("response.raw", { rawLen: raw.length, raw, durationMs: Date.now() - t0 });

  if (!raw.trim()) {
    return { selected: candidates, rationale: "empty response — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { selected: candidates, rationale: "no JSON — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }

  let parsed: { selected?: unknown; rationale?: unknown };
  try {
    parsed = JSON.parse(jsonMatch[0]) as { selected?: unknown; rationale?: unknown };
  } catch {
    return { selected: candidates, rationale: "parse failed — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }

  const indices = Array.isArray(parsed.selected)
    ? parsed.selected.filter((v): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < candidates.length)
    : [];
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";

  // If the model selected nothing, fall back to all candidates rather than
  // shipping an unguarded request — empty selection is more likely a model
  // mistake than a correct verdict that no rule applies.
  if (indices.length === 0) {
    return { selected: candidates, rationale: rationale || "model selected none — falling back to all", selectedNames: candidates.map((m) => m.frontmatter.name) };
  }

  const seen = new Set<number>();
  const selected = indices.filter((i) => (seen.has(i) ? false : (seen.add(i), true))).map((i) => candidates[i]);
  const selectedNames = selected.map((m) => m.frontmatter.name);
  slog.info("selected", { selectedCount: selected.length, candidateCount: candidates.length, durationMs: Date.now() - t0, names: selectedNames, rationale });
  return { selected, rationale, selectedNames };
}
