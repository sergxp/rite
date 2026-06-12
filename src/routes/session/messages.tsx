import { createMemo, For, Show, Switch, Match } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSessionStore, type DisplayItem } from "../../context/session-store"

interface MessagesProps {
  sessionId: string
  height: number
  width: number
}

// Content hangs two columns under its speaker label, so each turn reads as a
// labeled block rather than an undifferentiated wall of text.
const CONTENT_INDENT = 2

// Wheel sensitivity: lines scrolled per notch. opentui's default accel moves a
// single line per notch, which feels sluggish in a long transcript. A constant
// multiplier scrolls several lines per notch while staying predictable (unlike
// velocity-based acceleration, which only kicks in on fast streaks).
const SCROLL_LINES_PER_NOTCH = 3
const SCROLL_ACCEL = {
  tick: () => SCROLL_LINES_PER_NOTCH,
  reset: () => {},
}

export function Messages(props: MessagesProps) {
  const theme = useTheme()
  const store = useSessionStore()

  const items = createMemo(() => store.store.items[props.sessionId] ?? [])

  return (
    <scrollbox
      flexGrow={1}
      height={props.height}
      width={props.width}
      stickyScroll
      stickyStart="bottom"
      scrollAcceleration={SCROLL_ACCEL}
      // One cell of breathing room between the transcript text and the bar
      // (terminal layout is cell-based, so 1 column is the minimum gap).
      verticalScrollbarOptions={{ marginLeft: 1 }}
      // No flexDirection here: it would land on the scrollbox ROOT and override
      // its internal row layout ([viewport | scrollbar]), pushing the vertical
      // scrollbar below the viewport instead of beside it. Items stack
      // vertically anyway — the inner content box defaults to column.
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      <Show when={items().length === 0}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.primary}><strong>Rite</strong></text>
          <text fg={theme.textMuted}>What would you like to work on?</text>
        </box>
      </Show>

      <For each={items()}>
        {(item, i) => (
          <ItemView
            item={item}
            showRiteLabel={startsTurn(items(), i())}
            turnStart={startsTurn(items(), i())}
            turnEnd={endsTurn(items(), i())}
          />
        )}
      </For>
    </scrollbox>
  )
}

// Thinking, tool, and assistant-text items all belong to Rite's turn.
function isAssistantSide(item: DisplayItem | undefined): boolean {
  return !!item && (item.kind === "thinking" || item.kind === "tool" || item.kind === "assistant")
}

// A turn is a user message, a system notice, or a contiguous assistant run
// (think→tool→answer). Margins go on the first/last item of each turn so turns
// are separated vertically while a turn's internal steps stay tight together.
// The "Rite" label shows once, at the start of an assistant turn.
function startsTurn(items: DisplayItem[], i: number): boolean {
  const it = items[i]
  if (!it) return false
  if (it.kind === "user" || it.kind === "system") return true
  return isAssistantSide(it) && !isAssistantSide(items[i - 1])
}

function endsTurn(items: DisplayItem[], i: number): boolean {
  const it = items[i]
  if (!it) return false
  if (it.kind === "user" || it.kind === "system") return true
  return isAssistantSide(it) && !isAssistantSide(items[i + 1])
}

