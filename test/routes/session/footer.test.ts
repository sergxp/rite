import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"

describe("session footer task indicators", () => {
  it("wires streaming state to terminal and visible task badges", () => {
    const source = readFileSync(new URL("../../../src/routes/session/footer.tsx", import.meta.url), "utf8")

    expect(source).toContain("SPINNER_FRAMES")
    expect(source).toContain("RITE_TITLE_ANIMATION_FRAMES")
    expect(source).toContain("writeWindowsTerminalProgress(\"indeterminate\")")
    expect(source).toContain("writeWindowsTerminalProgress(\"normal\", 100)")
    expect(source).toContain("writeTerminalBell()")
    expect(source).toContain("writeTerminalTabStatus(\"busy\")")
    expect(source).toContain("writeTerminalTabStatus(\"complete\")")
    expect(source).toContain("writeTerminalTabStatus(\"idle\")")
    expect(source).toContain("formatTerminalTitle")
    expect(source).toContain("running")
    expect(source).toContain("✓ done")
  })
})
