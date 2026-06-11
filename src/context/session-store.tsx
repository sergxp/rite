import { batch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "./helper"
import type { Session, Turn } from "../sessions/types"

interface SessionStoreState {
  sessions: Session[]
  activeTurns: Record<string, Turn[]>
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
      activeTurns: {},
      loading: false,
    })

    function setSessions(sessions: Session[]) {
      setStore("sessions", sessions)
    }

    function upsertSession(session: Session) {
      setStore(
        produce((s) => {
          const idx = s.sessions.findIndex((x) => x.id === session.id)
          if (idx === -1) s.sessions.unshift(session)
          else s.sessions[idx] = session
        }),
      )
    }

    function setTurns(sessionId: string, turns: Turn[]) {
      setStore("activeTurns", sessionId, turns)
    }

    function appendTurn(sessionId: string, turn: Turn) {
      setStore(
        produce((s) => {
          if (!s.activeTurns[sessionId]) s.activeTurns[sessionId] = []
          s.activeTurns[sessionId]!.push(turn)
        }),
      )
    }

    function updateLastTurn(sessionId: string, updater: (turn: Turn) => void) {
      setStore(
        produce((s) => {
          const turns = s.activeTurns[sessionId]
          if (turns && turns.length > 0) updater(turns[turns.length - 1]!)
        }),
      )
    }

    function setLoading(loading: boolean) {
      setStore("loading", loading)
    }

    return {
      store,
      setSessions,
      upsertSession,
      setTurns,
      appendTurn,
      updateLastTurn,
      setLoading,
    }
  },
})
