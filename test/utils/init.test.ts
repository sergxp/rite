import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import os from "os"
import { ensureDefaultLoops } from "../../src/utils/init"

let tmpHome: string
const originalHome = os.homedir

describe("ensureDefaultLoops", () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "rite-init-"))
    ;(os as unknown as { homedir: () => string }).homedir = () => tmpHome
  })

  afterEach(() => {
    ;(os as unknown as { homedir: () => string }).homedir = originalHome
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it("seeds the first-principles researcher loop as Opus low effort", () => {
    ensureDefaultLoops()

    const filePath = join(tmpHome, ".rite", "loops", "first-principles-researcher.json")
    expect(existsSync(filePath)).toBe(true)

    const loop = JSON.parse(readFileSync(filePath, "utf-8")) as {
      name: string
      steps: Array<{ type: string; model?: string; effort?: string; prompt?: string }>
    }
    expect(loop.name).toBe("first-principles-researcher")
    expect(loop.steps).toHaveLength(1)
    expect(loop.steps[0]).toMatchObject({
      type: "llm",
      model: "claude-opus-4-8",
      effort: "low",
    })
    expect(loop.steps[0].prompt).toContain("Senior Computer Science Researcher")
    expect(loop.steps[0].prompt).toContain("{{context}}")
  })
})
