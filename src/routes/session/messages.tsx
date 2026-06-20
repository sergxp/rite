import { createMemo, createSignal, createEffect, For, Show, Switch, Match, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useSessionStore, type DisplayItem } from "../../context/session-store"
import { registerMarkdownCopySource, unregisterMarkdownCopySource } from "../../utils/markdown-copy-source"

interface MessagesProps {
  sessionId: string
  height: number
  width: number
}

// Content hangs two columns under its speaker label, so each turn reads as a
// labeled block rather than an undifferentiated wall of text.
const CONTENT_INDENT = 2
const TRANSCRIPT_CHROME_WIDTH = 4

// Wheel sensitivity: lines scrolled per notch. opentui's default accel moves a
// single line per notch, which feels sluggish in a long transcript. A constant
// multiplier scrolls several lines per notch while staying predictable (unlike
// velocity-based acceleration, which only kicks in on fast streaks).
const SCROLL_LINES_PER_NOTCH = 3
const SCROLL_ACCEL = {
  tick: () => SCROLL_LINES_PER_NOTCH,
  reset: () => {},
}

// How many display items to render in one window. Limits the native Yoga/opentui
// layout tree size so long sessions don't leak memory into the Zig renderer.
export const TRANSCRIPT_WINDOW_SIZE = 60
// How many additional items to prepend each time the user presses Ctrl+U.
export const TRANSCRIPT_LOAD_MORE_STEP = 40

