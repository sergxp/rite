import { createSignal, onMount, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useRoute } from "../../context/route"
import { useConfig } from "../../context/config"
import { useSessionStore, turnsToItems } from "../../context/session-store"
import { Messages } from "./messages"
import { Composer } from "./composer"
import { Footer } from "./footer"
import { SessionStore } from "../../sessions/store"
import { ConversationHistory } from "../../history/history"
import type { Session } from "../../sessions/types"

// Height reserved for composer (min 3) and footer (1)
const FOOTER_HEIGHT = 1
const COMPOSER_MIN_HEIGHT = 3

export function Session() {
  const route = useRoute()
  const config = useConfig()
  const store = useSessionStore()
  const dimensions = useTerminalDimensions()

  const [session, setSession] = createSignal<Session | null>(null)
  const [composerHeight, setComposerHeight] = createSignal(COMPOSER_MIN_HEIGHT)
  const [streaming, setStreaming] = createSignal(false)
  // Transient activity line for the footer: "✻ thinking…", "⏳ Bash", "* saved 2"
  const [status, setStatus] = createSignal("")

  // One rolling conversation window per mounted session screen, seeded from
  // persisted turns on resume. Used for prompt enrichment when the Claude CLI
  // session can't be resumed, and for /compact.
  const history = new ConversationHistory(config.historyLimit)

  // Load or create session on mount. Deliberately onMount, not createEffect:
  // this reads route.data() and then navigates (writes route.data), so a
  // tracked effect would re-trigger itself — create → navigate → re-run →
  // load miss → create … — recreating the whole subtree (and a native
  // EditBuffer) on every pass.
  onMount(async () => {
    const r = route.data()
    if (r.type !== "session") return

    if (r.sessionId) {
      const loaded = await SessionStore.load(r.sessionId, process.cwd())
      if (loaded) {
        for (const t of loaded.turns.slice(-config.historyLimit)) {
          history.add(t.role, t.content)
        }
        store.setItems(loaded.id, turnsToItems(loaded.turns))
        setSession(loaded)
        return
      }
    }

    // New session — persist immediately so the id we put into the route
    // resolves on any future load/resume.
    const s = SessionStore.create({ cwd: process.cwd(), backend: config.backend })
    await SessionStore.save(s)
    store.setItems(s.id, [])
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
            history={history}
            streaming={streaming()}
            onHeightChange={setComposerHeight}
            onStreamStart={() => setStreaming(true)}
            onStreamEnd={() => {
              setStreaming(false)
              setStatus("")
            }}
            onStatus={setStatus}
          />
          <Footer session={s} streaming={streaming()} status={status()} />
        </box>
      )}
    </Show>
  )
}
