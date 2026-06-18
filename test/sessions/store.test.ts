import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionStore } from "../../src/sessions/store"
import { join } from "path"
import { rmSync, mkdirSync, existsSync } from "fs"
import os from "os"
import { pathToSlug } from "../../src/memory/paths"

describe("SessionStore Forking", () => {
  const TEST_CWD = join(os.tmpdir(), "rite-test-cwd-fork")
  const SESSIONS_DIR = join(os.homedir(), ".rite", "sessions", pathToSlug(TEST_CWD))

  beforeEach(() => {
    if (existsSync(SESSIONS_DIR)) {
      rmSync(SESSIONS_DIR, { recursive: true, force: true })
    }
    mkdirSync(SESSIONS_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(SESSIONS_DIR)) {
      rmSync(SESSIONS_DIR, { recursive: true, force: true })
    }
  })

  it("should fork a session correctly", async () => {
    const parent = SessionStore.create({ cwd: TEST_CWD, backend: "claude" })
    parent.turns = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" }
    ]
    parent.claudeSessionId = "cli-session-123"
    await SessionStore.save(parent)

    const forked = await SessionStore.fork(parent.id, TEST_CWD)
    expect(forked).toBeDefined()
    expect(forked?.id).not.toBe(parent.id)
    expect(forked?.groupId).toBe(parent.id)
    expect(forked?.claudeSessionId).toBeUndefined()
    expect(forked?.turns).toEqual(parent.turns)
    expect(forked?.turns).not.toBe(parent.turns) // Deep copy

    const reloadedParent = await SessionStore.load(parent.id, TEST_CWD)
    expect(reloadedParent?.groupId).toBe(parent.id)
  })

  it("should chain forks sharing the same groupId", async () => {
    const parent = SessionStore.create({ cwd: TEST_CWD, backend: "claude" })
    await SessionStore.save(parent)

    const child1 = await SessionStore.fork(parent.id, TEST_CWD)
    const child2 = await SessionStore.fork(child1!.id, TEST_CWD)

    expect(child1?.groupId).toBe(parent.id)
    expect(child2?.groupId).toBe(parent.id)
    
    const reloadedChild1 = await SessionStore.load(child1!.id, TEST_CWD)
    expect(reloadedChild1?.groupId).toBe(parent.id)
  })
})
