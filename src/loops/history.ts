export const LOOP_HISTORY_MAX_TURNS = 20
// Worst-case injected size: 20 turns × 3000 chars ≈ 60k chars / ~15k tokens per loop run.
// recordLoopTurn appends the assistant's final answer back into s.turns, so successive loop
// runs accumulate in history. If this becomes expensive, tag loop-origin turns and condense them.
export const LOOP_HISTORY_MAX_TURN_CHARS = 3000

// Returns the last N turns, each capped at MAX_TURN_CHARS, as the typed union
// expected by StepContext.conversationHistory / runLoopTui.
// Truncation is head-biased (slice from start of content) — tail detail is silently dropped.
export function buildLoopHistory(
  turns: ReadonlyArray<{ role: string; content: string }>
): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.slice(-LOOP_HISTORY_MAX_TURNS).map((t) => ({
    role: (t.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content:
      t.content.length > LOOP_HISTORY_MAX_TURN_CHARS
        ? t.content.slice(0, LOOP_HISTORY_MAX_TURN_CHARS) + "…"
        : t.content,
  }))
}

// Canonical entry point for composer call sites. Returns the history array and a
// warnEmpty flag — both are always consumed together, so they live here rather than
// being inlined at each call site.
export function prepareLoopHistory(turns: ReadonlyArray<{ role: string; content: string }>): {
  history: Array<{ role: "user" | "assistant"; content: string }>
  warnEmpty: boolean
} {
  const history = buildLoopHistory(turns)
  return { history, warnEmpty: history.length === 0 }
}
