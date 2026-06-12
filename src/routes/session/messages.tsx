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
const SCROLL_LINES_PER_NOTCH = 2
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
      flexDirection="column"
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
              ✻ thought ({(item as Extract<DisplayItem, { kind: "thinking" }>).content.length} chars)
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
  return (
    <box flexDirection="column" paddingLeft={CONTENT_INDENT}>
      <box flexDirection="row" gap={1}>
        <text fg={props.item.isError ? theme.error : theme.toolName}>
          {props.item.isError ? "✗" : "✓"} {props.item.name}
        </text>
        <text fg={theme.textDim}>{summarizeToolInput(props.item.inputJson)}</text>
        <text fg={theme.textDim}>({Math.round(props.item.durationMs / 100) / 10}s)</text>
      </box>
      <Show when={props.item.isError && props.item.result.trim()}>
        <text fg={theme.error}>{props.item.result.slice(0, 400)}</text>
      </Show>
    </box>
  )
}