export function Messages(props: MessagesProps) {
  const theme = useTheme()
  const store = useSessionStore()

  // Index into the full items array where our rendered window starts.
  // Defaults to the bottom (show newest). Resets when the session changes.
  const [windowStart, setWindowStart] = createSignal(0)
  createEffect(() => {
    const all = store.store.items[props.sessionId] ?? []
    // On initial session load or when new items arrive below the window,
    // snap windowStart to show the tail. Only reset when it would otherwise
    // hide new items from the end (i.e. windowStart is near the new end).
    const naturalStart = Math.max(0, all.length - TRANSCRIPT_WINDOW_SIZE)
    setWindowStart((prev) => {
      // If the user has scrolled up into history (prev < naturalStart - 5),
      // keep their position so new assistant streaming doesn't jerk the view.
      if (prev > 0 && prev < naturalStart - 5) return prev
      return naturalStart
    })
  })

  // Ctrl+U: load an earlier batch — extend the window backward.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "u") {
      setWindowStart((prev) => Math.max(0, prev - TRANSCRIPT_LOAD_MORE_STEP))
    }
  })

  const allItems = createMemo(() => store.store.items[props.sessionId] ?? [])
  const hiddenCount = createMemo(() => windowStart())
  const items = createMemo(() => {
    const all = allItems()
    return all.slice(windowStart())
  })

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
      {/* Banner when earlier history is hidden: Ctrl+U loads the prev batch. */}
      <Show when={hiddenCount() > 0}>
        <box paddingLeft={CONTENT_INDENT} marginBottom={1}>
          <text fg={theme.textDim}>
            {`↑ ${hiddenCount()} earlier message${hiddenCount() === 1 ? "" : "s"} — Ctrl+U to load more`}
          </text>
        </box>
      </Show>

      <Show when={allItems().length === 0}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.primary}><strong>Rite</strong></text>
          <text fg={theme.textMuted}>What would you like to work on?</text>
        </box>
      </Show>

      <For each={items()}>
        {(item, i) => (
          <ItemView
            item={item}
            contentWidth={Math.max(20, props.width - CONTENT_INDENT - TRANSCRIPT_CHROME_WIDTH)}
            copyId={`${props.sessionId}-md-${windowStart() + i()}`}
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
  if (it.kind === "user" || it.kind === "system" || it.kind === "loop-step") return true
  return isAssistantSide(it) && !isAssistantSide(items[i - 1])
}

function endsTurn(items: DisplayItem[], i: number): boolean {
  const it = items[i]
  if (!it) return false
  if (it.kind === "user" || it.kind === "system" || it.kind === "loop-step") return true
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

// Convert GitHub-style markdown tables into a plain text grid so opentui's
// markdown renderer (tree-sitter highlighter, no real table layout) doesn't
// drop rows or render only the header. We pad each cell to the column's
// max width and surround with spaces; the result is monospace-aligned text
// the markdown renderer treats as a code-ish block. Idempotent on input
// without tables.
function flattenMarkdownTables(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const sep = lines[i + 1]
    const isTableLine = (l: string | undefined) => typeof l === "string" && l.indexOf("|") !== -1
    const isSepLine = (l: string | undefined) =>
      typeof l === "string" && /^\s*\|?\s*:?-{2,}:?(\s*\|\s*:?-{2,}:?)+\s*\|?\s*$/.test(l)

    if (isTableLine(header) && isSepLine(sep)) {
      // Collect contiguous body rows.
      const rows: string[][] = []
      const splitRow = (l: string): string[] =>
        l
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim())
      rows.push(splitRow(header))
      let j = i + 2
      while (j < lines.length && lines[j].trim() !== "" && isTableLine(lines[j])) {
        rows.push(splitRow(lines[j]))
        j++
      }
      const cols = Math.max(...rows.map((r) => r.length))
      const widths = new Array(cols).fill(0)
      for (const r of rows) {
        for (let c = 0; c < cols; c++) {
          widths[c] = Math.max(widths[c], (r[c] ?? "").length)
        }
      }
      // Render a full box-drawing table inside a markdown code block so the
      // tree-sitter highlighter preserves all whitespace perfectly.
      const PAD = " "
      const padCell = (cell: string, w: number) => PAD + (cell ?? "").padEnd(w, PAD) + PAD
      const border = (left: string, mid: string, right: string) =>
        left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right
      const formatRow = (r: string[]): string =>
        "│" + widths.map((w, c) => padCell(r[c] ?? "", w)).join("│") + "│"
      out.push("```text")
      out.push(border("┌", "┬", "┐"))
      out.push(formatRow(rows[0]))
      out.push(border("├", "┼", "┤"))
      for (let r = 1; r < rows.length; r++) {
        out.push(formatRow(rows[r]))
        if (r < rows.length - 1) {
          out.push(border("├", "┼", "┤"))
        }
      }
      out.push(border("└", "┴", "┘"))
      out.push("```")
      out.push("")
      i = j
      continue
    }
    out.push(lines[i])
    i++
  }
  return out.join("\n")
}

function wrapMarkdownProse(md: string, width: number): string {
  const safeWidth = Math.max(20, width)
  const lines = md.split("\n")
  const out: string[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence || line.trim() === "" || line.length <= safeWidth) {
      out.push(line)
      continue
    }

    const prefix = line.match(/^(\s*(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)?)/)?.[1] ?? ""
    const body = line.slice(prefix.length)
    const continuation = " ".repeat(prefix.length)
    let current = prefix

    for (const word of body.split(/\s+/).filter(Boolean)) {
      const sep = current.length > 0 && !/\s$/.test(current) ? " " : ""
      if ((current + sep + word).length <= safeWidth) {
        current += sep + word
        continue
      }
      if (current.trim()) out.push(current)
      current = continuation + word
    }
    if (current.trim()) out.push(current)
  }

  return out.join("\n")
}

export function prepareMarkdown(md: string, width = 80): string {
  return wrapMarkdownProse(flattenMarkdownTables(stripHorizontalRules(md)), width)
}

interface InlineSegment {
  text: string
  bold?: boolean
  code?: boolean
  link?: boolean
  listMarker?: boolean
}

interface RenderLine {
  kind: "blank" | "code" | "text"
  text?: string
  segments?: InlineSegment[]
}

function displayWidth(segments: InlineSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0)
}

