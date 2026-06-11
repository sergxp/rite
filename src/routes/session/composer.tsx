import { createSignal, createEffect, createMemo, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { execa } from "execa"
import type { TextareaRenderable, KeyEvent } from "@opentui/core"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../context/config"
import { useSessionStore } from "../../context/session-store"
import { useRoute } from "../../context/route"
import { useExit } from "../../context/exit"
import { getBackend } from "../../backends/index"
import { drainAgentStream } from "../../backends/drain"
import { buildEnrichedPrompt } from "../../memory/enricher"
import { loadMemories } from "../../memory/reader"
import { semanticSearch } from "../../memory/embeddings"
import { extractMemories } from "../../extraction/extractor"
import { compressHistoryIfNeeded } from "../../history/compressor"
import { appendAuditEvent } from "../../audit/writer"
import { autoNameSession } from "../../sessions/namer"
import { SessionStore } from "../../sessions/store"
import { loadLoops, findLoop } from "../../loops/registry"
import { runLoopTui } from "../../loops/runner"
import { checkMemoryCompliance, TOOL_EVIDENCE_HEADER } from "../../loops/default-review"
import type { ConversationHistory } from "../../history/history"
import type { MemoryFile } from "../../memory/types"
import type { Session } from "../../sessions/types"

interface ComposerProps {
  session: Session
  history: ConversationHistory
  streaming: boolean
  onHeightChange: (h: number) => void
  onStreamStart: () => void
  onStreamEnd: () => void
  onStatus: (text: string) => void
}

const COMPOSER_BORDER_HEIGHT = 2 // border-top + border-bottom
const COMPOSER_MAX_INPUT_ROWS = 8

// Commands offered by tab/arrow autocomplete. Ordered so prefix matches list
// the way a user expects. Keep in sync with handleSlashCommand below.
const SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/copy",
  "/memory",
  "/model",
  "/resume",
  "/compact",
  "/loop",
  "/loop off",
  "/exit",
]

const CLAUDE_MODELS = ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]

function completionsFor(value: string): string[] {
  if (!value.startsWith("/") || value.length < 2) return []
  // Once the user types past the command into its arguments (a space that
  // isn't itself a command prefix like "/loop "), stop suggesting.
  return SLASH_COMMANDS.filter((cmd) => cmd.startsWith(value))
}

const HELP_TEXT = [
  "Commands:",
  "  /clear            clear AI context (new Claude CLI session)",
  "  /copy             copy last response to clipboard",
  "  /memory           show loaded memories",
  "  /model            show or switch model (claude backend only)",
  "  /resume           switch session (back to home)",
  "  /compact          compress conversation history",
  "  /loop             list available loops",
  "  /loop <name>      run a loop",
  "  /loop off         abort the running loop",
  "  /exit             quit",
].join("\n")

