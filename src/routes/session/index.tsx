import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useRoute } from "../../context/route"
import { useSessionStore } from "../../context/session-store"
import { Messages } from "./messages"
import { Composer } from "./composer"
import { Footer } from "./footer"
import { SessionStore } from "../../sessions/store"
import type { Session } from "../../sessions/types"

// Height reserved for composer (min 3) and footer (1)
const FOOTER_HEIGHT = 1
const COMPOSER_MIN_HEIGHT = 3

export function Session() {
  const theme = useTheme()
  const route = useRoute()
  const store = useSessionStore()
  const dimensions = useTerminalDimensions()

  const [session, setSession] = createSignal<Session | null>(null)
  const [composerHeight, setComposerHeight] = createSignal(COMPOSER_MIN_HEIGHT)
  const [streaming, setStreaming] = createSignal(false)

  // Load or create session on mount
  createEffect(async () => {
    const r = route.data()
    if (r.type !== "session") return

    if (r.sessionId) {
      const loaded = await SessionStore.load(r.sessionId, process.cwd())
      if (loaded) {
        setSession(loaded)
        store.setTurns(loaded.id, loaded.turns)
        return
      }
    }

    // New session
    const s = await SessionStore.create({ cwd: process.cwd() })
    setSession(s)
    store.upsertSession(s)
    route.navigate({ type: "session", sessionId: s.id })
  })

  const msgAreaHeight = () =>
    Math.max(1, dimensions().height - composerHeight() - FOOTER_HEIGHT)

  return (
    <Show when={session()} keyed>
      {(s) => (
        <box flexDirection="column" width={dimensions().width} height={dimensions().height}>
          <Messages
            sessionId={s.id}
            height={msgAreaHeight()}
            width={dimensions().width}
          />
          <Composer
            session={s}
            streaming={streaming()}
            onHeightChange={setComposerHeight}
            onStreamStart={() => setStreaming(true)}
            onStreamEnd={() => setStreaming(false)}
          />
          <Footer session={s} streaming={streaming()} />
        </box>
      )}
    </Show>
  )
}
