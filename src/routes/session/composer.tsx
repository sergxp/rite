import { createSignal, createEffect, createMemo, For, Show, onCleanup } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
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
import { autoNameForkSession, autoNameSession } from "../../sessions/namer"
import { SessionStore } from "../../sessions/store"
import { loadLoops, findLoop } from "../../loops/registry"
import { runLoopTui } from "../../loops/runner"
import { checkMemoryCompliance, TOOL_EVIDENCE_HEADER } from "../../loops/default-review"
import { selectApplicableRules } from "../../loops/rule-selector"
import { copyToClipboard } from "../../utils/clipboard"
import { saveClipboardImage, nextPasteImagePath } from "../../utils/clipboard-image"
import {
  attachSession as attachCron,
  detachSession as detachCron,
  cancelAll as cancelAllCron,
  cancelTask as cancelCronTask,
  createOneShot as createOneShotCron,
  createRecurring as createRecurringCron,
  describeSchedule as describeCron,
  listTasks as listCronTasks,
  parseClockTime,
  parseDuration,
  MIN_INTERVAL_MS,
} from "../../scheduler/cron"
import { log } from "../../utils/logger"
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
  "/logs",
  "/memory",
  "/model",
  "/paste",
  "/resume",
  "/compact",
  "/fork",
  "/loop",
  "/loop off",
  "/cron",
  "/cron list",
  "/cron off",
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
  "  /logs             show log file paths (tail -f to follow)",
  "  /memory           show loaded memories",
  "  /model            show or switch model (claude backend only)",
  "  /paste            insert clipboard image as a file path token",
  "  /resume           switch session (back to home)",
  "  /compact          compress conversation history",
  "  /fork             create a parallel branch of the current session",
  "  /loop             list available loops",
  "  /loop <name>      run a loop",
  "  /loop off         abort the running loop",
  "  /cron             list scheduled tasks",
  "  /cron <int> <p>   schedule recurring (e.g. /cron 5m check the deploy)",
  "  /cron in <d> <p>  one-shot relative (e.g. /cron in 45m run the tests)",
  "  /cron at <t> <p>  one-shot clock time (e.g. /cron at 15:30 push branch)",
  "  /cron cancel <id> cancel a scheduled task",
  "  /cron off         cancel all scheduled tasks",
  "  /exit             quit",
].join("\n")

