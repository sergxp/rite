import { describe, expect, it } from "vitest"
import { resolveClaudeEffort } from "../../src/backends/claude"

describe("resolveClaudeEffort", () => {
  it("defaults opus models to low effort", () => {
    expect(resolveClaudeEffort("claude-opus-4-8")).toBe("low")
  })

  it("does not set effort for non-opus models", () => {
    expect(resolveClaudeEffort("claude-sonnet-4-6")).toBeUndefined()
    expect(resolveClaudeEffort("claude-fable-5")).toBeUndefined()
  })

  it("preserves explicit effort overrides", () => {
    expect(resolveClaudeEffort("claude-opus-4-8", "high")).toBe("high")
    expect(resolveClaudeEffort("claude-sonnet-4-6", "low")).toBe("low")
  })
})