// Drop markdown thematic-break lines (---, ***, ___, optionally spaced) before
// rendering — they render as full-width rules that read as noise in chat. Only
// the display copy is stripped; stored turns keep the raw text for faithful
// /copy and persistence. The blank gap a removed rule leaves is collapsed.
function stripHorizontalRules(md: string): string {
  return md
    .split("\n")
    .filter((line) => !/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

function summarizeToolInput(inputJson: string): string {
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>
    const interesting = ["command", "file_path", "path", "pattern", "query", "url", "description"]
    for (const key of interesting) {
      if (typeof input[key] === "string" && (input[key] as string).trim()) {
        return (input[key] as string).slice(0, 80)
      }
    }
    const first = Object.values(input).find((v) => typeof v === "string")
    return typeof first === "string" ? first.slice(0, 80) : ""
  } catch {
    return inputJson.slice(0, 80)
  }
}

/** Per-edit slice extracted from a tool call's inputJson for diff rendering. */
interface EditSlice {
  oldText: string
  newText: string
}

/**
 * Pull edit slices out of an Edit-family tool call. Recognizes:
 *   - Edit:      { file_path, old_string, new_string, … }
 *   - MultiEdit: { file_path, edits: [{ old_string, new_string }, …] }
 *   - Write:     { file_path, content } → treated as "all new"
 *   - NotebookEdit (best effort): old_source/new_source
 * Returns null when the tool isn't an editor or inputJson is unparseable.
 */
function extractEditSlices(toolName: string, inputJson: string): EditSlice[] | null {
  const lower = toolName.toLowerCase()
  const isEditor = /^(edit|multiedit|write|notebookedit|str_replace|str_replace_based_edit_tool)/.test(lower)
  if (!isEditor) return null
  let input: Record<string, unknown>
  try {
    input = JSON.parse(inputJson) as Record<string, unknown>
  } catch {
    return null
  }
  const slices: EditSlice[] = []
  if (Array.isArray(input.edits)) {
    for (const e of input.edits as Array<Record<string, unknown>>) {
      const o = typeof e.old_string === "string" ? e.old_string : typeof e.old_str === "string" ? e.old_str : ""
      const n = typeof e.new_string === "string" ? e.new_string : typeof e.new_str === "string" ? e.new_str : ""
      if (o || n) slices.push({ oldText: o, newText: n })
    }
  }
  const oldKey = (typeof input.old_string === "string" && input.old_string)
    || (typeof input.old_str === "string" && input.old_str)
    || (typeof input.old_source === "string" && input.old_source)
    || ""
  const newKey = (typeof input.new_string === "string" && input.new_string)
    || (typeof input.new_str === "string" && input.new_str)
    || (typeof input.new_source === "string" && input.new_source)
    || (typeof input.content === "string" && input.content)
    || ""
  if (oldKey || newKey) slices.push({ oldText: oldKey as string, newText: newKey as string })
  return slices.length ? slices : null
}

interface DiffLine {
  kind: "add" | "del" | "ctx"
  text: string
}

/**
 * Compute a per-line diff using the LCS algorithm. Operates on the union of
 * lines from `oldText` and `newText` and emits a unified-style sequence:
 *   "-" for removed, "+" for added, " " for unchanged.
 *
 * Optimized for typical edits (small to medium); we cap input size at
 * MAX_DIFF_LINES_INPUT before falling back to a naive add/del rendering so
 * pathological MultiEdit payloads never burn TUI render budget.
 */
const MAX_DIFF_LINES_INPUT = 800
function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length ? oldText.split("\n") : []
  const newLines = newText.length ? newText.split("\n") : []
  if (oldLines.length + newLines.length > MAX_DIFF_LINES_INPUT) {
    return [
      ...oldLines.map<DiffLine>((l) => ({ kind: "del", text: l })),
      ...newLines.map<DiffLine>((l) => ({ kind: "add", text: l })),
    ]
  }
  const m = oldLines.length
  const n = newLines.length
  // LCS table (small; bounded by MAX_DIFF_LINES_INPUT).
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: "ctx", text: oldLines[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: oldLines[i++] })
    } else {
      out.push({ kind: "add", text: newLines[j++] })
    }
  }
  while (i < m) out.push({ kind: "del", text: oldLines[i++] })
  while (j < n) out.push({ kind: "add", text: newLines[j++] })
  return out
}

/** Trim long context runs to ±2 lines around any change. Pure cosmetic. */
const CONTEXT_LINES = 2
function trimContext(lines: DiffLine[]): DiffLine[] {
  const keep = new Array(lines.length).fill(false)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "ctx") {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(lines.length - 1, i + CONTEXT_LINES); k++) {
        keep[k] = true
      }
    }
  }
  const out: DiffLine[] = []
  let elided = false
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i])
      elided = false
    } else if (!elided) {
      out.push({ kind: "ctx", text: "  …" })
      elided = true
    }
  }
  return out
}

const MAX_DIFF_RENDER_LINES = 60

