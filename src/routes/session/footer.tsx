import { Show } from "solid-js"
import { useTheme } from "../../context/theme"
import type { Session } from "../../sessions/types"

interface FooterProps {
  session: Session
  streaming: boolean
}

export function Footer(props: FooterProps) {
  const theme = useTheme()

  const name = () => props.session.name ?? `session:${props.session.id.slice(0, 8)}`
  const turnCount = () => props.session.turns.length

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      height={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.surface}
    >
      <text fg={theme.textMuted}>{name()}</text>

      <box flexDirection="row" gap={2}>
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
