import { createMemo, createEffect, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSessionStore } from "../../context/session-store"
import { loadMemories } from "../../memory/reader"
import { DEFAULT_CLAUDE_MODEL } from "../../sessions/store"
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

  // Keep the terminal tab title in sync with the session name.
  createEffect(() => {
    process.stdout.write(`\x1b]2;${name()}\x07`)
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
        <Show when={props.status}>
          <text fg={theme.warning}>{props.status}</text>
        </Show>
        <Show when={props.streaming}>
          <text fg={theme.primary}>● streaming</text>
        </Show>
        <text fg={theme.textDim}>
          {`${memoryCount()} ${memoryCount() === 1 ? "memory" : "memories"} · ${turnCount()} turns · ${props.session.backend}${model() ? ` · ${model()}` : ""}`}
        </text>
        <text fg={theme.textDim}>esc abort · q back</text>
      </box>
    </box>
  )
}
