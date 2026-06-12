import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock the utility backend so we can drive the reviewer's raw output directly.
vi.mock("../../src/backends/utility.js", () => ({
  callUtilityBlocking: vi.fn(),
}))

import { callUtilityBlocking } from "../../src/backends/utility.js"
import { checkMemoryCompliance } from "../../src/loops/default-review.js"
import type { MemoryFile } from "../../src/memory/types.js"

const mockUtil = callUtilityBlocking as unknown as ReturnType<typeof vi.fn>
const memories = [{ content: "Always cite the source file." } as MemoryFile]
const config = {} as never
const NO_TURNS: ReadonlyArray<{ role: "user" | "assistant"; content: string }> = []

describe("checkMemoryCompliance", () => {
  beforeEach(() => mockUtil.mockReset())

  it("fails open when the reviewer returns nothing", async () => {
    mockUtil.mockResolvedValue("")
    const r = await checkMemoryCompliance("response", memories, config, undefined, NO_TURNS)
    expect(r.passed).toBe(true)
    expect(r.feedback).toBe("")
  })

  it("parses a JSON pass verdict", async () => {
    mockUtil.mockResolvedValue('{"passed": true, "feedback": ""}')
    expect((await checkMemoryCompliance("r", memories, config, undefined, NO_TURNS)).passed).toBe(true)
  })

  it("parses a JSON fail verdict with feedback", async () => {
    mockUtil.mockResolvedValue('{"passed": false, "feedback": "You did not cite the source."}')
    const r = await checkMemoryCompliance("r", memories, config, undefined, NO_TURNS)
    expect(r.passed).toBe(false)
    expect(r.feedback).toContain("cite")
  })

  it("tolerates prose around the JSON verdict", async () => {
    mockUtil.mockResolvedValue('Sure! {"passed": false, "feedback": "missing citation"} hope that helps')
    const r = await checkMemoryCompliance("r", memories, config, undefined, NO_TURNS)
    expect(r.passed).toBe(false)
    expect(r.feedback).toContain("missing citation")
  })

  it("fails open on unparseable prose that is not an explicit failure", async () => {
    mockUtil.mockResolvedValue("Looks fine to me, no behavioral violations.")
    expect((await checkMemoryCompliance("r", memories, config, undefined, NO_TURNS)).passed).toBe(true)
  })

  it("returns pass without calling the reviewer when aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await checkMemoryCompliance("r", memories, config, ac.signal, NO_TURNS)
    expect(r.passed).toBe(true)
    expect(mockUtil).not.toHaveBeenCalled()
  })
})