export function Composer(props: ComposerProps) {
  const theme = useTheme()
  const config = useConfig()
  const store = useSessionStore()
  const route = useRoute()
  const exit = useExit()
  const dimensions = useTerminalDimensions()

  const [abortController, setAbortController] = createSignal<AbortController | null>(null)
  let textareaRef: TextareaRenderable | undefined
  // When a loop step asks for human input, this holds the resolver; the next
  // submit feeds it instead of starting a chat turn.
  let loopInputResolver: ((answer: string) => void) | null = null

  const [inputLines, setInputLines] = createSignal(1)

  // Compute display rows for the textarea content: each explicit \n adds a
  // row, and each line that exceeds the visible width adds soft-wrap rows.
  // The opentui editor's virtualLineCount is clamped by viewport height so
  // it doesn't grow on shift+Enter; we derive the row count from plainText
  // + width so the composer expands as the user types.
  const computeInputLines = (text: string): number => {
    const innerWidth = Math.max(1, dimensions().width - 4) // 2 borders + 2 padding
    if (!text) return 1
    const lines = text.split("\n")
    let rows = 0
    for (const line of lines) {
      rows += Math.max(1, Math.ceil((line.length || 0) / innerWidth))
    }
    return Math.max(1, rows)
  }

  // Autocomplete: input value is mirrored into a signal via the textarea's
  // onContentChange event (fires on every insert AND delete).
  const [inputValue, setInputValue] = createSignal("")
  const [selectedIdx, setSelectedIdx] = createSignal(0)
  const suggestions = createMemo(() => (props.streaming ? [] : completionsFor(inputValue())))

  // Messages queued while a stream is in progress — drained FIFO when streaming
  // ends. An array (not a single slot) so a cron fire can't clobber a queued
  // user message, or vice versa; every writer's prompt eventually runs.
  const [queuedMessages, setQueuedMessages] = createSignal<string[]>([])
  const enqueueMessage = (text: string) => setQueuedMessages((q) => [...q, text])

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

  // Recompute input rows when terminal width changes (long-line wrap depends on width).
  createEffect(() => {
    dimensions().width
    setInputLines(Math.min(COMPOSER_MAX_INPUT_ROWS, computeInputLines(inputValue())))
  })

  // When streaming ends, drain the queue FIFO, one message per turn. The
  // `draining` flag closes the async gap between popping a message and
  // props.streaming flipping on — without it the effect re-runs on the queue
  // change and would launch a second submit concurrently. The final no-op
  // queue write re-triggers the effect once the in-flight message settles,
  // which both picks up the next message after a non-streaming slash command
  // and catches anything enqueued while we were draining.
  let draining = false
  createEffect(() => {
    if (props.streaming) return
    const q = queuedMessages()
    if (draining || q.length === 0) return
    draining = true
    const msg = q[0]
    setQueuedMessages((qq) => qq.slice(1))
    log.info("message.queued.fire", {
      sessionId: props.session.id,
      scope: "composer",
      textLen: msg.length,
      remaining: q.length - 1,
    })
    void (async () => {
      try {
        if (await handleSlashCommand(msg)) return
        await submit(msg)
      } finally {
        draining = false
        setQueuedMessages((qq) => qq.slice())
      }
    })()
  })

  // Track streaming on/off transitions for state-machine debugging.
  createEffect(() => {
    log.debug("streaming.transition", { sessionId: props.session.id, scope: "composer", streaming: props.streaming })
  })

  // Attach the rite-side cron scheduler to this session. Tasks loaded from
  // disk re-arm on attach; fresh tasks land in ~/.rite/sessions/<sid>/cron.json.
  // When a task fires we route it through the same path as user input: queue
  // if currently streaming, otherwise submit (or run if it's a slash command).
  attachCron(props.session.id, async (prompt) => {
    addSystem(`⏰ Scheduled task firing: "${prompt.length > 60 ? prompt.slice(0, 60) + "…" : prompt}"`)
    if (props.streaming) {
      enqueueMessage(prompt)
      return
    }
    if (await handleSlashCommand(prompt)) return
    await submit(prompt)
  })
  onCleanup(() => detachCron(props.session.id))

  // Track model picker open/close.
  createEffect(() => {
    log.debug("modelPicker.transition", { sessionId: props.session.id, scope: "composer", open: modelPickerOpen() })
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
    const ok = await copyToClipboard(last.content)
    addSystem(ok ? "Copied last response to clipboard." : "Copy failed — no clipboard tool available.")
  }

  async function pasteClipboardImage() {
    const sid = props.session.id
    const target = nextPasteImagePath(sid)
    props.onStatus("✻ pasting image…")
    const saved = await saveClipboardImage(target)
    props.onStatus("")
    if (!saved) {
      addSystem("No image found on the clipboard. Copy a screenshot first, then run /paste.")
      log.info("paste.image.empty", { sessionId: sid, scope: "composer" })
      return
    }
    log.info("paste.image.saved", { sessionId: sid, scope: "composer", path: saved })
    // Insert a path token into the composer at the cursor so the agent can
    // Read the file. A trailing space lets the user keep typing context.
    const token = `[image: ${saved}] `
    if (textareaRef) {
      textareaRef.insertText(token)
      setInputValue(textareaRef.plainText ?? "")
      setInputLines(Math.min(COMPOSER_MAX_INPUT_ROWS, computeInputLines(textareaRef.plainText ?? "")))
    }
    addSystem(`Image saved → ${saved}\nIncluded as a path token; the agent can read it on send.`)
  }

  // ---- /cron (scheduled prompts) --------------------------------------------

  function showCronTasks() {
    const tasks = listCronTasks(sessionId())
    if (tasks.length === 0) {
      addSystem("No scheduled tasks. Try /cron 5m check the build")
      return
    }
    const rows = tasks.map((t) => {
      const preview = t.prompt.length > 60 ? t.prompt.slice(0, 60) + "…" : t.prompt
      return `  ${t.id}  ${describeCron(t).padEnd(22)} ${preview}`
    })
    addSystem(`Scheduled tasks (${tasks.length}):\n${rows.join("\n")}\nCancel with /cron cancel <id>`)
  }

  function handleCronCreate(rest: string) {
    const sid = sessionId()
    // /cron in <duration> <prompt>
    if (rest.startsWith("in ")) {
      const parts = rest.slice(3).trim().split(/\s+/)
      const dur = parts.shift() ?? ""
      const ms = parseDuration(dur)
      const prompt = parts.join(" ").trim()
      if (ms == null || !prompt) {
        addSystem("Usage: /cron in <duration> <prompt>   e.g. /cron in 45m check the tests")
        return
      }
      const task = createOneShotCron(sid, Date.now() + ms, prompt)
      addSystem(`Scheduled ${task.id}: fires once in ${dur} → "${prompt}"`)
      return
    }
    // /cron at <HH:MM|3pm> <prompt>
    if (rest.startsWith("at ")) {
      const parts = rest.slice(3).trim().split(/\s+/)
      const when = parts.shift() ?? ""
      const prompt = parts.join(" ").trim()
      const fireAt = parseClockTime(when)
      if (fireAt == null || !prompt) {
        addSystem("Usage: /cron at <HH:MM|3pm> <prompt>   e.g. /cron at 15:30 push release branch")
        return
      }
      const task = createOneShotCron(sid, fireAt, prompt)
      addSystem(`Scheduled ${task.id}: fires once at ${new Date(fireAt).toLocaleString()} → "${prompt}"`)
      return
    }
    // /cron <interval> <prompt>  (recurring)
    const parts = rest.split(/\s+/)
    const ivStr = parts.shift() ?? ""
    const iv = parseDuration(ivStr)
    const prompt = parts.join(" ").trim()
    if (iv == null || !prompt) {
      addSystem(
        [
          "Usage:",
          "  /cron <interval> <prompt>     recurring (e.g. /cron 5m check the deploy)",
          "  /cron in <duration> <prompt>  one-shot relative",
          "  /cron at <time> <prompt>      one-shot at clock time",
          "  /cron list                    show scheduled tasks",
          "  /cron cancel <id>             cancel one task",
          "  /cron off                     cancel all tasks",
        ].join("\n"),
      )
      return
    }
    const task = createRecurringCron(sid, iv, prompt)
    const note = iv < MIN_INTERVAL_MS ? ` (clamped to ${MIN_INTERVAL_MS / 1000}s minimum)` : ""
    addSystem(`Scheduled ${task.id}: ${describeCron(task)}${note} → "${prompt}"   (auto-expires after 7d)`)
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
    const prev = props.session.model
    props.session.model = chosen
    props.session.claudeSessionId = undefined
    log.info("model.switch", { sessionId: props.session.id, scope: "composer", from: prev, to: chosen })
    SessionStore.save(props.session).catch((err) => log.warn("session.save.failed", { sessionId: props.session.id, scope: "composer", err }))
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
    const prev = props.session.model
    props.session.model = arg
    props.session.claudeSessionId = undefined
    log.info("model.switch", { sessionId: props.session.id, scope: "composer", from: prev, to: arg, via: "arg" })
    SessionStore.save(props.session).catch((err) => log.warn("session.save.failed", { sessionId: props.session.id, scope: "composer", err }))
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
    if (trimmed === "/fork") {
      try {
        const forked = await SessionStore.fork(props.session.id, process.cwd())
        if (forked) {
          // Parent might have been assigned a groupId, update it in the UI store
          const parent = await SessionStore.load(props.session.id, process.cwd())
          if (parent) store.upsertSession(parent)

          store.upsertSession(forked)
          void autoNameForkSession(forked.id, forked.turns, config, (name) => {
            store.upsertSession({ ...forked, name })
          })
          addSystem(`Forked session into new branch: ${forked.name ?? "Fork"}`)
          route.navigate({ type: "session", sessionId: forked.id })
        } else {
          addSystem("Failed to fork session.")
        }
      } catch (err) {
        addSystem(`Failed to fork: ${(err as Error).message}`)
      }
      return true
    }
    if (trimmed === "/paste") {
      await pasteClipboardImage()
      return true
    }
    if (trimmed === "/logs") {
      const { logPath, sessionLogPath, getLogLevel } = await import("../../utils/logger")
      const lines = [
        `Log level: ${getLogLevel()} (set RITE_LOG_LEVEL=trace|debug|info|warn|error)`,
        `Daily log:   ${logPath()}`,
        `Session log: ${sessionLogPath(props.session.id)}`,
        `Tail with:   tail -f "${sessionLogPath(props.session.id)}"`,
      ]
      addSystem(lines.join("\n"))
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
    if (trimmed === "/cron" || trimmed === "/cron list") {
      showCronTasks()
      return true
    }
    if (trimmed === "/cron off") {
      const n = cancelAllCron(sessionId())
      addSystem(n > 0 ? `Cancelled ${n} scheduled task(s).` : "No scheduled tasks to cancel.")
      return true
    }
    if (trimmed.startsWith("/cron cancel ")) {
      const id = trimmed.slice("/cron cancel ".length).trim()
      const ok = cancelCronTask(sessionId(), id)
      addSystem(ok ? `Cancelled scheduled task ${id}.` : `No scheduled task with id ${id}.`)
      return true
    }
    if (trimmed.startsWith("/cron ")) {
      handleCronCreate(trimmed.slice("/cron ".length).trim())
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
    const rlog = log.child("review", { sessionId: s.id })
    rlog.info("review.start", { memoryCount: injectedMemories.length, responseLen: opts.firstResponse.length, toolEvidence: opts.firstToolEvidence.length })

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
      } catch (err) {
        rlog.warn("review.failed", { attempt, err })
        props.onStatus("")
        return
      }
      rlog.info("review.result", { attempt, passed: review.passed, feedbackLen: review.feedback?.length ?? 0 })
      if (ac.signal.aborted) {
        props.onStatus("")
        return
      }
      if (review.passed) {
        if (attempt === 0) {
          addSystem(`✓ review (compliance): passed — ${injectedMemories.length} memor${injectedMemories.length === 1 ? "y" : "ies"} checked`)
        } else {
          addSystem(`✓ review (compliance): passed after ${attempt} correction${attempt === 1 ? "" : "s"}`)
        }
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
    const turnId = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const tlog = log.child("composer.submit", { sessionId: sid, turnId, model: s.model })
    tlog.info("turn.begin", { textLen: text.length, backend: s.backend, hasResume: !!s.claudeSessionId })
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
          tlog.debug("memory.semantic", {
            candidates: loaded.semantic.length,
            hits: semanticHits.length,
            top: semanticHitsWithScores.slice(0, 5).map((h) => ({ name: h.file.frontmatter.name, score: h.score })),
          })
        } catch (err) {
          tlog.warn("memory.semantic.failed", { err })
        }
      }

      // Replicate buildEnrichedPrompt's deduplication so the audit reflects
      // exactly what ends up in the prompt, not the raw input lists.
      const alwaysPaths = new Set(alwaysMemories.map((m) => m.filePath))
      const dedupedSemantic = semanticHitsWithScores.filter((h) => !alwaysPaths.has(h.file.filePath))

      // ── Pre-agent rule selection ─────────────────────────────────────────
      // Default loop step 1: ask the utility LLM which candidate rules
      // (always + semantic) actually apply to THIS request. The selected
      // subset drives both injection and the post-response review, so the
      // agent and the reviewer share one set of relevant rules.
      const candidateMemories = [...alwaysMemories, ...dedupedSemantic.map((h) => h.file)]
      let selectedMemories = candidateMemories
      let selectionRationale = ""
      if (candidateMemories.length > 0 && !ac.signal.aborted) {
        props.onStatus("✻ selecting rules…")
        try {
          const sel = await selectApplicableRules(
            text,
            candidateMemories,
            config,
            ac.signal,
            props.history.getTurns().slice(-6),
          )
          selectedMemories = sel.selected
          selectionRationale = sel.rationale
          tlog.info("rule.select", {
            candidateCount: candidateMemories.length,
            selectedCount: selectedMemories.length,
            selected: sel.selectedNames,
            rationale: sel.rationale,
          })
          if (selectedMemories.length < candidateMemories.length) {
            const rationaleSuffix = selectionRationale ? ` — ${selectionRationale}` : ""
            addSystem(`✓ rules: selected ${selectedMemories.length} of ${candidateMemories.length}${rationaleSuffix}`)
          }
        } catch (err) {
          tlog.warn("rule.select.failed", { err })
        }
      }
      const selectedPaths = new Set(selectedMemories.map((m) => m.filePath))
      const filteredAlways = alwaysMemories.filter((m) => selectedPaths.has(m.filePath))
      const filteredSemanticHits = semanticHits.filter((m) => selectedPaths.has(m.filePath))

      tlog.info("memory.injected", {
        alwaysCount: filteredAlways.length,
        dedupedSemanticCount: filteredSemanticHits.length,
        always: filteredAlways.map((m) => ({ name: m.frontmatter.name, tier: m.tier, priority: m.frontmatter.priority })),
        semantic: filteredSemanticHits.map((m) => ({ name: m.frontmatter.name, tier: m.tier })),
      })

      appendAuditEvent(sid, "prompt_sent", {
        userMessage: text,
        candidateMemories: candidateMemories.map((m) => ({ name: m.frontmatter.name, tier: m.tier })),
        selectionRationale,
        memoriesInjected: [
          ...filteredAlways.map((m) => ({ source: "always", name: m.frontmatter.name, tier: m.tier })),
          ...filteredSemanticHits.map((m) => ({ source: "semantic", name: m.frontmatter.name, tier: m.tier })),
        ],
        historyTurnCount: props.history.length,
        backend: s.backend,
        utilityBackend: config.utilityBackend,
      })

      // Claude CLI resume: when active, Claude already has the full conversation,
      // so history and always-memories are skipped. Semantic hits are re-injected —
      // they are per-message relevance matches.
      const shouldResume = !!s.claudeSessionId
      const tBuildStart = Date.now()
      const enriched = buildEnrichedPrompt(
        text,
        shouldResume ? [] : filteredAlways,
        filteredSemanticHits,
        props.history,
        !shouldResume,
      )
      tlog.debug("prompt.enriched", {
        enrichedLen: enriched.length,
        userLen: text.length,
        alwaysCount: shouldResume ? 0 : filteredAlways.length,
        semanticCount: semanticHits.length,
        historyTurns: props.history.length,
        shouldResume,
        buildMs: Date.now() - tBuildStart,
      })
      // Full prompt is gated to trace level to keep submit latency low —
      // it's a multi-KB write that synchronously hits two log files (now async,
      // but still expensive). Set RITE_LOG_LEVEL=trace to capture it.
      tlog.trace("prompt.enriched.full", { prompt: enriched })

      // ── Stream the agent turn ────────────────────────────────────────────
      props.onStatus("")
      const backendFn = getBackend(s.backend)
      const stream = backendFn(enriched, ac.signal, {
        resumeSessionId: shouldResume ? s.claudeSessionId : undefined,
        model: s.model,
        turnId,
        sessionId: sid,
      })
      tlog.info("submit.handoff", { sessionId: sid, turnId })

      let streamingItemLive = false
      const toolItemIndex = new Map<string, number>()
      let thinkingItemIndex: number | null = null
      const finishStreamingItem = () => {
        if (streamingItemLive) {
          store.updateLastItem(sid, (i) => {
            if (i.kind === "assistant") i.streaming = false
          })
          streamingItemLive = false
        }
      }

      // Run the drain in the background. The await below races it against the
      // abort signal so the user gets the TUI back as soon as ESC fires —
      // even if the subprocess is mid-bash and will not close stdout for
      // minutes. After abort, all drain callbacks no-op via ac.signal.aborted.
      const drainPromise = drainAgentStream(stream, {
        onSessionId: (id) => {
          if (ac.signal.aborted) return
          s.claudeSessionId = id
          void SessionStore.save(s)
        },
        onThinkingDelta: (accumulated) => {
          if (ac.signal.aborted) return
          props.onStatus("✻ thinking…")
          finishStreamingItem()
          if (thinkingItemIndex === null) {
            const items = store.store.items[sid] ?? []
            thinkingItemIndex = items.length
            store.appendItem(sid, { kind: "thinking", content: accumulated, streaming: true })
          } else {
            store.updateItemAt(sid, thinkingItemIndex, (i) => {
              if (i.kind === "thinking") i.content = accumulated
            })
          }
        },
        onThinkingEnd: (thinking) => {
          if (ac.signal.aborted) return
          props.onStatus("")
          if (thinkingItemIndex !== null) {
            const idx = thinkingItemIndex
            thinkingItemIndex = null
            store.updateItemAt(sid, idx, (i) => {
              if (i.kind === "thinking") {
                i.content = thinking
                i.streaming = false
              }
            })
          } else {
            // Drain emitted end without any deltas (defensive). Append a finalized item.
            finishStreamingItem()
            store.appendItem(sid, { kind: "thinking", content: thinking })
          }
        },
        onTextDelta: (accumulated) => {
          if (ac.signal.aborted) return
          if (!streamingItemLive) {
            store.appendItem(sid, { kind: "assistant", content: "", streaming: true })
            streamingItemLive = true
          }
          store.updateLastItem(sid, (i) => {
            if (i.kind === "assistant") i.content = accumulated
          })
        },
        onToolStart: (tool) => {
          if (ac.signal.aborted) return
          props.onStatus(`⏳ ${tool.name}`)
        },
        onToolReady: (tool, id) => {
          if (ac.signal.aborted) return
          finishStreamingItem()
          const items = store.store.items[sid] ?? []
          toolItemIndex.set(id, items.length)
          store.appendItem(sid, {
            kind: "tool",
            name: tool.name,
            inputJson: tool.inputJson,
            result: "",
            isError: false,
            durationMs: 0,
            running: true,
          })
        },
        onToolResult: (tool, result, isError, id) => {
          if (ac.signal.aborted) return
          props.onStatus("")
          const idx = toolItemIndex.get(id)
          toolItemIndex.delete(id)
          if (idx !== undefined) {
            store.updateItemAt(sid, idx, (i) => {
              if (i.kind === "tool") {
                i.result = result
                i.isError = isError
                i.durationMs = Date.now() - tool.startedAt
                i.running = false
                // Backfill input in case the running item was appended before tool_done streamed final input.
                if (tool.inputJson) i.inputJson = tool.inputJson
              }
            })
          } else {
            // Fallback: tool_done was never seen (early termination?). Append a finished item.
            finishStreamingItem()
            store.appendItem(sid, {
              kind: "tool",
              name: tool.name,
              inputJson: tool.inputJson,
              result,
              isError,
              durationMs: Date.now() - tool.startedAt,
            })
          }
        },
      }, { logFields: { sessionId: sid, turnId } })

      // Resolves when the user aborts — allows us to free the UI immediately
      // even if the subprocess hasn't closed yet.
      const abortPromise = new Promise<"aborted">((resolve) => {
        if (ac.signal.aborted) return resolve("aborted")
        ac.signal.addEventListener("abort", () => resolve("aborted"), { once: true })
      })

      const raced = await Promise.race([drainPromise, abortPromise])
      if (raced === "aborted") {
        tlog.info("turn.aborted.released", { sessionId: sid, turnId })
        finishStreamingItem()
        // Flip any still-running tool items to a clean aborted state so the UI
        // doesn't keep showing "⏳ … running…" forever in the transcript.
        for (const idx of toolItemIndex.values()) {
          store.updateItemAt(sid, idx, (i) => {
            if (i.kind === "tool" && i.running) {
              i.running = false
              i.isError = true
              i.result = "(aborted)"
            }
          })
        }
        toolItemIndex.clear()
        // Let the drain finish (subprocess teardown) in the background. Its
        // callbacks are gated on ac.signal.aborted so they won't touch the UI.
        drainPromise.catch(() => {
          /* aborted; swallow */
        })
        return
      }
      const { text: fullResponse, completedToolCalls } = raced
      finishStreamingItem()
      // Defensive: drain ended cleanly but a tool never produced a result. Mark
      // any leftover running items as completed-without-result.
      for (const idx of toolItemIndex.values()) {
        store.updateItemAt(sid, idx, (i) => {
          if (i.kind === "tool" && i.running) i.running = false
        })
      }
      toolItemIndex.clear()

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
      const usedMems = selectedMemories
      const seen = new Set<string>()
      s.memoriesActive = usedMems
        .map((m) => ({ name: m.frontmatter.name, tier: m.tier, inject: m.frontmatter.inject }))
        .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
      await SessionStore.save(s)
      store.upsertSession({ ...s })

      if (isFirstTurn && s.name == null) {
        autoNameSession(s.id, text, fullResponse, config, (name) => {
          s.name = name
          store.upsertSession({ ...s, name })
          tlog.info("session.named", { name })
        }).catch((err) => tlog.warn("session.autoname.failed", { err }))
      }

      appendAuditEvent(sid, "response_received", {
        rawResponse: fullResponse,
        backend: s.backend,
        charCount: fullResponse.length,
      })

      if (!ac.signal.aborted) {
        try {
          await compressHistoryIfNeeded(props.history, config, ac.signal, props.onStatus)
        } catch (err) {
          tlog.warn("history.compress.failed", { err })
        }
      }

      if (!ac.signal.aborted) {
        extractMemories(text, fullResponse, config, (count) => {
          props.onStatus(`* saved ${count}`)
          tlog.info("memory.extracted", { count })
          setTimeout(() => props.onStatus(""), 4000)
        }, sid).catch((err) => tlog.warn("memory.extract.failed", { err }))
      }

      // ── Default system loop: memory-compliance review ────────────────────
      // Step 3 of the default loop: review the response against the EXACT
      // rules that were selected/injected in step 1. Same rule set drives
      // injection and the compliance bar.
      if (!ac.signal.aborted) {
        await runComplianceReview({
          session: s,
          ac,
          injectedMemories: selectedMemories,
          firstResponse: fullResponse,
          firstToolEvidence: completedToolCalls,
          alwaysMemories: filteredAlways,
          semanticHits: filteredSemanticHits,
          shouldResume,
        })
      }
    } catch (err: unknown) {
      if ((err as Error)?.name !== "AbortError") {
        tlog.error("turn.error", { err })
        addSystem(`Error: ${(err as Error).message}`)
      } else {
        tlog.info("turn.aborted")
        addSystem("Aborted.")
      }
    } finally {
      tlog.debug("turn.finalize", { aborted: ac.signal.aborted })
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
    const value = sel.endsWith(" ") ? sel : `${sel} `
    textareaRef.setText(value)
    // setText leaves the cursor at offset 0 — move it to the end so the user
    // can immediately type the command's argument (or backspace) from there.
    textareaRef.cursorOffset = value.length
    return true
  }

  function onComposerKey(key: KeyEvent) {
    log.trace("key", {
      sessionId: props.session.id,
      scope: "composer",
      name: key.name,
      ctrl: key.ctrl,
      shift: key.shift,
      meta: key.meta,
      streaming: props.streaming,
      pickerOpen: modelPickerOpen(),
      suggestions: suggestions().length,
    })
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
        log.info("user.abort", { sessionId: props.session.id, scope: "composer" })
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
      const exact = SLASH_COMMANDS.includes(text) || text.startsWith("/loop ") || text.startsWith("/cron ")
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
      enqueueMessage(text)
      log.info("message.queued", { sessionId: props.session.id, scope: "composer", textLen: text.length })
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
                {`${i() === modelPickerIdx() ? "▶ " : "  "}${m}${m === props.session.model ? "  (current)" : ""}`}
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
          focusedTextColor={theme.text}
          wrapMode="word"
          flexGrow={1}
          minHeight={1}
          maxHeight={COMPOSER_MAX_INPUT_ROWS}
          onContentChange={() => {
            const value = textareaRef?.plainText ?? ""
            setInputValue(value)
            setSelectedIdx(0)
            // virtualLineCount is clamped by the editor's viewport height, so
            // it never grows past the initial 1-row size and the composer
            // refused to expand on shift+Enter. Compute the row count from
            // the actual text + width-aware soft-wraps so explicit newlines
            // and long-line wraps both expand the input box.
            setInputLines(Math.min(COMPOSER_MAX_INPUT_ROWS, computeInputLines(value)))
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
                {`${i() === selectedIdx() ? "▶ " : "  "}${cmd}`}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}
