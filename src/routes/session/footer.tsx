import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSessionStore } from "../../context/session-store"
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
          {turnCount()} turns · {props.session.backend}
        </text>
        <text fg={theme.textDim}>esc abort · q back</text>
      </box>
    </box>
  )
}
