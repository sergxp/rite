import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, copyFileSync } from "fs"
import { join } from "path"
import os from "os"
import type { Session } from "./types.js"
import { pathToSlug } from "../memory/paths.js"
import { log } from "../utils/logger.js"

const HOME = os.homedir()

/**
 * Sessions live under ~/.rite/sessions/<projectSlug>/<sid>.json.
 *
 * They used to live under <cwd>/.rite/sessions/, but that turned out to be
 * unsafe: anything that wipes ignored files in the repo (`git clean -fdx`,
 * antivirus quarantine, manual cleanup) silently destroyed them. Home-dir
 * storage matches v1 behavior and survives any project-level operation.
 */
function sessionsDir(cwd: string): string {
  return join(HOME, ".rite", "sessions", pathToSlug(cwd))
}

function legacySessionsDir(cwd: string): string {
  return join(cwd, ".rite", "sessions")
}

/**
 * One-time per-project migration: copy any legacy <cwd>/.rite/sessions/*.json
 * into ~/.rite/sessions/<projectSlug>/. We *copy* (not move) so users can
 * verify the migration before deleting the originals — and so a failed copy
 * never destroys data.
 */
let migrated = new Set<string>()
function migrateLegacy(cwd: string): void {
  if (migrated.has(cwd)) return
  migrated.add(cwd)
  const legacy = legacySessionsDir(cwd)
  if (!existsSync(legacy)) return
  const files = readdirSync(legacy).filter((f) => f.endsWith(".json"))
  if (files.length === 0) return
  const target = sessionsDir(cwd)
  mkdirSync(target, { recursive: true })
  let copied = 0
  for (const f of files) {
    const dst = join(target, f)
    if (existsSync(dst)) continue
    try {
      copyFileSync(join(legacy, f), dst)
      copied++
    } catch {
      // best-effort
    }
  }
  if (copied > 0) {
    log.child("sessions.store").info("legacy.migrated", { cwd, legacy, target, copied, total: files.length })
  }
}

export function makeSessionId(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  // Entropy suffix: two sessions created within the same second must not
  // share an id, or the later save silently overwrites the earlier file.
  const suffix = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${suffix}`
}

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6"

export const SessionStore = {
  create(opts: { cwd: string; backend?: Session["backend"]; type?: Session["type"] }): Session {
    const now = new Date().toISOString()
    const backend = opts.backend ?? "claude"
    return {
      id: makeSessionId(),
      name: null,
      createdAt: now,
      updatedAt: now,
      workingDir: opts.cwd,
      backend,
      type: opts.type ?? "repl",
      turns: [],
      memoriesActive: [],
      model: backend === "claude" ? DEFAULT_CLAUDE_MODEL : undefined,
    }
  },

  async save(session: Session): Promise<void> {
    migrateLegacy(session.workingDir)
    const dir = sessionsDir(session.workingDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), "utf-8")
  },

  async load(id: string, cwd: string): Promise<Session | null> {
    migrateLegacy(cwd)
    const path = join(sessionsDir(cwd), `${id}.json`)
    if (!existsSync(path)) {
      // Fall back to legacy path if the migration somehow didn't bring it over
      // (e.g. permission error). Better to read stale than to lose data.
      const legacy = join(legacySessionsDir(cwd), `${id}.json`)
      if (!existsSync(legacy)) return null
      try {
        return JSON.parse(readFileSync(legacy, "utf-8")) as Session
      } catch {
        return null
      }
    }
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Session
    } catch {
      return null
    }
  },

  async list(cwd: string): Promise<Session[]> {
    migrateLegacy(cwd)
    const dir = sessionsDir(cwd)
    const sessions: Session[] = []
    const seen = new Set<string>()
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
        try {
          const s = JSON.parse(readFileSync(join(dir, file), "utf-8")) as Session
          sessions.push(s)
          seen.add(s.id)
        } catch {
          // skip malformed
        }
      }
    }
    // Surface any legacy entries that weren't migrated (read-only fallback).
    const legacy = legacySessionsDir(cwd)
    if (existsSync(legacy)) {
      for (const file of readdirSync(legacy).filter((f) => f.endsWith(".json"))) {
        try {
          const s = JSON.parse(readFileSync(join(legacy, file), "utf-8")) as Session
          if (!seen.has(s.id)) sessions.push(s)
        } catch {
          // skip malformed
        }
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  },

  async delete(id: string, cwd: string): Promise<void> {
    const path = join(sessionsDir(cwd), `${id}.json`)
    if (existsSync(path)) unlinkSync(path)
    // Also remove the legacy copy if present, so it doesn't reappear next list.
    const legacy = join(legacySessionsDir(cwd), `${id}.json`)
    if (existsSync(legacy)) {
      try { unlinkSync(legacy) } catch { /* best effort */ }
    }
  },

  async rename(id: string, name: string, cwd: string): Promise<Session | null> {
    const session = await SessionStore.load(id, cwd)
    if (!session) return null
    const updated = { ...session, name, updatedAt: new Date().toISOString() }
    await SessionStore.save(updated)
    return updated
  },

  async fork(id: string, cwd: string): Promise<Session | null> {
    const session = await SessionStore.load(id, cwd)
    if (!session) return null
    const now = new Date().toISOString()

    // Create or inherit a groupId to link forks together
    const groupId = session.groupId || session.id
    if (!session.groupId) {
      session.groupId = groupId
      await SessionStore.save(session)
    }

    const forkId = `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    const forked: Session = {
      ...session,
      id: forkId,
      name: session.name ? `${session.name} (Fork)` : "Fork",
      createdAt: now,
      updatedAt: now,
      claudeSessionId: undefined, // Must start fresh Claude session to inherit history
      groupId,
      // Deep copy turns to prevent mutation issues
      turns: session.turns.map(t => ({ ...t })),
      memoriesActive: session.memoriesActive.map(m => ({ ...m })),
      stepOutputs: session.stepOutputs ? { ...session.stepOutputs } : undefined,
    }

    await SessionStore.save(forked)
    return forked
  },

  find(idOrName: string, sessions: Session[]): Session | null {
    return (
      sessions.find((s) => s.id === idOrName) ??
      sessions.find((s) => s.id.startsWith(idOrName)) ??
      sessions.find((s) => s.name?.toLowerCase() === idOrName.toLowerCase()) ??
      null
    )
  },
}
