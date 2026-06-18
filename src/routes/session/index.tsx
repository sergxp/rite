import { createSignal, createEffect, Show, createMemo, For } from "solid-js"
import { useTerminalDimensions, useKeyboard } from "@opentui/solid"
import { useRoute } from "../../context/route"
import { useConfig } from "../../context/config"
import { useTheme } from "../../context/theme"
import { useSessionStore, turnsToItems } from "../../context/session-store"
import { Messages } from "./messages"
import { Composer } from "./composer"
import { Footer } from "./footer"
import { SessionStore } from "../../sessions/store"
import { ConversationHistory } from "../../history/history"
import type { Session as SessionType } from "../../sessions/types"

// Height reserved for composer (min 3) and footer (1)
const FOOTER_HEIGHT = 1
const COMPOSER_MIN_HEIGHT = 3 // 2 borders + 1 input row
export const MAX_SIDEBAR_FORK_ROWS = 6

export function visibleForksForSidebar<T extends { id: string; createdAt: string }>(
  forks: T[],
  currentId: string,
  maxRows = MAX_SIDEBAR_FORK_ROWS,
): T[] {
  const sorted = [...forks].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  if (sorted.length <= maxRows) return sorted

  const currentIndex = sorted.findIndex((f) => f.id === currentId)
  if (currentIndex === -1) return sorted.slice(-maxRows)

  const before = Math.floor((maxRows - 1) / 2)
  const start = Math.max(0, Math.min(currentIndex - before, sorted.length - maxRows))
  return sorted.slice(start, start + maxRows)
}

function Sidebar(props: { currentId: string; groupId: string; height: number; onSelect: (id: string) => void }) {
  const store = useSessionStore()
  const theme = useTheme()

  const forks = createMemo(() => {
    const group = store.store.sessions
      .filter((s) => s.groupId === props.groupId || s.id === props.groupId)
    return visibleForksForSidebar(group, props.currentId)
  })

  useKeyboard((key) => {
    if (key.ctrl && key.name === "n") {
      const list = forks()
      const idx = list.findIndex(s => s.id === props.currentId)
      if (idx >= 0 && idx < list.length - 1) {
        props.onSelect(list[idx + 1].id)
      }
    }
    if (key.ctrl && key.name === "p") {
      const list = forks()
      const idx = list.findIndex(s => s.id === props.currentId)
      if (idx > 0) {
        props.onSelect(list[idx - 1].id)
      }
    }
  })

  return (
    <box
      flexDirection="column"
      width={30}
      height={props.height}
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.primary}>Forks (ctrl+p/n)</text>
      <box height={1} />
      <For each={forks()}>
        {(f) => (
          <text
            fg={f.id === props.currentId ? theme.primary : theme.textDim}
            onMouseDown={() => props.onSelect(f.id)}
          >
            {f.id === props.currentId ? "▶ " : "  "}
            {f.name ?? `Session ${f.id.slice(0, 8)}`}
          </text>
        )}
      </For>
    </box>
  )
}

export function Session() {
  const route = useRoute()
  const config = useConfig()
  const store = useSessionStore()
  const dimensions = useTerminalDimensions()

  const [session, setSession] = createSignal<SessionType | null>(null)
  const [composerHeight, setComposerHeight] = createSignal(COMPOSER_MIN_HEIGHT)
  const [streaming, setStreaming] = createSignal(false)
  // Transient activity line for the footer: "✻ thinking…", "⏳ Bash", "* saved 2"
  const [status, setStatus] = createSignal("")

  // One rolling conversation window per mounted session screen, seeded from
  // persisted turns on resume. Used for prompt enrichment when the Claude CLI
  // session can't be resumed, and for /compact.
  const history = new ConversationHistory(config.historyLimit)

  let loadSeq = 0
  createEffect(async () => {
    const seq = ++loadSeq
    const r = route.data()
    if (r.type !== "session") return
    if (session()?.id === r.sessionId) return

    if (r.sessionId) {
      const loaded = await SessionStore.load(r.sessionId, process.cwd())
      if (seq !== loadSeq) return
      if (loaded) {
        history.clear()
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
    if (seq !== loadSeq) return
    store.setItems(s.id, [])
    setSession(s)
    store.upsertSession(s)
    route.navigate({ type: "session", sessionId: s.id })
  })

  const msgAreaHeight = () =>
    Math.max(1, dimensions().height - composerHeight() - FOOTER_HEIGHT)

  const hasForks = createMemo(() => {
    const s = session()
    if (!s || !s.groupId) return false
    return store.store.sessions.some(x => (x.groupId === s.groupId || x.id === s.groupId) && x.id !== s.id)
  })

  return (
    <Show when={session()}>
      {(s) => (
        <box flexDirection="row" width={dimensions().width} height={dimensions().height}>
          <box flexDirection="column" flexGrow={1} height={dimensions().height}>
            <Messages
              sessionId={s().id}
              height={msgAreaHeight()}
              width={hasForks() ? dimensions().width - 30 : dimensions().width}
            />
            <Composer
              session={s()}
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
            <Footer session={s()} streaming={streaming()} status={status()} />
          </box>
          <Show when={hasForks() && s().groupId}>
            <Sidebar
              currentId={s().id}
              groupId={s().groupId!}
              height={dimensions().height}
              onSelect={(id) => route.navigate({ type: "session", sessionId: id })}
            />
          </Show>
        </box>
      )}
    </Show>
  )
}
