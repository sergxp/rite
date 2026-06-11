import { createSignal, createEffect } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useSessionStore } from "../../context/session-store"
import { useRoute } from "../../context/route"
import { BackendRegistry } from "../../backends/index"
import type { Session } from "../../sessions/types"
import { SessionStore } from "../../sessions/store"

interface ComposerProps {
  session: Session
  streaming: boolean
  onHeightChange: (h: number) => void
  onStreamStart: () => void
  onStreamEnd: () => void
}

const COMPOSER_HEIGHT = 3 // border-top + input line + border-bottom

export function Composer(props: ComposerProps) {
  const theme = useTheme()
  const store = useSessionStore()
  const route = useRoute()

  const [abortController, setAbortController] = createSignal<AbortController | null>(null)
  let inputRef: InputRenderable | undefined

  createEffect(() => props.onHeightChange(COMPOSER_HEIGHT))

  async function submit(text: string) {
    const sessionId = props.session.id
    store.appendTurn(sessionId, { role: "user", content: text })
    props.onStreamStart()

    const ac = new AbortController()
    setAbortController(ac)

    let assistantContent = ""
    store.appendTurn(sessionId, { role: "assistant", content: "" })

    try {
      const backend = BackendRegistry.get(props.session.backend)
      const turns = store.store.activeTurns[sessionId] ?? []

      for await (const chunk of backend.stream(turns.slice(0, -1), { signal: ac.signal })) {
        assistantContent += chunk
        store.updateLastTurn(sessionId, (t) => {
          t.content = assistantContent
        })
      }

      const updated: Session = {
        ...props.session,
        turns: store.store.activeTurns[sessionId] ?? [],
        updatedAt: new Date().toISOString(),
      }
      await SessionStore.save(updated)
      store.upsertSession(updated)
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") {
        store.updateLastTurn(sessionId, (t) => {
          t.content = assistantContent || `Error: ${(err as Error).message}`
        })
      }
    } finally {
      props.onStreamEnd()
      setAbortController(null)
    }
  }

  return (
    <box
      flexDirection="column"
      height={COMPOSER_HEIGHT}
      borderStyle="single"
      borderColor={props.streaming ? theme.primary : theme.border}
      paddingLeft={1}
      paddingRight={1}
    >
      <input
        ref={inputRef}
        focused={!props.streaming}
        placeholder={props.streaming ? "● streaming  (esc to abort)" : "Message… (↵ send, q back)"}
        placeholderColor={theme.textDim}
        textColor={theme.text}
        flexGrow={1}
        onSubmit={() => {
          const text = inputRef?.value ?? ""
          if (!text.trim() || props.streaming) return
          if (inputRef) inputRef.value = ""
          void submit(text.trim())
        }}
        onKeyDown={(key) => {
          if (props.streaming && key.name === "escape") {
            abortController()?.abort()
          }
          if (!props.streaming && key.name === "q" && !inputRef?.value) {
            route.navigate({ type: "home" })
          }
        }}
      />
    </box>
  )
}
