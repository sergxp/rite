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
import { copyToClipboard } from "../../utils/clipboard"
import { saveClipboardImage, nextAttachmentImagePath } from "../../utils/clipboard-image"
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

interface ReviewDraft {
  id: string
  feedback: string
  prompt: string
  memoryCount: number
}

const COMPOSER_BORDER_HEIGHT = 2 // border-top + border-bottom
const COMPOSER_MAX_INPUT_ROWS = 8
const REVIEW_DRAFT_ROWS = 6

// Commands offered by tab/arrow autocomplete. Ordered so prefix matches list
// the way a user expects. Keep in sync with handleSlashCommand below.
const SLASH_COMMANDS = [
  "/help",
  "/clear",
  "/copy",
  "/logs",
  "/memory",
  "/model",
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
  "  alt+v             insert clipboard image as a file path token",
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
  const [reviewDraft, setReviewDraft] = createSignal<ReviewDraft | null>(null)
  // Header (1) + N model rows + footer hint (1)
  const modelPickerRows = () => (modelPickerOpen() ? CLAUDE_MODELS.length + 2 : 0)
  const reviewDraftRows = () => (reviewDraft() ? REVIEW_DRAFT_ROWS : 0)

  // Loop picker state — same pattern as model picker.
  const [loopPickerOpen, setLoopPickerOpen] = createSignal(false)
  const [loopPickerIdx, setLoopPickerIdx] = createSignal(0)
  const [loopPickerItems, setLoopPickerItems] = createSignal<import("../../loops/types").Loop[]>([])
  const loopPickerRows = () => (loopPickerOpen() ? loopPickerItems().length + 2 : 0)

  // Grow the composer to fit the current input lines + suggestions + picker.
  createEffect(() =>
    props.onHeightChange(COMPOSER_BORDER_HEIGHT + inputLines() + suggestions().length + modelPickerRows() + loopPickerRows() + reviewDraftRows()),
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
  let disposed = false
  onCleanup(() => {
    disposed = true
    detachCron(props.session.id)
  })

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

  // Drive the loop picker — same pattern as model picker.
  useKeyboard((key) => {
    if (!loopPickerOpen()) return
    if (key.name === "up") {
      setLoopPickerIdx((i) => Math.max(0, i - 1))
    } else if (key.name === "down") {
      setLoopPickerIdx((i) => Math.min(loopPickerItems().length - 1, i + 1))
    } else if (key.name === "return") {
      commitLoopPick()
    } else if (key.name === "escape") {
      setLoopPickerOpen(false)
    }
  })

  const sessionId = () => props.session.id

  function addSystem(content: string) {
    store.appendItem(sessionId(), { kind: "system", content })
  }

  function editReviewDraft() {
    const draft = reviewDraft()
    if (!draft || !textareaRef) return
    textareaRef.setText(draft.prompt)
    textareaRef.cursorOffset = draft.prompt.length
    setInputValue(draft.prompt)
    setInputLines(Math.min(COMPOSER_MAX_INPUT_ROWS, computeInputLines(draft.prompt)))
    setReviewDraft(null)
  }

  function sendReviewDraft() {
    const draft = reviewDraft()
    if (!draft) return
    setReviewDraft(null)
    if (props.streaming) {
      enqueueMessage(draft.prompt)
      addSystem("Queued background review follow-up.")
      return
    }
    void submit(draft.prompt)
  }

  function reviewSummary(draft: ReviewDraft): string {
    const singleLine = draft.feedback.replace(/\s+/g, " ").trim()
    return singleLine.length > 110 ? `${singleLine.slice(0, 107)}...` : singleLine
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
    const target = nextAttachmentImagePath(sid)
    props.onStatus("✻ pasting image…")
    const saved = await saveClipboardImage(target)
    props.onStatus("")
    if (!saved) {
      addSystem("No image found on the clipboard. Copy a screenshot first, then press Alt+V.")
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
    addSystem(`Image attached → ${saved}\nIncluded as a path token; keep typing or press Alt+V again to add more.`)
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

  function openLoopPicker() {
    const loops = loadLoops()
    if (loops.length === 0) {
      addSystem("No loops found. Add JSON loop files to ~/.rite/loops/ or .rite/loops/")
      return
    }
    setLoopPickerItems(loops)
    setLoopPickerIdx(0)
    setLoopPickerOpen(true)
  }

  function commitLoopPick() {
    const loop = loopPickerItems()[loopPickerIdx()]
    setLoopPickerOpen(false)
    if (!loop) return
    props.session.activeLoop = loop.name
    SessionStore.save(props.session).catch(() => {})
    store.upsertSession({ ...props.session })
    addSystem(`Loop mode: ${loop.name}${loop.description ? ` — ${loop.description}` : ""}\nDefault system loop disabled. Run /loop off to return to normal.`)
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

  function makeLoopThinkingCallbacks(sid: string) {
    let thinkingIdx: number | null = null
    return {
      onThinkingDelta: (accumulated: string) => {
        props.onStatus("✻ thinking…")
        if (thinkingIdx === null) {
          const items = store.store.items[sid] ?? []
          thinkingIdx = items.length
          store.appendItem(sid, { kind: "thinking", content: accumulated, streaming: true })
        } else {
          store.updateItemAt(sid, thinkingIdx, (i) => { if (i.kind === "thinking") i.content = accumulated })
        }
      },
      onThinkingEnd: (text: string) => {
        props.onStatus("")
        if (thinkingIdx !== null) {
          const idx = thinkingIdx
          thinkingIdx = null
          store.updateItemAt(sid, idx, (i) => { if (i.kind === "thinking") { i.content = text; i.streaming = false } })
        }
      },
    }
  }

  function makeLoopToolCallbacks(sid: string) {
    const toolItemIndex = new Map<string, number>()
    const startedAt = new Map<string, number>()
    return {
      onToolCall: (name: string, id: string) => {
        props.onStatus(`⏳ ${name}`)
        startedAt.set(id, Date.now())
        const items = store.store.items[sid] ?? []
        toolItemIndex.set(id, items.length)
        store.appendItem(sid, { kind: "tool", name, inputJson: "", result: "", isError: false, durationMs: 0, running: true })
      },
      onToolDone: (name: string, id: string, inputJson: string) => {
        const idx = toolItemIndex.get(id)
        if (idx !== undefined) {
          store.updateItemAt(sid, idx, (i) => { if (i.kind === "tool") i.inputJson = inputJson })
        }
      },
      onToolResult: (id: string, result: string, isError: boolean) => {
        props.onStatus("")
        const idx = toolItemIndex.get(id)
        toolItemIndex.delete(id)
        const dur = Date.now() - (startedAt.get(id) ?? Date.now())
        startedAt.delete(id)
        if (idx !== undefined) {
          store.updateItemAt(sid, idx, (i) => {
            if (i.kind === "tool") { i.result = result; i.isError = isError; i.durationMs = dur; i.running = false }
          })
        }
      },
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
    const sid = sessionId()
    try {
      await runLoopTui(loop, context, config, {
        onMessage: (text) => addSystem(text),
        waitForInput: (prompt) =>
          new Promise<string>((resolve) => {
            addSystem(prompt)
            loopInputResolver = resolve
          }),
        onStepStart: (stepId, label, type, stepIndex, stepTotal) => {
          props.onStatus(`⏳ ${label} (${type})`)
          store.appendItem(sid, { kind: "loop-step", loopName: loop.name, stepId, stepLabel: label, stepType: type, stepIndex, stepTotal })
        },
        onToken: (text) => {
          const items = store.store.items[sid] ?? []
          const last = items[items.length - 1]
          if (last?.kind === "assistant" && last.streaming) {
            store.updateLastItem(sid, (i) => {
              if (i.kind === "assistant") i.content += text
            })
          } else {
            store.appendItem(sid, { kind: "assistant", content: text, streaming: true })
          }
        },
        onToolStatus: (name) => props.onStatus(`⏳ ${name}`),
        ...makeLoopThinkingCallbacks(sid),
        ...makeLoopToolCallbacks(sid),
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
      if (props.session.activeLoop) {
        const prev = props.session.activeLoop
        props.session.activeLoop = undefined
        SessionStore.save(props.session).catch(() => {})
        store.upsertSession({ ...props.session })
        addSystem(`Loop mode off (was: ${prev}). Default system loop restored.`)
      }
      return true
    }
    if (trimmed === "/loop") {
      openLoopPicker()
      return true
    }
    if (trimmed.startsWith("/loop ")) {
      // /loop <name> — set loop mode directly by name
      const name = trimmed.slice("/loop ".length).trim()
      const loop = findLoop(name)
      if (!loop) {
        const loops = loadLoops()
        addSystem(`Loop not found: "${name}"\nAvailable: ${loops.map((l) => l.name).join(", ") || "(none)"}`)
      } else {
        props.session.activeLoop = loop.name
        SessionStore.save(props.session).catch(() => {})
        store.upsertSession({ ...props.session })
        addSystem(`Loop mode: ${loop.name}${loop.description ? ` — ${loop.description}` : ""}\nDefault system loop disabled. Run /loop off to return to normal.`)
      }
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
   * Background review: after a normal turn, review the delivered response
   * against injected behavioral memories. Findings become a user-controlled
   * draft card; Rite never sends the review back to the agent automatically.
   */
  async function runComplianceReviewDraft(opts: {
    session: Session
    ac: AbortController
    injectedMemories: MemoryFile[]
    response: string
    toolEvidence: string[]
  }) {
    const { session: s, ac, injectedMemories } = opts
    if (injectedMemories.length === 0) return
    const rlog = log.child("review", { sessionId: s.id })
    rlog.info("review.start.background", { memoryCount: injectedMemories.length, responseLen: opts.response.length, toolEvidence: opts.toolEvidence.length })

    const responseWithTools =
      opts.toolEvidence.length > 0
        ? `${opts.response}\n\n${TOOL_EVIDENCE_HEADER}\n${opts.toolEvidence.join("\n")}`
        : opts.response

    try {
      const review = await checkMemoryCompliance(
        responseWithTools,
        injectedMemories,
        config,
        ac.signal,
        props.history.getTurns().slice(-6),
      )
      rlog.info("review.result.background", { passed: review.passed, feedbackLen: review.feedback?.length ?? 0 })
      if (disposed || ac.signal.aborted || review.passed || !review.feedback.trim()) return

      const prompt = [
        "Please revise your previous response to address this background review.",
        "",
        review.feedback.trim(),
      ].join("\n")
      setReviewDraft({
        id: `review-${Date.now().toString(36)}`,
        feedback: review.feedback.trim(),
        prompt,
        memoryCount: injectedMemories.length,
      })
    } catch (err) {
      rlog.warn("review.failed.background", { err })
    }
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

    // ── Loop mode short-circuit ───────────────────────────────────────────
    // When a loop is active the user's message goes straight to the loop's
    // first step — the main agent does NOT run. The loop owns the full turn.
    if (s.activeLoop) {
      const loop = findLoop(s.activeLoop)
      if (!loop) {
        addSystem(`Loop "${s.activeLoop}" no longer found — run /loop to pick another or /loop off to disable.`)
      } else {
        tlog.info("loop.mode.direct", { loopName: s.activeLoop })
        const loopSid = sid
        try {
          await runLoopTui(loop, text, config, {
            onMessage: (msg) => addSystem(msg),
            waitForInput: (prompt) => new Promise((resolve) => {
              addSystem(prompt)
              loopInputResolver = resolve
            }),
            onStepStart: (stepId, label, type, stepIndex, stepTotal) => {
              props.onStatus(`⟳ ${label} (${type})`)
              store.appendItem(loopSid, { kind: "loop-step", loopName: loop.name, stepId, stepLabel: label, stepType: type, stepIndex, stepTotal })
            },
            onToken: (tok) => {
              const items = store.store.items[loopSid] ?? []
              const last = items[items.length - 1]
              if (last?.kind === "assistant" && last.streaming) {
                store.updateLastItem(loopSid, (i) => { if (i.kind === "assistant") i.content += tok })
              } else {
                store.appendItem(loopSid, { kind: "assistant", content: tok, streaming: true })
              }
            },
            onToolStatus: (name) => props.onStatus(`⏳ ${name}`),
            ...makeLoopThinkingCallbacks(loopSid),
            ...makeLoopToolCallbacks(loopSid),
          }, ac.signal)
        } finally {
          store.updateLastItem(loopSid, (i) => { if (i.kind === "assistant") i.streaming = false })
          loopInputResolver = null
          props.onStatus("")
          // Persist display items so the loop transcript survives a reload.
          s.turns.push({ role: "user", content: text })
          s.updatedAt = new Date().toISOString()
          s.displayItems = (store.store.items[loopSid] ?? []).map((item) => {
            if (item.kind === "assistant" || item.kind === "thinking") return { ...item, streaming: false }
            if (item.kind === "tool") return { ...item, running: false }
            return item
          })
          void SessionStore.save(s)
          store.upsertSession({ ...s })
        }
      }
      return
    }

    try {
      // ── Memory gathering ─────────────────────────────────────────────────
      const loaded = loadMemories()
      const alwaysMemories = loaded.always
      let semanticHits: MemoryFile[] = []
      if (loaded.semantic.length > 0) {
        props.onStatus("✻ recalling…")
        try {
          const hits = await semanticSearch(text, loaded.semantic, 5)
          semanticHits = hits.map((h) => h.file)
          tlog.debug("memory.semantic", {
            candidates: loaded.semantic.length,
            hits: semanticHits.length,
            top: hits.slice(0, 5).map((h) => ({ name: h.file.frontmatter.name, score: h.score })),
          })
        } catch (err) {
          tlog.warn("memory.semantic.failed", { err })
        }
      }

      tlog.info("memory.injected", {
        alwaysCount: alwaysMemories.length,
        semanticCount: semanticHits.length,
        always: alwaysMemories.map((m) => ({ name: m.frontmatter.name, tier: m.tier })),
        semantic: semanticHits.map((m) => ({ name: m.frontmatter.name, tier: m.tier })),
      })

      if (alwaysMemories.length > 0 || semanticHits.length > 0) {
        const parts: string[] = []
        if (alwaysMemories.length > 0)
          parts.push(alwaysMemories.map((m) => m.frontmatter.name).join(", "))
        if (semanticHits.length > 0)
          parts.push(`semantic: ${semanticHits.map((m) => m.frontmatter.name).join(", ")}`)
        addSystem(`✓ memories: ${parts.join(" · ")}`)
      }

      appendAuditEvent(sid, "prompt_sent", {
        userMessage: text,
        memoriesInjected: [
          ...alwaysMemories.map((m) => ({ source: "always", name: m.frontmatter.name, tier: m.tier })),
          ...semanticHits.map((m) => ({ source: "semantic", name: m.frontmatter.name, tier: m.tier })),
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
        shouldResume ? [] : alwaysMemories,
        semanticHits,
        props.history,
        !shouldResume,
      )
      tlog.debug("prompt.enriched", {
        enrichedLen: enriched.length,
        userLen: text.length,
        alwaysCount: shouldResume ? 0 : alwaysMemories.length,
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
      const seen = new Set<string>()
      s.memoriesActive = [...alwaysMemories, ...semanticHits]
        .map((m) => ({ name: m.frontmatter.name, tier: m.tier, inject: m.frontmatter.inject }))
        .filter((m) => (seen.has(m.name) ? false : (seen.add(m.name), true)))
      // Persist the full display item log so tool calls, thinking, loop-step
      // headers, and system messages are restored when the session is reloaded.
      // Strip runtime-only flags before writing — nothing should be streaming
      // or running at this point, but guard defensively.
      s.displayItems = (store.store.items[sid] ?? []).map((item) => {
        if (item.kind === "assistant" || item.kind === "thinking") return { ...item, streaming: false }
        if (item.kind === "tool") return { ...item, running: false }
        return item
      })
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

      // ── Background compliance review ─────────────────────────────────────
      if (!ac.signal.aborted) {
        void runComplianceReviewDraft({
          session: s,
          ac,
          injectedMemories: [...alwaysMemories, ...semanticHits],
          response: fullResponse,
          toolEvidence: completedToolCalls,
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
    if (!props.streaming && key.meta && key.name === "v") {
      key.preventDefault()
      void pasteClipboardImage()
      return
    }
    if (reviewDraft() && key.meta && key.name === "s") {
      key.preventDefault()
      sendReviewDraft()
      return
    }
    if (reviewDraft() && key.meta && key.name === "e") {
      key.preventDefault()
      editReviewDraft()
      return
    }
    if (reviewDraft() && key.meta && key.name === "d") {
      key.preventDefault()
      setReviewDraft(null)
      return
    }

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
      if (props.session.activeLoop) {
        const prev = props.session.activeLoop
        props.session.activeLoop = undefined
        SessionStore.save(props.session).catch(() => {})
        store.upsertSession({ ...props.session })
        addSystem(`Loop mode off (was: ${prev}). Default system loop restored.`)
      }
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
    <box flexDirection="column" height={COMPOSER_BORDER_HEIGHT + inputLines() + suggestions().length + modelPickerRows() + loopPickerRows() + reviewDraftRows()}>
      <Show when={loopPickerOpen()}>
        <box flexDirection="column" height={loopPickerRows()} paddingLeft={2}>
          <text fg={theme.textMuted}>Select loop (↑↓ · ↵ pick · esc cancel):</text>
          <For each={loopPickerItems()}>
            {(l, i) => (
              <text fg={i() === loopPickerIdx() ? theme.primary : theme.textMuted}>
                {`${i() === loopPickerIdx() ? "▶ " : "  "}${l.name}${l.description ? `  — ${l.description.slice(0, 50)}` : ""}`}
              </text>
            )}
          </For>
          <text fg={theme.textDim}> </text>
        </box>
      </Show>

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

      <Show when={reviewDraft()}>
        {(draft) => (
          <box flexDirection="column" height={REVIEW_DRAFT_ROWS} borderStyle="single" borderColor={theme.warning} paddingLeft={1} paddingRight={1}>
            <text fg={theme.warning}>{`Review found suggestions (${draft().memoryCount} memor${draft().memoryCount === 1 ? "y" : "ies"})`}</text>
            <text fg={theme.textMuted}>{reviewSummary(draft())}</text>
            <text fg={theme.textDim}>No message was sent to the agent.</text>
            <box flexDirection="row">
              <text fg={theme.primary} onMouseDown={sendReviewDraft}>[ Alt+S Send ]</text>
              <text fg={theme.textDim}> </text>
              <text fg={theme.primary} onMouseDown={editReviewDraft}>[ Alt+E Edit ]</text>
              <text fg={theme.textDim}> </text>
              <text fg={theme.textMuted} onMouseDown={() => setReviewDraft(null)}>[ Alt+D Dismiss ]</text>
            </box>
          </box>
        )}
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
          focused={!modelPickerOpen() && !loopPickerOpen()}
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
            // On Mac without "Use Option as Meta key", Option+<key> produces a
            // Unicode character instead of a meta key event. Intercept the known
            // Option-key outputs here and fire the corresponding action so these
            // bindings work on Mac without any terminal settings change.
            // Option+V → √ (paste image), Option+S → ß (send review draft),
            // Option+D → ∂ (dismiss review draft).
            // Option+E is a dead key (acute accent) — no interceptable character,
            // so alt+e (edit review draft) requires "Use Option as Meta key" on Mac.
            if (!props.streaming && value.includes("√")) {
              textareaRef!.setText(value.replace(/√/g, ""))
              void pasteClipboardImage()
              return
            }
            if (reviewDraft() && value.includes("ß")) {
              textareaRef!.setText(value.replace(/ß/g, ""))
              sendReviewDraft()
              return
            }
            if (reviewDraft() && value.includes("∂")) {
              textareaRef!.setText(value.replace(/∂/g, ""))
              setReviewDraft(null)
              return
            }
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
