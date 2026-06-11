import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { join } from "path"
import type { Session } from "./types.js"

function sessionsDir(cwd: string): string {
  return join(cwd, ".rite", "sessions")
}

function makeId(): string {
  const now = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

export const SessionStore = {
  create(opts: { cwd: string; backend?: Session["backend"]; type?: Session["type"] }): Session {
    const now = new Date().toISOString()
    return {
      id: makeId(),
      name: null,
      createdAt: now,
      updatedAt: now,
      workingDir: opts.cwd,
      backend: opts.backend ?? "claude",
      type: opts.type ?? "repl",
      turns: [],
      memoriesActive: [],
    }
  },

  async save(session: Session): Promise<void> {
    const dir = sessionsDir(session.workingDir)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), "utf-8")
  },

  async load(id: string, cwd: string): Promise<Session | null> {
    const path = join(sessionsDir(cwd), `${id}.json`)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as Session
    } catch {
      return null
    }
  },

  async list(cwd: string): Promise<Session[]> {
    const dir = sessionsDir(cwd)
    if (!existsSync(dir)) return []
    const sessions: Session[] = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        sessions.push(JSON.parse(readFileSync(join(dir, file), "utf-8")) as Session)
      } catch {
        // skip malformed
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  },

  async delete(id: string, cwd: string): Promise<void> {
    const path = join(sessionsDir(cwd), `${id}.json`)
    if (existsSync(path)) unlinkSync(path)
  },

  async rename(id: string, name: string, cwd: string): Promise<Session | null> {
    const session = await SessionStore.load(id, cwd)
    if (!session) return null
    const updated = { ...session, name, updatedAt: new Date().toISOString() }
    await SessionStore.save(updated)
    return updated
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