function parseInlineMarkdown(line: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  let i = 0

  const push = (text: string, style: Omit<InlineSegment, "text"> = {}) => {
    if (!text) return
    const last = segments[segments.length - 1]
    if (
      last
      && !!last.bold === !!style.bold
      && !!last.code === !!style.code
      && !!last.link === !!style.link
      && !!last.listMarker === !!style.listMarker
    ) {
      last.text += text
      return
    }
    segments.push({ text, ...style })
  }

  while (i < line.length) {
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2)
      if (end > i + 2) {
        push(line.slice(i + 2, end), { bold: true })
        i = end + 2
        continue
      }
    }
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end > i + 1) {
        push(line.slice(i + 1, end), { code: true })
        i = end + 1
        continue
      }
    }
    if (line[i] === "[") {
      const labelEnd = line.indexOf("]", i + 1)
      if (labelEnd > i + 1 && line[labelEnd + 1] === "(") {
        const urlEnd = line.indexOf(")", labelEnd + 2)
        if (urlEnd > labelEnd + 2) {
          push(line.slice(i + 1, labelEnd), { link: true })
          i = urlEnd + 1
          continue
        }
      }
    }
    push(line[i])
    i++
  }

  return segments
}

function splitSegmentWords(segment: InlineSegment): InlineSegment[] {
  return segment.text
    .split(/(\s+)/)
    .filter((text) => text.length > 0)
    .map((text) => ({ ...segment, text }))
}

function wrapSegments(
  segments: InlineSegment[],
  width: number,
  firstPrefix: InlineSegment[] = [],
  continuationPrefix: InlineSegment[] = [],
): InlineSegment[][] {
  const safeWidth = Math.max(20, width)
  const lines: InlineSegment[][] = []
  let current = [...firstPrefix]

  for (const token of segments.flatMap(splitSegmentWords)) {
    const tokenIsSpace = /^\s+$/.test(token.text)
    if (tokenIsSpace && displayWidth(current) === displayWidth(firstPrefix)) continue

    const nextWidth = displayWidth(current) + token.text.length
    if (!tokenIsSpace && nextWidth > safeWidth && displayWidth(current) > displayWidth(firstPrefix)) {
      while (current.length > 0 && /^\s+$/.test(current[current.length - 1].text)) current.pop()
      lines.push(current)
      current = [...continuationPrefix, token]
      continue
    }
    current.push(token)
  }

  while (current.length > 0 && /^\s+$/.test(current[current.length - 1].text)) current.pop()
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : [[]]
}

function renderTextLine(line: string, width: number): RenderLine[] {
  if (!line.trim()) return [{ kind: "blank" }]

  const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/)
  if (heading) {
    return wrapSegments(parseInlineMarkdown(heading[1]), width).map((segments) => ({
      kind: "text",
      segments: segments.map((segment) => ({ ...segment, bold: true, link: true })),
    }))
  }

  const list = line.match(/^(\s*)((?:[-*+]|\d+[.)]))\s+(.+)$/)
  if (list) {
    const prefix = `${list[1]}${list[2]} `
    const firstPrefix: InlineSegment[] = [{ text: prefix, listMarker: true }]
    const continuationPrefix: InlineSegment[] = [{ text: " ".repeat(prefix.length) }]
    return wrapSegments(parseInlineMarkdown(list[3]), width, firstPrefix, continuationPrefix).map((segments) => ({ kind: "text", segments }))
  }

  const quote = line.match(/^\s*>\s?(.+)$/)
  if (quote) {
    const prefix: InlineSegment[] = [{ text: "│ ", listMarker: true }]
    return wrapSegments(parseInlineMarkdown(quote[1]), width, prefix, [{ text: "  " }]).map((segments) => ({ kind: "text", segments }))
  }

  return wrapSegments(parseInlineMarkdown(line), width).map((segments) => ({ kind: "text", segments }))
}

