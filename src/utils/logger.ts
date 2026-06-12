import { existsSync, mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync, promises as fsp } from "fs"
import { join } from "path"
import os from "os"

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

function envLevel(): LogLevel {
  const raw = (process.env.RITE_LOG_LEVEL ?? "").toLowerCase()
  if (raw in LEVELS) return raw as LogLevel
  return "info"
}

let activeLevel: LogLevel = envLevel()
export function setLogLevel(level: LogLevel) {
  activeLevel = level
}
export function getLogLevel(): LogLevel {
  return activeLevel
}

function logsDir(): string {
  const dir = join(os.homedir(), ".rite", "logs")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sessionsDir(): string {
  const dir = join(logsDir(), "sessions")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function dailyFile(): string {
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  return join(logsDir(), `rite-${stamp}.jsonl`)
}

function sessionFile(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.jsonl`)
}

const RETAIN_DAYS = 14
let pruned = false
function pruneOldLogsOnce() {
  if (pruned) return
  pruned = true
  try {
    const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000
    for (const name of readdirSync(logsDir())) {
      if (!name.startsWith("rite-") || !name.endsWith(".jsonl")) continue
      const p = join(logsDir(), name)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

interface LogFields {
  scope?: string
  sessionId?: string
  turnId?: string
  [k: string]: unknown
}

interface LogEntry extends LogFields {
  ts: string
  level: LogLevel
  msg: string
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet()
  return JSON.stringify(value, (_k, v) => {
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack }
    }
    if (typeof v === "object" && v !== null) {
      if (seen.has(v as object)) return "[circular]"
      seen.add(v as object)
    }
    if (typeof v === "bigint") return v.toString()
    return v
  })
}

// ── Async writer: per-file queue + microtask drain ─────────────────────────
//
// The event loop never blocks on disk: writes are queued in memory and a
// single setImmediate-driven drainer batches all pending lines for each file
// into one `fs.promises.appendFile` syscall. This eliminates the multi-second
// stalls we saw on the submit hot path when debug-level logging dumped large
// enriched prompts via `appendFileSync`.
//
// Trade-off: lines written immediately before a hard crash may not reach
// disk. `flushSync()` (called by the crash handlers) drains pending queues
// synchronously to bound that loss to the in-flight write.

const queues = new Map<string, string[]>()
let drainScheduled = false
let drainPromise: Promise<void> = Promise.resolve()

function scheduleDrain(): void {
  if (drainScheduled) return
  drainScheduled = true
  drainPromise = drainPromise.then(
    () =>
      new Promise<void>((resolve) => {
        setImmediate(async () => {
          drainScheduled = false
          await drainOnce()
          resolve()
        })
      }),
  )
}

async function drainOnce(): Promise<void> {
  // Snapshot + clear queues so new writes during this drain go to the next batch.
  const snapshot: Array<[string, string]> = []
  for (const [path, lines] of queues) {
    if (lines.length === 0) continue
    snapshot.push([path, lines.join("")])
    queues.set(path, [])
  }
  await Promise.all(
    snapshot.map(([path, payload]) =>
      fsp.appendFile(path, payload, "utf-8").catch(() => {
        /* ignore — never let the logger throw */
      }),
    ),
  )
}

function enqueue(path: string, line: string): void {
  let q = queues.get(path)
  if (!q) {
    q = []
    queues.set(path, q)
  }
  q.push(line)
  scheduleDrain()
}

/** Drain pending log writes synchronously. Used by crash handlers. */
export function flushSync(): void {
  for (const [path, lines] of queues) {
    if (lines.length === 0) continue
    try {
      appendFileSync(path, lines.join(""), "utf-8")
    } catch {
      /* ignore */
    }
    queues.set(path, [])
  }
}

/** Wait for all in-flight async drains to complete. Test/shutdown helper. */
export function flushAsync(): Promise<void> {
  scheduleDrain()
  return drainPromise
}

function writeEntry(entry: LogEntry) {
  pruneOldLogsOnce()
  const line = safeStringify(entry) + "\n"
  enqueue(dailyFile(), line)
  if (entry.sessionId) {
    enqueue(sessionFile(entry.sessionId), line)
  }
}

export interface Logger {
  trace(msg: string, fields?: LogFields): void
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(scope: string, defaults?: LogFields): Logger
}

function makeLogger(defaults: LogFields): Logger {
  const at = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (LEVELS[level] < LEVELS[activeLevel]) return
    writeEntry({
      ts: new Date().toISOString(),
      level,
      msg,
      ...defaults,
      ...(fields ?? {}),
    })
  }
  return {
    trace: (m, f) => at("trace", m, f),
    debug: (m, f) => at("debug", m, f),
    info: (m, f) => at("info", m, f),
    warn: (m, f) => at("warn", m, f),
    error: (m, f) => at("error", m, f),
    child(scope, extra) {
      return makeLogger({
        ...defaults,
        ...(extra ?? {}),
        scope: defaults.scope ? `${defaults.scope}.${scope}` : scope,
      })
    },
  }
}

export const log: Logger = makeLogger({})

export function logPath(): string {
  return dailyFile()
}

export function sessionLogPath(sessionId: string): string {
  return sessionFile(sessionId)
}

export function installCrashHandlers() {
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", { reason })
    flushSync()
  })
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { err })
    flushSync()
  })
  process.on("beforeExit", () => {
    flushSync()
  })
  process.on("exit", () => {
    flushSync()
  })
  // SIGINT/SIGTERM still drain whatever is queued, then let normal shutdown run.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      flushSync()
    })
  }
}