function ItemView(props: {
  item: DisplayItem
  showRiteLabel: boolean
  turnStart: boolean
  turnEnd: boolean
}) {
  const theme = useTheme()
  const item = props.item

  return (
    <box
      flexDirection="column"
      marginTop={props.turnStart ? 1 : 0}
      marginBottom={props.turnEnd ? 1 : 0}
    >
    <Switch>
      <Match when={item.kind === "user"}>
        <box flexDirection="column">
          <text fg={theme.primary}><strong>you</strong></text>
          <box paddingLeft={CONTENT_INDENT}>
            <text fg={theme.userMsg}>
              {(item as Extract<DisplayItem, { kind: "user" }>).content}
            </text>
          </box>
        </box>
      </Match>

      <Match when={item.kind === "assistant"}>
        <box flexDirection="column">
          <Show when={props.showRiteLabel}>
            <text fg={theme.success}><strong>Rite</strong></text>
          </Show>
          <box paddingLeft={CONTENT_INDENT} flexDirection="column">
            <markdown
              content={stripHorizontalRules((item as Extract<DisplayItem, { kind: "assistant" }>).content) || "…"}
              fg={theme.assistantMsg}
              syntaxStyle={theme.syntaxStyle}
            />
          </box>
        </box>
      </Match>

      <Match when={item.kind === "thinking"}>
        <box flexDirection="column">
          <Show when={props.showRiteLabel}>
            <text fg={theme.success}><strong>Rite</strong></text>
          </Show>
          <box paddingLeft={CONTENT_INDENT}>
            <text fg={theme.textDim}>
              {`✻ thought (${(item as Extract<DisplayItem, { kind: "thinking" }>).content.length} chars)`}
            </text>
          </box>
        </box>
      </Match>

      <Match when={item.kind === "tool"}>
        <box flexDirection="column">
          <Show when={props.showRiteLabel}>
            <text fg={theme.success}><strong>Rite</strong></text>
          </Show>
          <ToolItemView item={item as Extract<DisplayItem, { kind: "tool" }>} />
        </box>
      </Match>

      <Match when={item.kind === "system"}>
        <box paddingLeft={CONTENT_INDENT}>
          <text fg={theme.warning}>
            {(item as Extract<DisplayItem, { kind: "system" }>).content}
          </text>
        </box>
      </Match>
    </Switch>
    </box>
  )
}

function ToolItemView(props: { item: Extract<DisplayItem, { kind: "tool" }> }) {
  const theme = useTheme()
  const slices = createMemo(() => extractEditSlices(props.item.name, props.item.inputJson))
  const diff = createMemo(() => {
    const ss = slices()
    if (!ss) return null
    // Concatenate per-slice diffs separated by an elision marker so MultiEdit
    // shows all edits in order.
    const parts: DiffLine[][] = ss.map((s) => trimContext(diffLines(s.oldText, s.newText)))
    const flat: DiffLine[] = []
    parts.forEach((p, i) => {
      if (i > 0) flat.push({ kind: "ctx", text: "  ─" })
      flat.push(...p)
    })
    return flat
  })
  const stats = createMemo(() => {
    const d = diff()
    if (!d) return null
    let add = 0
    let del = 0
    for (const l of d) {
      if (l.kind === "add") add++
      else if (l.kind === "del") del++
    }
    return { add, del }
  })
  const truncated = createMemo(() => {
    const d = diff()
    return d ? d.length > MAX_DIFF_RENDER_LINES : false
  })
  const visible = createMemo(() => {
    const d = diff()
    if (!d) return [] as DiffLine[]
    return d.length > MAX_DIFF_RENDER_LINES ? d.slice(0, MAX_DIFF_RENDER_LINES) : d
  })
  return (
    <box flexDirection="column" paddingLeft={CONTENT_INDENT}>
      <box flexDirection="row" gap={1}>
        <text fg={props.item.running ? theme.textDim : props.item.isError ? theme.error : theme.toolName}>
          {`${props.item.running ? "⏳" : props.item.isError ? "✗" : "✓"} ${props.item.name}`}
        </text>
        <text fg={theme.textDim}>{summarizeToolInput(props.item.inputJson)}</text>
        <Show when={!props.item.running && stats()}>
          {(s) => (
            <text fg={theme.textDim}>
              {/* fg via spread: upstream SpanProps types span options as {} even
                  though TextNodeRenderable supports fg at runtime. A spread
                  skips TS excess-property checks; a literal attribute errors. */}
              <span {...{ fg: theme.success }}>{`+${s().add}`}</span> <span {...{ fg: theme.error }}>{`-${s().del}`}</span>
            </text>
          )}
        </Show>
        <Show when={!props.item.running}>
          <text fg={theme.textDim}>{`(${Math.round(props.item.durationMs / 100) / 10}s)`}</text>
        </Show>
        <Show when={props.item.running}>
          <text fg={theme.textDim}>running…</text>
        </Show>
      </box>
      <Show when={!props.item.running && diff() && diff()!.length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={visible()}>
            {(line) => (
              <text
                fg={line.kind === "add" ? theme.success : line.kind === "del" ? theme.error : theme.textDim}
              >
                {`${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}`}
              </text>
            )}
          </For>
          <Show when={truncated()}>
            <text fg={theme.textDim}>{`… (${diff()!.length - MAX_DIFF_RENDER_LINES} more lines)`}</text>
          </Show>
        </box>
      </Show>
      <Show when={!props.item.running && props.item.isError && props.item.result.trim()}>
        <text fg={theme.error}>{props.item.result.slice(0, 400)}</text>
      </Show>
    </box>
  )
}
