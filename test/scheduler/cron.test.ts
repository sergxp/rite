import { afterEach, beforeEach, describe, expect, it } from "vitest"
import os from "os"
import path from "path"
import { mkdtempSync, rmSync } from "fs"
import {
  attachSession,
  cancelAll,
  cancelTask,
  createOneShot,
  createRecurring,
  describeSchedule,
  detachSession,
  listTasks,
  parseClockTime,
  parseDuration,
  MIN_INTERVAL_MS,
} from "../../src/scheduler/cron.js"

let tmpHome: string
const originalHome = os.homedir

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "rite-cron-"))
  ;(os as unknown as { homedir: () => string }).homedir = () => tmpHome
})

afterEach(() => {
  ;(os as unknown as { homedir: () => string }).homedir = originalHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("parseDuration", () => {
  it("parses standard suffixes", () => {
    expect(parseDuration("30s")).toBe(30_000)
    expect(parseDuration("5m")).toBe(300_000)
    expect(parseDuration("2h")).toBe(7_200_000)
    expect(parseDuration("1d")).toBe(86_400_000)
  })
  it("rejects junk", () => {
    expect(parseDuration("")).toBeNull()
    expect(parseDuration("5x")).toBeNull()
    expect(parseDuration("abc")).toBeNull()
    expect(parseDuration("-5m")).toBeNull()
  })
})

describe("parseClockTime", () => {
  it("rolls forward to tomorrow when past", () => {
    const now = new Date("2025-01-01T15:00:00")
    const t = parseClockTime("09:00", now)!
    const d = new Date(t)
    expect(d.getDate()).toBe(2)
    expect(d.getHours()).toBe(9)
  })
  it("parses pm shorthand", () => {
    const now = new Date("2025-01-01T08:00:00")
    const t = parseClockTime("3pm", now)!
    expect(new Date(t).getHours()).toBe(15)
  })
})

describe("scheduler lifecycle", () => {
  it("fires a one-shot, then removes it", async () => {
    const sid = "s-one"
    let received: string | null = null
    attachSession(sid, (prompt) => {
      received = prompt
    })
    createOneShot(sid, Date.now() + 50, "ping")
    expect(listTasks(sid)).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 1500))
    expect(received).toBe("ping")
    expect(listTasks(sid)).toHaveLength(0)
    detachSession(sid)
  })

  it("clamps interval to MIN_INTERVAL_MS and cancels cleanly", () => {
    const sid = "s-rec"
    attachSession(sid, () => {})
    const t = createRecurring(sid, 50, "tick")
    expect(t.intervalMs).toBe(MIN_INTERVAL_MS)
    expect(listTasks(sid)[0].kind).toBe("recurring")
    cancelTask(sid, t.id)
    expect(listTasks(sid)).toHaveLength(0)
    detachSession(sid)
  })

  it("persists tasks across detach + attach", () => {
    const sid = "s-persist"
    attachSession(sid, () => {})
    createRecurring(sid, 5 * 60_000, "poll deploy")
    detachSession(sid)
    attachSession(sid, () => {})
    expect(listTasks(sid)).toHaveLength(1)
    expect(listTasks(sid)[0].prompt).toBe("poll deploy")
    cancelAll(sid)
    detachSession(sid)
  })

  it("describes schedules in human form", () => {
    expect(
      describeSchedule({
        id: "x",
        sessionId: "s",
        kind: "recurring",
        prompt: "p",
        intervalMs: 5 * 60_000,
        nextFireAt: 0,
        createdAt: 0,
      }),
    ).toBe("every 5m")
    expect(
      describeSchedule({
        id: "x",
        sessionId: "s",
        kind: "recurring",
        prompt: "p",
        intervalMs: 2 * 60 * 60_000,
        nextFireAt: 0,
        createdAt: 0,
      }),
    ).toBe("every 2h")
  })
})
