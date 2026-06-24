import { createMemo, createEffect, createSignal, onCleanup, For } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSessionStore } from "../../context/session-store"
import { loadMemories } from "../../memory/reader"
import { DEFAULT_CLAUDE_MODEL } from "../../sessions/store"
import {
  formatTerminalTitle,
  isTerminalFocused,
  RITE_TITLE_ANIMATION_FRAMES,
  SPINNER_FRAMES,
  writeTerminalBell,
  writeTerminalTabStatus,
  writeTerminalTitle,
  writeWindowsTerminalProgress,
} from "../../utils/terminal"
import { formatWorkspaceInfo, getWorkspaceInfo } from "../../utils/workspace"
import type { Session } from "../../sessions/types"

interface FooterProps {
  session: Session
  streaming: boolean
  status: string
  width: number
  onHeightChange: (height: number) => void
}

interface FooterLabel {
  text: string
  fg: string | undefined
}

const FOOTER_LABEL_SEPARATOR = " · "

export function packFooterLabels(labels: FooterLabel[], width: number): FooterLabel[][] {
  const safeWidth = Math.max(20, width)
  const rows: FooterLabel[][] = []
  let current: FooterLabel[] = []
  let currentWidth = 0

  for (const label of labels.filter((l) => l.text.trim())) {
    const nextWidth = currentWidth + (current.length > 0 ? FOOTER_LABEL_SEPARATOR.length : 0) + label.text.length
    if (current.length > 0 && nextWidth > safeWidth) {
      rows.push(current)
      current = [label]
      currentWidth = label.text.length
      continue
    }
    current.push(label)
    currentWidth = nextWidth
  }

  if (current.length > 0) rows.push(current)
  return rows.length > 0 ? rows : [[{ text: "", fg: undefined }]]
}

export function Footer(props: FooterProps) {
  const theme = useTheme()
  const store = useSessionStore()

  // Name can change after mount (LLM auto-naming) — read the live copy from
  // the store rather than the static keyed session object.
  const name = createMemo(() => {
    const live = store.store.sessions.find((s) => s.id === props.session.id)
    return live?.name ?? props.session.name ?? `session:${props.session.id.slice(0, 8)}`
  })
  const turnCount = createMemo(() => {
    const live = store.store.sessions.find((s) => s.id === props.session.id)
    return (live ?? props.session).turns.length
  })
  const model = createMemo(() => {
    const live = store.store.sessions.find((s) => s.id === props.session.id)
    const s = live ?? props.session
    return s.model ?? (s.backend === "claude" ? DEFAULT_CLAUDE_MODEL : undefined)
  })
  const memoryCount = createMemo(() => loadMemories().always.length)
  const workspace = createMemo(() => formatWorkspaceInfo(getWorkspaceInfo(props.session.workingDir)))
  const activeLoop = createMemo(() => {
    const live = store.store.sessions.find((s) => s.id === props.session.id)
    return (live ?? props.session).activeLoop
  })
  const [spinnerIdx, setSpinnerIdx] = createSignal(0)
  const [completionBadge, setCompletionBadge] = createSignal(false)
  let wasStreaming = false

  createEffect(() => {
    if (!props.streaming) return
    const interval = setInterval(() => {
      setSpinnerIdx((idx) => (idx + 1) % SPINNER_FRAMES.length)
    }, 120)
    onCleanup(() => clearInterval(interval))
  })

  createEffect(() => {
    if (props.streaming) {
      wasStreaming = true
      setCompletionBadge(false)
      writeTerminalTabStatus("busy")
      writeWindowsTerminalProgress("indeterminate")
      return
    }

    if (!wasStreaming) {
      writeTerminalTabStatus("idle")
      writeWindowsTerminalProgress("none")
      return
    }

    wasStreaming = false
    setCompletionBadge(true)
    writeTerminalTabStatus("complete")
    writeWindowsTerminalProgress("normal", 100)
    if (!isTerminalFocused()) writeTerminalBell()

    const timeout = setTimeout(() => {
      setCompletionBadge(false)
      writeTerminalTabStatus("idle")
      writeWindowsTerminalProgress("none")
    }, 4000)
    onCleanup(() => {
      clearTimeout(timeout)
      writeTerminalTabStatus(null)
      writeWindowsTerminalProgress("none")
    })
  })

  const taskState = createMemo(() => {
    if (props.streaming) return "running"
    if (completionBadge()) return "complete"
    return "idle"
  })

  createEffect(() => {
    const titleFrame = RITE_TITLE_ANIMATION_FRAMES[spinnerIdx() % RITE_TITLE_ANIMATION_FRAMES.length]
    writeTerminalTitle(formatTerminalTitle(name(), taskState(), titleFrame))
  })

  const labels = createMemo<FooterLabel[]>(() => {
    const modelName = model()
    return [
      { text: name(), fg: theme.assistantMsg },
      activeLoop() ? { text: `⟳ loop: ${activeLoop()}`, fg: theme.primary } : null,
      props.status ? { text: props.status, fg: theme.warning } : null,
      props.streaming ? { text: `${SPINNER_FRAMES[spinnerIdx()]} running`, fg: theme.primary } : null,
      !props.streaming && completionBadge() ? { text: "✓ done", fg: theme.success } : null,
      { text: workspace(), fg: theme.assistantMsg },
      { text: `${memoryCount()} ${memoryCount() === 1 ? "memory" : "memories"}`, fg: theme.assistantMsg },
      { text: `${turnCount()} turns`, fg: theme.assistantMsg },
      { text: props.session.backend, fg: theme.assistantMsg },
      modelName ? { text: modelName, fg: theme.assistantMsg } : null,
    ].filter((label): label is FooterLabel => label !== null)
  })
  const rows = createMemo(() => packFooterLabels(labels(), Math.max(20, props.width - 2)))

  createEffect(() => props.onHeightChange(rows().length))

  return (
    <box
      flexDirection="column"
      height={rows().length}
      paddingLeft={1}
      paddingRight={1}
    >
      <For each={rows()}>
        {(row) => (
          <box flexDirection="row">
            <For each={row}>
              {(label, i) => (
                <>
                  {i() > 0 ? <text fg={theme.textDim}>{FOOTER_LABEL_SEPARATOR}</text> : null}
                  <text fg={label.fg ?? theme.assistantMsg}>{label.text}</text>
                </>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}
