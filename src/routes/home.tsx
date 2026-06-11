import { createSignal, createEffect, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useTheme, type Theme } from "../context/theme"
import { useRoute } from "../context/route"
import { useSessionStore } from "../context/session-store"
import { SessionStore } from "../sessions/store"

export function Home() {
  const theme = useTheme()
  const route = useRoute()
  const store = useSessionStore()

  const [selected, setSelected] = createSignal(0)
  const [loading, setLoading] = createSignal(true)

  createEffect(async () => {
    const sessions = await SessionStore.list(process.cwd())
    store.setSessions(sessions)
    setLoading(false)
  })

  useKeyboard((key) => {
    const sessions = store.store.sessions
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      setSelected((s) => Math.max(0, s - 1))
    } else if (key.name === "down" || (key.ctrl && key.name === "n")) {
      setSelected((s) => Math.min(sessions.length, s + 1))
    } else if (key.name === "return") {
      const idx = selected()
      if (idx === 0) {
        route.navigate({ type: "session", sessionId: "" })
      } else {
        const session = sessions[idx - 1]
        if (session) route.navigate({ type: "session", sessionId: session.id })
      }
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} padding={2} gap={1}>
      <text fg={theme.primary}>Rite</text>
      <text fg={theme.textMuted}>AI coding assistant</text>

      <box height={1} />

      <Show when={loading()}>
        <text fg={theme.textMuted}>Loading sessions…</text>
      </Show>

      <Show when={!loading()}>
        <box flexDirection="column" gap={0}>
          <SessionRow label="+ New session" selected={selected() === 0} theme={theme} />
          <For each={store.store.sessions}>
            {(session, i) => (
              <SessionRow
                label={session.name ?? `Session ${session.id.slice(0, 8)}`}
                subtitle={new Date(session.updatedAt).toLocaleString()}
                selected={selected() === i() + 1}
                theme={theme}
              />
            )}
          </For>
        </box>

        <box height={1} />
        <text fg={theme.textDim}>↑↓ navigate  ↵ open  q quit</text>
      </Show>
    </box>
  )
}

function SessionRow(props: {
  label: string
  subtitle?: string
  selected: boolean
  theme: Theme
}) {
  return (
    <box
      flexDirection="row"
      gap={1}
      backgroundColor={props.selected ? props.theme.surface : undefined}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={props.selected ? props.theme.primary : props.theme.text}>
        {props.selected ? "▶ " : "  "}
        {props.label}
      </text>
      <Show when={props.subtitle}>
        <text fg={props.theme.textMuted}>{props.subtitle}</text>
      </Show>
    </box>
  )
}