export function Composer(props: ComposerProps) {
  const theme = useTheme()
  const config = useConfig()
  const store = useSessionStore()
  const route = useRoute()
  const exit = useExit()

  const [abortController, setAbortController] = createSignal<AbortController | null>(null)
  let textareaRef: TextareaRenderable | undefined
  // When a loop step asks for human input, this holds the resolver; the next
  // submit feeds it instead of starting a chat turn.
  let loopInputResolver: ((answer: string) => void) | null = null

  const [inputLines, setInputLines] = createSignal(1)

  // Autocomplete: input value is mirrored into a signal via the textarea's
  // onContentChange event (fires on every insert AND delete).
  const [inputValue, setInputValue] = createSignal("")
  const [selectedIdx, setSelectedIdx] = createSignal(0)
  const suggestions = createMemo(() => (props.streaming ? [] : completionsFor(inputValue())))

  // Message queued while a stream is in progress — auto-submitted when streaming ends.
  const [queuedMessage, setQueuedMessage] = createSignal("")

  // Model picker state — when open, the textarea unfocuses and arrow keys/enter
  // drive selection. Escape closes without changing.
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  const [modelPickerIdx, setModelPickerIdx] = createSignal(0)
  // Header (1) + N model rows + footer hint (1)
  const modelPickerRows = () => (modelPickerOpen() ? CLAUDE_MODELS.length + 2 : 0)

  // Grow the composer to fit the current input lines + suggestions + picker.
  createEffect(() =>
    props.onHeightChange(COMPOSER_BORDER_HEIGHT + inputLines() + suggestions().length + modelPickerRows()),
  )

  // When streaming ends, fire any queued message automatically.
  createEffect(() => {
    if (!props.streaming) {
      const msg = queuedMessage()
      if (msg) {
        setQueuedMessage("")
        void (async () => {
          if (await handleSlashCommand(msg)) return
          await submit(msg)
        })()
      }
    }
  })

  // Drive the model picker globally so the unfocused textarea doesn't intercept keys.
  useKeyboard((key) => {
    if (!modelPickerOpen()) return
    if (key.name === "up") {
      setModelPickerIdx((i) => Math.max(0, i - 1))
    } else if (key.name === "down") {
      setModelPickerIdx((i) => Math.min(CLAUDE_MODELS.length - 1, i + 1))
    } else if (key.name === "return") {
      commitModelPick()
    } else if (key.name === "escape") {
      setModelPickerOpen(false)
    }
  })

  const sessionId = () => props.session.id

  function addSystem(content: string) {
    store.appendItem(sessionId(), { kind: "system", content })
  }

  async function copyLastResponse() {
    const items = store.store.items[sessionId()] ?? []
    const last = [...items].reverse().find((i) => i.kind === "assistant")
    if (!last || !("content" in last) || !last.content.trim()) {
      addSystem("Nothing to copy.")
      return
    }
    try {
      const cmd = process.platform === "darwin" ? "pbcopy" : "xclip"
      const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"]
      await execa(cmd, args, { input: last.content })
      addSystem("Copied last response to clipboard.")
    } catch {
      addSystem("Copy failed — clipboard tool not available.")
    }
  }

  function showMemories() {
    const loaded = loadMemories()
    if (loaded.all.length === 0) {
      addSystem("No memories loaded.")
      return
    }
    const lines = loaded.all.map(
      (m) => `${m.frontmatter.name}  [${m.tier} · ${m.frontmatter.inject}]`,
    )
    addSystem(`Loaded ${loaded.all.length} memorie(s):\n${lines.join("\n")}`)
  }

  function openModelPicker() {
    if (props.session.backend !== "claude") {
      addSystem("/model is only available with the claude backend.")
      return
    }
    const current = CLAUDE_MODELS.findIndex((m) => m === props.session.model)
    setModelPickerIdx(current >= 0 ? current : 0)
    setModelPickerOpen(true)
  }

  function commitModelPick() {
    const chosen = CLAUDE_MODELS[modelPickerIdx()]
    setModelPickerOpen(false)
    if (!chosen) return
    if (chosen === props.session.model) {
      addSystem(`Already using ${chosen}.`)
      return
    }
    props.session.model = chosen
    // Clear the Claude session so the next turn opens a fresh session with the new model.
    props.session.claudeSessionId = undefined
    void SessionStore.save(props.session)
    store.upsertSession({ ...props.session })
    addSystem(`Model switched to ${chosen}. Context cleared for new model.`)
  }

  function showOrSetModel(arg?: string) {
    if (props.session.backend !== "claude") {
      addSystem("/model is only available with the claude backend.")
      return
    }
    if (!arg) {
      openModelPicker()
      return
    }
    if (!CLAUDE_MODELS.includes(arg)) {
      addSystem(`Unknown model: ${arg}\nAvailable: ${CLAUDE_MODELS.join(", ")}`)
      return
    }
    props.session.model = arg
    props.session.claudeSessionId = undefined
    void SessionStore.save(props.session)
    store.upsertSession({ ...props.session })
    addSystem(`Model switched to ${arg}. Context cleared for new model.`)
  }

  function clearContext() {
    props.history.clear()
    props.session.claudeSessionId = undefined
    void SessionStore.save(props.session)
    addSystem("Context cleared — next message starts a fresh Claude session.")
  }

  async function compactHistory() {
    if (props.history.length === 0) {
      addSystem("No history to compact.")
      return
    }
    props.onStatus("✻ compacting…")
    try {
      await compressHistoryIfNeeded(props.history, { ...config, tokenBudget: 0 })
      addSystem("History compacted.")
    } finally {
      props.onStatus("")
    }
  }

  async function runLoop(name: string, context: string) {
    const loops = loadLoops()
    const loop = findLoop(name)
    if (!loop) {
      addSystem(`Loop not found: ${name}\nAvailable: ${loops.map((l) => l.name).join(", ") || "(none)"}`)
      return
    }

    const ac = new AbortController()
    setAbortController(ac)
    props.onStreamStart()
    addSystem(`Running loop: ${loop.name}`)
    try {
      await runLoopTui(loop, context, config, {
        onMessage: (text) => addSystem(text),
        waitForInput: (prompt) =>
          new Promise<string>((resolve) => {
            addSystem(prompt)
            loopInputResolver = resolve
          }),
        onStepStart: (_id, label, type) => props.onStatus(`⏳ ${label} (${type})`),
        onToken: (text) => {
          const items = store.store.items[sessionId()] ?? []
          const last = items[items.length - 1]
          if (last?.kind === "assistant" && last.streaming) {
            store.updateLastItem(sessionId(), (i) => {
              if (i.kind === "assistant") i.content += text
            })
          } else {
            store.appendItem(sessionId(), { kind: "assistant", content: text, streaming: true })
          }
        },
        onToolStatus: (name) => props.onStatus(`⏳ ${name}`),
      }, ac.signal)
    } catch (err) {
      addSystem(`Loop failed: ${(err as Error).message}`)
    } finally {
      store.updateLastItem(sessionId(), (i) => {
        if (i.kind === "assistant") i.streaming = false
      })
      loopInputResolver = null
      setAbortController(null)
      props.onStreamEnd()
    }
  }

  async function handleSlashCommand(trimmed: string): Promise<boolean> {
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit()
      return true
    }
    if (trimmed === "/help") {
      addSystem(HELP_TEXT)
      return true
    }
    if (trimmed === "/clear") {
      clearContext()
      return true
    }
    if (trimmed === "/copy") {
      await copyLastResponse()
      return true
    }
    if (trimmed === "/memory") {
      showMemories()
      return true
    }
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      const arg = trimmed === "/model" ? undefined : trimmed.slice("/model ".length).trim()
      showOrSetModel(arg)
      return true
    }
    if (trimmed === "/resume") {
      route.navigate({ type: "home" })
      return true
    }
    if (trimmed === "/compact") {
      await compactHistory()
      return true
    }
    if (trimmed === "/loop off" || trimmed === "/loop stop") {
      abortController()?.abort()
      return true
    }
    if (trimmed === "/loop") {
      const loops = loadLoops()
      addSystem(
        loops.length
          ? `Available loops:\n${loops.map((l) => `  ${l.name}${l.description ? ` — ${l.description}` : ""}`).join("\n")}\nRun one with /loop <name>`
          : "No loops found. Add YAML loop files to .rite/loops/",
      )
      return true
    }
    if (trimmed.startsWith("/loop ")) {
      // /loop <name> [context…] — everything after the name seeds the loop.
      const rest = trimmed.slice("/loop ".length).trim()
      const [name, ...ctx] = rest.split(/\s+/)
      void runLoop(name ?? "", ctx.join(" "))
      return true
    }
    if (trimmed.startsWith("/")) {
      addSystem(`Unknown command: ${trimmed}\nType /help for available commands.`)
      return true
    }
    return false
  }

  /**
   * Default system loop: after a normal turn, review the response against the
   * injected behavioral memories and, on failure, send up to 2 correction
   * turns (3 review passes total). Corrections feed the rolling history and
   * the transcript but are not persisted as user/assistant session turns —
   * they're Rite self-correcting, not new exchanges (matches v1). The reviewer
   * runs on the utility backend; any failure is swallowed so it never blocks
   * or corrupts a delivered response.
   */
  async function runComplianceReview(opts: {
    session: Session
    ac: AbortController
    injectedMemories: MemoryFile[]
    firstResponse: string
    firstToolEvidence: string[]
    alwaysMemories: MemoryFile[]
    semanticHits: MemoryFile[]
    shouldResume: boolean
  }) {
    const { session: s, ac, injectedMemories } = opts
    if (injectedMemories.length === 0) return

    let lastResponse = opts.firstResponse
    let toolEvidence = opts.firstToolEvidence

    for (let attempt = 0; attempt < 3; attempt++) {
      if (ac.signal.aborted) return

      props.onStatus("✻ reviewing…")
      const responseWithTools =
        toolEvidence.length > 0
          ? `${lastResponse}\n\n${TOOL_EVIDENCE_HEADER}\n${toolEvidence.join("\n")}`
          : lastResponse

      let review
      try {
        review = await checkMemoryCompliance(
          responseWithTools,
          injectedMemories,
          config,
          ac.signal,
          props.history.getTurns().slice(-6),
        )
      } catch {
        props.onStatus("")
        return
      }
      if (ac.signal.aborted || review.passed) {
        props.onStatus("")
        return
      }

      // Surface the reviewer's findings as a system notice.
      addSystem(`→ review (compliance): revising to follow memory guidelines\n${review.feedback}`)

      // Last allowed pass — report the unresolved issues and stop.
      if (attempt === 2) {
        addSystem(`Memory compliance unresolved after 3 attempts.\nPersistent issues:\n${review.feedback}`)
        props.onStatus("")
        return
      }

      // Correction turn: injected into history but not shown as a user message.
      props.onStatus(`✻ correcting (${attempt + 1})…`)
      const correctionMsg = `Please revise your previous response to correctly follow these memory guidelines:\n\n${review.feedback}\n\nProvide the corrected response only.`
      const correctionEnriched = buildEnrichedPrompt(
        correctionMsg,
        opts.shouldResume ? [] : opts.alwaysMemories,
        opts.semanticHits,
        props.history,
        !opts.shouldResume,
      )

      const sid = s.id
      let streamingLive = false
      let corrected
      try {
        corrected = await drainAgentStream(
          getBackend(s.backend)(correctionEnriched, ac.signal, {
            resumeSessionId: opts.shouldResume ? s.claudeSessionId : undefined,
          }),
          {
            onSessionId: (id) => {
              s.claudeSessionId = id
              void SessionStore.save(s)
            },
            // Stream the corrected text into a new assistant bubble. Tool and
            // thinking activity during a correction are evidence only (captured
            // via the return value), not rendered as separate items.
            onTextDelta: (accumulated) => {
              if (!streamingLive) {
                store.appendItem(sid, { kind: "assistant", content: "", streaming: true })
                streamingLive = true
              }
              store.updateLastItem(sid, (i) => {
                if (i.kind === "assistant") i.content = accumulated
              })
            },
          },
        )
      } catch {
        props.onStatus("")
        return
      }
      if (streamingLive) {
        store.updateLastItem(sid, (i) => {
          if (i.kind === "assistant") i.streaming = false
        })
      }

      const correctedResponse = corrected.text
      if (!correctedResponse.trim()) {
        props.onStatus("")
        return
      }

      // Feed the rolling history so later turns have the corrected context.
      props.history.add("user", correctionMsg)
      props.history.add("assistant", correctedResponse)
      s.updatedAt = new Date().toISOString()
      void SessionStore.save(s)

      lastResponse = correctedResponse
      toolEvidence = corrected.completedToolCalls
    }
    props.onStatus("")
  }

  async function submit(text: string) {
    const s = props.session
    const sid = s.id
    store.appendItem(sid, { kind: "user", content: text })
    props.onStreamStart()

    const ac = new AbortController()
    setAbortController(ac)

    try {
      // ── Memory gathering ─────────────────────────────────────────────────
      const loaded = loadMemories()
      const alwaysMemories = loaded.always
      let semanticHits: MemoryFile[] = []
      let semanticHitsWithScores: Array<{ file: MemoryFile; score: number }> = []
      if (loaded.semantic.length > 0) {
        props.onStatus("✻ recalling…")
        try {
          semanticHitsWithScores = await semanticSearch(text, loaded.semantic, 5)
          semanticHits = semanticHitsWithScores.map((h) => h.file)
        } catch {
          // graceful degradation — semantic memories skipped
        }
      }

      // Replicate buildEnrichedPrompt's deduplication so the audit reflects
      // exactly what ends up in the prompt, not the raw input lists.
      const alwaysPaths = new Set(alwaysMemories.map((m) => m.filePath))
      const dedupedSemantic = semanticHitsWithScores.filter((h) => !alwaysPaths.has(h.file.filePath))

      appendAuditEvent(sid, "prompt_sent", {
        userMessage: text,
        memoriesInjected: [
          ...alwaysMemories.map((m) => ({ source: "always", name: m.frontmatter.name, tier: m.tier })),
          ...dedupedSemantic.map((h) => ({ source: "semantic", name: h.file.frontmatter.name, tier: h.file.tier, score: h.score })),
        ],
        historyTurnCount: props.history.length,
        backend: s.backend,
        utilityBackend: config.utilityBackend,
      })

      // Claude CLI resume: when active, Claude already has the full conversation,
      // so history and always-memories are skipped. Semantic hits are re-injected —
      // they are per-message relevance matches.
      const shouldResume = !!s.claudeSessionId
      const enriched = buildEnrichedPrompt(
        text,
        shouldResume ? [] : alwaysMemories,
        semanticHits,
        props.history,
        !shouldResume,
      )

      // ── Stream the agent turn ────────────────────────────────────────────
      props.onStatus("")
      const backendFn = getBackend(s.backend)
      const stream = backendFn(enriched, ac.signal, {
        resumeSessionId: shouldResume ? s.claudeSessionId : undefined,
        model: s.model,
      })

      let streamingItemLive = false
      const finishStreamingItem = () => {
        if (streamingItemLive) {
          store.updateLastItem(sid, (i) => {
            if (i.kind === "assistant") i.streaming = false
          })
          streamingItemLive = false
        }
      }

      const { text: fullResponse, completedToolCalls } = await drainAgentStream(stream, {
        onSessionId: (id) => {
          s.claudeSessionId = id
          void SessionStore.save(s)
        },
        onThinkingDelta: () => props.onStatus("✻ thinking…"),
        onThinkingEnd: (thinking) => {
          props.onStatus("")
          finishStreamingItem()
          store.appendItem(sid, { kind: "thinking", content: thinking })
        },
        onTextDelta: (accumulated) => {
          if (!streamingItemLive) {
            store.appendItem(sid, { kind: "assistant", content: "", streaming: true })
            streamingItemLive = true
          }
          store.updateLastItem(sid, (i) => {
            if (i.kind === "assistant") i.content = accumulated
          })
        },
        onToolStart: (tool) => props.onStatus(`⏳ ${tool.name}`),
        onToolResult: (tool, result, isError) => {
          props.onStatus("")
          finishStreamingItem()
          store.appendItem(sid, {
            kind: "tool",
            name: tool.name,
            inputJson: tool.inputJson,
            result,
            isError,
            durationMs: Date.now() - tool.startedAt,
          })
        },
      })
      finishStreamingItem()

      if (!fullResponse.trim()) {
        throw new Error(`No response from ${s.backend}. Check the backend is installed and configured.`)
      }

      // ── Persist ──────────────────────────────────────────────────────────
      props.history.add("user", text)
      props.history.add("assistant", fullResponse)

      const isFirstTurn = s.turns.length === 0
      s.turns.push({ role: "user", content: text })
      s.turns.push({ role: "assistant", content: fullResponse })
      s.updatedAt = new Date().toISOString()
      const usedMems = [...alwaysMemories, ...semanticHits]
      const seen = new Set<string>()
      s.memoriesActive = usedMems
        .map((m) => ({ name: m.frontmatter.name, tier: m.tier, inject: m.frontmatter.inject }))
        .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
      await SessionStore.save(s)
      store.upsertSession({ ...s })

      if (isFirstTurn && s.name == null) {
        void autoNameSession(s.id, text, fullResponse, config, (name) => {
          s.name = name
          store.upsertSession({ ...s, name })
        })
      }

      appendAuditEvent(sid, "response_received", {
        rawResponse: fullResponse,
        backend: s.backend,
        charCount: fullResponse.length,
      })

      if (!ac.signal.aborted) {
        await compressHistoryIfNeeded(props.history, config)
      }

      if (!ac.signal.aborted) {
        void extractMemories(text, fullResponse, config, (count) => {
          props.onStatus(`* saved ${count}`)
          setTimeout(() => props.onStatus(""), 4000)
        }, sid)
      }

      // ── Default system loop: memory-compliance review ────────────────────
      // After every normal response, if behavioral memories were injected,
      // check the response against them and send correction turns on failure.
      if (!ac.signal.aborted) {
        await runComplianceReview({
          session: s,
          ac,
          injectedMemories: [...alwaysMemories, ...semanticHits],
          firstResponse: fullResponse,
          firstToolEvidence: completedToolCalls,
          alwaysMemories,
          semanticHits,
          shouldResume,
        })
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") {
        addSystem(`Error: ${(err as Error).message}`)
      } else {
        addSystem("Aborted.")
      }
    } finally {
      props.onStreamEnd()
      setAbortController(null)
    }
  }

  /** Replace the input with the highlighted suggestion (plus a trailing space). */
  function acceptSuggestion(): boolean {
    const sug = suggestions()
    if (sug.length === 0 || !textareaRef) return false
    const sel = sug[selectedIdx()] ?? sug[0]
    if (!sel) return false
    // Setting text emits `onContentChange`, which syncs inputValue and
    // recomputes suggestions; a fully-typed command then collapses the list.
    textareaRef.setText(sel.endsWith(" ") ? sel : `${sel} `)
    return true
  }

  function onComposerKey(key: KeyEvent) {
    // Autocomplete navigation takes priority and consumes the key (preventDefault
    // runs before the input's own handler — see InputRenderable dispatch order).
    if (suggestions().length > 0) {
      if (key.name === "up") {
        setSelectedIdx((i) => Math.max(0, i - 1))
        key.preventDefault()
        return
      }
      if (key.name === "down") {
        setSelectedIdx((i) => Math.min(suggestions().length - 1, i + 1))
        key.preventDefault()
        return
      }
      if (key.name === "tab") {
        acceptSuggestion()
        key.preventDefault()
        return
      }
    }

    if (props.streaming && key.name === "escape") {
      // preventDefault so the textarea doesn't blur (its default escape behavior).
      key.preventDefault()
      const ac = abortController()
      if (ac && !ac.signal.aborted) {
        ac.abort()
        props.onStatus("✻ aborting…")
      }
      return
    }
    if (!props.streaming && key.name === "q" && !textareaRef?.plainText) {
      route.navigate({ type: "home" })
    }
  }

  function onSubmit() {
    let text = (textareaRef?.plainText ?? "").trim()
    if (!text) return
    if (textareaRef) textareaRef.clear()

    // A waiting loop step consumes the input verbatim — no command parsing.
    if (loopInputResolver) {
      const resolve = loopInputResolver
      loopInputResolver = null
      store.appendItem(sessionId(), { kind: "user", content: text })
      resolve(text)
      return
    }

    // Resolve a partial slash command to the highlighted suggestion, so
    // typing "/me" + Enter runs /memory without a separate Tab.
    if (text.startsWith("/")) {
      const exact = SLASH_COMMANDS.includes(text) || text.startsWith("/loop ")
      if (!exact) {
        const matches = completionsFor(text)
        const sel = matches[selectedIdx()] ?? matches[0]
        if (sel) text = sel.trim()
      }
    }

    // Abort commands must work while a loop is streaming.
    if (text === "/loop off" || text === "/loop stop") {
      abortController()?.abort()
      return
    }
    // While streaming, queue the message and show a hint — it will fire automatically
    // when the current stream finishes.
    if (props.streaming) {
      setQueuedMessage(text)
      addSystem(`⏳ Queued: "${text.length > 60 ? text.slice(0, 60) + "…" : text}"`)
      return
    }

    void (async () => {
      if (await handleSlashCommand(text)) return
      await submit(text)
    })()
  }

  return (
    <box flexDirection="column" height={COMPOSER_BORDER_HEIGHT + inputLines() + suggestions().length + modelPickerRows()}>
      <Show when={modelPickerOpen()}>
        <box flexDirection="column" paddingLeft={2}>
          <text fg={theme.textMuted}>Select model (↑↓ navigate · ↵ pick · esc cancel):</text>
          <For each={CLAUDE_MODELS}>
            {(m, i) => (
              <text fg={i() === modelPickerIdx() ? theme.primary : theme.textMuted}>
                {i() === modelPickerIdx() ? "▶ " : "  "}
                {m}
                {m === props.session.model ? "  (current)" : ""}
              </text>
            )}
          </For>
          <text fg={theme.textDim}> </text>
        </box>
      </Show>

      <box
        flexDirection="column"
        height={COMPOSER_BORDER_HEIGHT + inputLines()}
        borderStyle="single"
        borderColor={props.streaming ? theme.primary : theme.border}
        paddingLeft={1}
        paddingRight={1}
      >
        <textarea
          ref={textareaRef}
          focused={!modelPickerOpen()}
          placeholder={props.streaming ? "● streaming  (esc to abort)" : "Message… (↵ send, shift+↵ newline, /help, q back)"}
          placeholderColor={theme.textDim}
          textColor={theme.text}
          wrapMode="word"
          flexGrow={1}
          minHeight={1}
          maxHeight={COMPOSER_MAX_INPUT_ROWS}
          onContentChange={() => {
            const value = textareaRef?.plainText ?? ""
            setInputValue(value)
            setSelectedIdx(0)
            setInputLines(Math.min(COMPOSER_MAX_INPUT_ROWS, Math.max(1, textareaRef?.virtualLineCount ?? 1)))
          }}
          onKeyDown={(key) => {
            // Enter without shift → submit; shift+Enter → newline (handled by textarea).
            if (key.name === "return" && !key.shift) {
              key.preventDefault()
              onSubmit()
              return
            }
            onComposerKey(key)
          }}
        />
      </box>

      <Show when={suggestions().length > 0}>
        <box flexDirection="column" paddingLeft={2}>
          <For each={suggestions()}>
            {(cmd, i) => (
              <text fg={i() === selectedIdx() ? theme.primary : theme.textMuted}>
                {i() === selectedIdx() ? "▶ " : "  "}
                {cmd}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
