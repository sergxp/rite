/**
 * Rite-side scheduled prompts (`/cron`).
 *
 * We can't use claude's native `/loop` here: rite spawns `claude -p` per turn
 * so there is no persistent idle claude process for its scheduler to fire
 * against. Instead we own the timer ourselves and inject the scheduled prompt
 * through the normal user-message path when it fires.
 *
 * Schedules persist to `~/.rite/sessions/<sid>/cron.json` and are re-armed on
 * session resume. Recurring tasks self-expire after 7 days (matching claude's
 * own semantics).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import os from "os"
import { log } from "../utils/logger.js"

const clog = log.child("cron")

export type CronTaskKind = "recurring" | "one-shot"

export interface CronTask {
  id: string
  sessionId: string
  kind: CronTaskKind
  prompt: string
  /** ms between fires; only set for recurring. */
  intervalMs?: number
  /** epoch ms; for one-shot or the NEXT fire of a recurring task. */
  nextFireAt: number
  createdAt: number
}

export const MIN_INTERVAL_MS = 60_000
export const RECURRING_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

const SUFFIX_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
}

/** Parse "30s" / "5m" / "2h" / "1d" → milliseconds. Returns null on bad input. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(raw.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * SUFFIX_MS[unit])
}

/**
 * Parse "15:30", "3pm", "9:30am" → epoch ms today (or tomorrow if already
 * past). Returns null on bad input.
 */
export function parseClockTime(raw: string, now: Date = new Date()): number | null {
  const s = raw.trim().toLowerCase()
  let h: number, mm: number
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(s)
  if (m) {
    h = parseInt(m[1], 10)
    mm = parseInt(m[2], 10)
    if (m[3] === "pm" && h < 12) h += 12
    if (m[3] === "am" && h === 12) h = 0
  } else {
    m = /^(\d{1,2})\s*(am|pm)$/.exec(s)
    if (!m) return null
    h = parseInt(m[1], 10)
    mm = 0
    if (m[2] === "pm" && h < 12) h += 12
    if (m[2] === "am" && h === 12) h = 0
  }
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
  const target = new Date(now)
  target.setHours(h, mm, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  return target.getTime()
}

function randomId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789"
  let s = ""
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return s
}

function cronFilePath(sessionId: string): string {
  return join(os.homedir(), ".rite", "sessions", sessionId, "cron.json")
}

function loadFromDisk(sessionId: string): CronTask[] {
  const path = cronFilePath(sessionId)
  if (!existsSync(path)) return []
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"))
    if (!Array.isArray(raw)) return []
    return raw.filter((t) => t && typeof t.id === "string" && typeof t.prompt === "string")
  } catch (err) {
    clog.warn("load.failed", { sessionId, err })
    return []
  }
}

function saveToDisk(sessionId: string, tasks: CronTask[]): void {
  const path = cronFilePath(sessionId)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(tasks, null, 2), "utf-8")
  } catch (err) {
    clog.warn("save.failed", { sessionId, err })
  }
}

type FireFn = (prompt: string, task: CronTask) => void | Promise<void>

interface SessionState {
  tasks: CronTask[]
  timers: Map<string, ReturnType<typeof setTimeout>>
  fire: FireFn
}

const sessions = new Map<string, SessionState>()

function armTimer(state: SessionState, task: CronTask): void {
  const existing = state.timers.get(task.id)
  if (existing) clearTimeout(existing)
  const delay = Math.max(0, task.nextFireAt - Date.now())
  const t = setTimeout(() => void runFire(state, task.id), delay)
  state.timers.set(task.id, t)
}

async function runFire(state: SessionState, taskId: string): Promise<void> {
  const task = state.tasks.find((t) => t.id === taskId)
  if (!task) return
  clog.info("fire", {
    sessionId: task.sessionId,
    taskId,
    kind: task.kind,
    promptLen: task.prompt.length,
  })
  try {
    await state.fire(task.prompt, task)
  } catch (err) {
    clog.warn("fire.failed", { sessionId: task.sessionId, taskId, err })
  }

  if (task.kind === "one-shot") {
    removeTask(task.sessionId, task.id)
    return
  }

  const expiresAt = task.createdAt + RECURRING_EXPIRY_MS
  if (Date.now() >= expiresAt) {
    clog.info("expired", { sessionId: task.sessionId, taskId })
    removeTask(task.sessionId, task.id)
    return
  }
  task.nextFireAt = Date.now() + (task.intervalMs ?? MIN_INTERVAL_MS)
  saveToDisk(task.sessionId, state.tasks)
  armTimer(state, task)
}

/**
 * Begin firing scheduled tasks for `sessionId`. Re-arms any tasks loaded from
 * disk. Safe to call multiple times — replaces the previous fire callback and
 * does not duplicate timers.
 */
