import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { Session, Turn } from "../sessions/types"

/**
 * What the session transcript renders. Richer than persisted `Turn`s:
 * thinking blocks, tool calls, and system notices appear in the UI but only
 * user/assistant turns are saved to disk (mirrors v1).
 */
export type DisplayItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string; streaming?: boolean }
  | { kind: "thinking"; content: string; streaming?: boolean }
  | { kind: "tool"; name: string; inputJson: string; result: string; isError: boolean; durationMs: number; running?: boolean }
  | { kind: "system"; content: string }
  | { kind: "loop-step"; loopName: string; stepId: string; stepLabel: string; stepType: string; stepIndex: number; stepTotal: number }

export function turnsToItems(turns: Turn[]): DisplayItem[] {
  return turns.map((t) =>
    t.role === "user"
      ? { kind: "user" as const, content: t.content }
      : { kind: "assistant" as const, content: t.content },
  )
}

interface SessionStoreState {
  sessions: Session[]
  /** Per-session transcript display items, keyed by session id. */
  items: Record<string, DisplayItem[]>
  loading: boolean
}

export const {
  use: useSessionStore,
  provider: SessionStoreProvider,
} = createSimpleContext({
  name: "SessionStore",
  init: () => {
    const [store, setStore] = createStore<SessionStoreState>({
      sessions: [],
      items: {},
      loading: false,
    })

    function setSessions(sessions: Session[]) {
      setStore("sessions", sessions)
    }

    function upsertSession(session: Session) {
      // Deep-copy on the way in. Callers hold and mutate their own session
      // objects (turns.push, etc.); re-inserting a reference the store
      // already tracks leaves nested nodes (like turns) with stale signals —
      // the UI would keep rendering the old length forever.
      const copy = structuredClone(unwrap(session))
      setStore(
        produce((s) => {
          const idx = s.sessions.findIndex((x) => x.id === copy.id)
          if (idx === -1) s.sessions.unshift(copy)
          else s.sessions[idx] = copy
        }),
      )
    }

    function removeSession(sessionId: string) {
      setStore(
        produce((s) => {
          s.sessions = s.sessions.filter((x) => x.id !== sessionId)
          delete s.items[sessionId]
        }),
      )
    }

    function setItems(sessionId: string, items: DisplayItem[]) {
      setStore("items", sessionId, items)
    }

    function appendItem(sessionId: string, item: DisplayItem) {
      setStore(
        produce((s) => {
          if (!s.items[sessionId]) s.items[sessionId] = []
          s.items[sessionId]!.push(item)
        }),
      )
    }

    function updateLastItem(sessionId: string, updater: (item: DisplayItem) => void) {
      setStore(
        produce((s) => {
          const items = s.items[sessionId]
          if (items && items.length > 0) updater(items[items.length - 1]!)
        }),
      )
    }

    function updateItemAt(sessionId: string, index: number, updater: (item: DisplayItem) => void) {
      setStore(
        produce((s) => {
          const items = s.items[sessionId]
          if (items && index >= 0 && index < items.length) updater(items[index]!)
        }),
      )
    }

    function setLoading(loading: boolean) {
      setStore("loading", loading)
    }

    // Retain only the tail of a session's items in memory when the session is
    // no longer active. Frees the native Yoga layout nodes for all the trimmed
    // items. Call when navigating away from a session that won't be rendered.
    function compactItems(sessionId: string, keepCount = 5) {
      setStore(
        produce((s) => {
          const arr = s.items[sessionId]
          if (arr && arr.length > keepCount) {
            s.items[sessionId] = arr.slice(-keepCount)
          }
        }),
      )
    }

    return {
      store,
      setSessions,
      upsertSession,
      removeSession,
      setItems,
      appendItem,
      updateLastItem,
      updateItemAt,
      setLoading,
      compactItems,
    }
  },
})
