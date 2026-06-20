import { createMemo, createEffect, createSignal, onCleanup, Show } from "solid-js"
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

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      height={1}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.textMuted}>{name()}</text>

      <box flexDirection="row" gap={2}>
        <Show when={activeLoop()}>
          <text fg={theme.primary}>{`⟳ loop: ${activeLoop()}`}</text>
        </Show>
        <Show when={props.status}>
          <text fg={theme.warning}>{props.status}</text>
        </Show>
        <Show when={props.streaming}>
          <text fg={theme.primary}>{`${SPINNER_FRAMES[spinnerIdx()]} running`}</text>
        </Show>
        <Show when={!props.streaming && completionBadge()}>
          <text fg={theme.success}>✓ done</text>
        </Show>
        <text fg={theme.textDim}>
          {`${workspace()} · ${memoryCount()} ${memoryCount() === 1 ? "memory" : "memories"} · ${turnCount()} turns · ${props.session.backend}${model() ? ` · ${model()}` : ""}`}
        </text>
        <text fg={theme.textDim}>esc abort · q back</text>
      </box>
    </box>
  )
}