export function attachSession(sessionId: string, fire: FireFn): void {
  let state = sessions.get(sessionId)
  if (!state) {
    state = { tasks: loadFromDisk(sessionId), timers: new Map(), fire }
    sessions.set(sessionId, state)
  } else {
    state.fire = fire
  }
  const now = Date.now()
  state.tasks = state.tasks.filter((t) => {
    if (t.kind === "recurring" && now - t.createdAt >= RECURRING_EXPIRY_MS) {
      clog.info("expired.onAttach", { sessionId, taskId: t.id })
      return false
    }
    return true
  })
  for (const t of state.tasks) {
    if (t.nextFireAt < now) t.nextFireAt = now + 1000
    armTimer(state, t)
  }
  saveToDisk(sessionId, state.tasks)
  clog.info("attach", { sessionId, taskCount: state.tasks.length })
}

/** Stop firing for a session. Tasks remain on disk for the next resume. */
export function detachSession(sessionId: string): void {
  const state = sessions.get(sessionId)
  if (!state) return
  for (const t of state.timers.values()) clearTimeout(t)
  state.timers.clear()
  sessions.delete(sessionId)
  clog.info("detach", { sessionId })
}

export function listTasks(sessionId: string): CronTask[] {
  return sessions.get(sessionId)?.tasks.slice() ?? loadFromDisk(sessionId)
}

export function createRecurring(sessionId: string, intervalMs: number, prompt: string): CronTask {
  if (intervalMs < MIN_INTERVAL_MS) intervalMs = MIN_INTERVAL_MS
  const task: CronTask = {
    id: randomId(),
    sessionId,
    kind: "recurring",
    prompt,
    intervalMs,
    // Fire (almost) immediately, then every interval. The 1s offset gives the
    // composer time to clear the current turn before the cron-fired prompt
    // queues — avoids racing the user's just-submitted Enter.
    nextFireAt: Date.now() + 1000,
    createdAt: Date.now(),
  }
  insertTask(task)
  return task
}

export function createOneShot(sessionId: string, fireAt: number, prompt: string): CronTask {
  const task: CronTask = {
    id: randomId(),
    sessionId,
    kind: "one-shot",
    prompt,
    nextFireAt: Math.max(Date.now() + 1000, fireAt),
    createdAt: Date.now(),
  }
  insertTask(task)
  return task
}

function insertTask(task: CronTask): void {
  let state = sessions.get(task.sessionId)
  if (!state) {
    const tasks = loadFromDisk(task.sessionId)
    tasks.push(task)
    saveToDisk(task.sessionId, tasks)
    clog.info("create.detached", { sessionId: task.sessionId, taskId: task.id })
    return
  }
  state.tasks.push(task)
  saveToDisk(task.sessionId, state.tasks)
  armTimer(state, task)
  clog.info("create", {
    sessionId: task.sessionId,
    taskId: task.id,
    kind: task.kind,
    intervalMs: task.intervalMs,
    nextFireAt: task.nextFireAt,
  })
}

export function cancelTask(sessionId: string, taskId: string): boolean {
  return removeTask(sessionId, taskId)
}

function removeTask(sessionId: string, taskId: string): boolean {
  const state = sessions.get(sessionId)
  if (!state) {
    const tasks = loadFromDisk(sessionId)
    const idx = tasks.findIndex((t) => t.id === taskId)
    if (idx < 0) return false
    tasks.splice(idx, 1)
    saveToDisk(sessionId, tasks)
    return true
  }
  const idx = state.tasks.findIndex((t) => t.id === taskId)
  if (idx < 0) return false
  const t = state.timers.get(taskId)
  if (t) {
    clearTimeout(t)
    state.timers.delete(taskId)
  }
  state.tasks.splice(idx, 1)
  saveToDisk(sessionId, state.tasks)
  clog.info("cancel", { sessionId, taskId })
  return true
}

export function cancelAll(sessionId: string): number {
  const state = sessions.get(sessionId)
  if (!state) {
    const tasks = loadFromDisk(sessionId)
    const n = tasks.length
    saveToDisk(sessionId, [])
    return n
  }
  const n = state.tasks.length
  for (const t of state.timers.values()) clearTimeout(t)
  state.timers.clear()
  state.tasks = []
  saveToDisk(sessionId, [])
  clog.info("cancelAll", { sessionId, count: n })
  return n
}

/** Human-readable schedule string for `/cron list`. */
export function describeSchedule(task: CronTask): string {
  if (task.kind === "one-shot") {
    const d = new Date(task.nextFireAt)
    return `once at ${d.toLocaleString()}`
  }
  const ms = task.intervalMs ?? 0
  if (ms % SUFFIX_MS.d === 0) return `every ${ms / SUFFIX_MS.d}d`
  if (ms % SUFFIX_MS.h === 0) return `every ${ms / SUFFIX_MS.h}h`
  if (ms % SUFFIX_MS.m === 0) return `every ${ms / SUFFIX_MS.m}m`
  return `every ${Math.round(ms / 1000)}s`
}
