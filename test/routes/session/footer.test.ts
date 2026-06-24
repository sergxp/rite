import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"
import { packFooterLabels } from "../../../src/routes/session/footer"

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
    expect(source).toContain("packFooterLabels")
    expect(source).toContain("props.onHeightChange(rows().length)")
    expect(source).toContain("<box flexDirection=\"row\">")
    expect(source).toContain("fg: theme.assistantMsg")
    expect(source).toContain("<text fg={label.fg ?? theme.assistantMsg}>{label.text}</text>")
    expect(source).not.toContain("<span")
    expect(source).not.toContain("esc abort · q back")
  })

  it("wraps labels into multiple rows when width is constrained", () => {
    const rows = packFooterLabels([
      { text: "session:abcdef", fg: "gray" },
      { text: "rite@feat/v2-feature-port", fg: "gray" },
      { text: "13 memories", fg: "gray" },
      { text: "42 turns", fg: "gray" },
      { text: "claude-opus-4-8", fg: "gray" },
    ], 32)

    expect(rows.length).toBeGreaterThan(1)
    expect(rows.flat().map((label) => label.text)).toEqual([
      "session:abcdef",
      "rite@feat/v2-feature-port",
      "13 memories",
      "42 turns",
      "claude-opus-4-8",
    ])
  })
})