export function renderMarkdownLines(md: string, width = 80): RenderLine[] {
  const lines = flattenMarkdownTables(stripHorizontalRules(md)).split("\n")
  const out: RenderLine[] = []
  let inFence = false

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      out.push({ kind: "code", text: line })
      continue
    }
    out.push(...renderTextLine(line, width))
  }

  return out
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

function InlineSegmentView(props: { segment: InlineSegment }) {
  const theme = useTheme()
  const style = props.segment.code
    ? { fg: theme.toolName }
    : props.segment.link || props.segment.listMarker
      ? { fg: theme.info }
      : {}

  if (props.segment.bold) {
    return (
      <strong>
        <span {...style}>{props.segment.text}</span>
      </strong>
    )
  }

  return <span {...style}>{props.segment.text}</span>
}

function ItemView(props: {
  item: DisplayItem
  contentWidth: number
  copyId: string
  showRiteLabel: boolean
  turnStart: boolean
  turnEnd: boolean
}) {
  const theme = useTheme()
  const item = props.item

  createEffect(() => {
    if (item.kind !== "assistant") return
    const id = props.copyId
    registerMarkdownCopySource(id, item.content)
    onCleanup(() => unregisterMarkdownCopySource(id))
  })
    const assistantLines = createMemo(() =>
      item.kind === "assistant"
        ? renderMarkdownLines(item.content || "…", props.contentWidth)
        : [],
    )

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
          <box id={props.copyId} paddingLeft={CONTENT_INDENT} flexDirection="column">
            <For each={assistantLines()}>
              {(line) => (
                <Show
                  when={line.kind === "text"}
                  fallback={
                    <text fg={line.kind === "code" ? theme.toolOutput : theme.assistantMsg}>
                      {line.kind === "code" ? line.text : " "}
                    </text>
                  }
                >
                  <text fg={theme.assistantMsg}>
                    <For each={line.segments ?? []}>
                      {(segment) => <InlineSegmentView segment={segment} />}
                    </For>
                  </text>
                </Show>
              )}
            </For>
          </box>
        </box>
      </Match>

      <Match when={item.kind === "thinking"}>
        <box flexDirection="column">
          <Show when={props.showRiteLabel}>
            <text fg={theme.success}><strong>Rite</strong></text>
          </Show>
          <Show
            when={(item as Extract<DisplayItem, { kind: "thinking" }>).streaming}
            fallback={
              <box paddingLeft={CONTENT_INDENT}>
                <text fg={theme.textDim}>
                  {`✻ thought (${(item as Extract<DisplayItem, { kind: "thinking" }>).content.length} chars)`}
                </text>
              </box>
            }
          >
            <box paddingLeft={CONTENT_INDENT} flexDirection="column">
              <text fg={theme.textDim}>{`✻ thinking…`}</text>
              <For
                each={(item as Extract<DisplayItem, { kind: "thinking" }>).content
                  .split("\n")
                  .filter((l) => l.trim())
                  .slice(-5)}
              >
                {(line) => <text fg={theme.textDim}>{line}</text>}
              </For>
            </box>
          </Show>
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

      <Match when={item.kind === "loop-step"}>
        {(() => {
          const s = item as Extract<DisplayItem, { kind: "loop-step" }>
          return (
            <box flexDirection="row" gap={2} paddingLeft={CONTENT_INDENT}>
              <text fg={theme.primary}>{`⟳ ${s.loopName}`}</text>
              <text fg={theme.textDim}>{`step ${s.stepIndex + 1}/${s.stepTotal}`}</text>
              <text fg={theme.success}>{s.stepLabel}</text>
              <text fg={theme.textMuted}>{`(${s.stepType})`}</text>
            </box>
          )
        })()}
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
              <box>
                <text
                  fg={line.kind === "ctx" ? theme.textDim : "#ffffff"}
                  bg={line.kind === "add" ? "#1f6f3d" : line.kind === "del" ? "#7a1d1d" : undefined}
                >
                  {`${line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}${line.text}`}
                </text>
              </box>
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
