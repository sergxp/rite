import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useSessionStore } from "../../context/session-store"
import type { Turn } from "../../sessions/types"

interface MessagesProps {
  sessionId: string
  height: number
  width: number
}

export function Messages(props: MessagesProps) {
  const theme = useTheme()
  const store = useSessionStore()

  const turns = createMemo(() => store.store.activeTurns[props.sessionId] ?? [])

  return (
    <scrollbox
      flexGrow={1}
      height={props.height}
      width={props.width}
      stickyScroll
      stickyStart="bottom"
      flexDirection="column"
      gap={1}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
    >
      <Show when={turns().length === 0}>
        <box flexDirection="column" gap={1}>
          <text fg={theme.primary}>Rite</text>
          <text fg={theme.textMuted}>What would you like to work on?</text>
        </box>
      </Show>

      <For each={turns()}>
        {(turn) => <TurnView turn={turn} />}
      </For>
    </scrollbox>
  )
}

function TurnView(props: { turn: Turn }) {
  const theme = useTheme()

  if (props.turn.role === "user") {
    return (
      <box flexDirection="row" gap={1} alignItems="flex-start">
        <text fg={theme.primary}>you</text>
        <text fg={theme.userMsg} flexShrink={1}>
          {props.turn.content}
        </text>
      </box>
    )
  }

  return (
    <box flexDirection="column" paddingLeft={4}>
      <markdown
        content={props.turn.content}
        fg={theme.assistantMsg}
        syntaxStyle={theme.syntaxStyle}
      />
    </box>
  )
}
