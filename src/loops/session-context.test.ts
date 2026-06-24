/**
 * Regression tests for session_context wiring.
 *
 * Covers three layers:
 *  1. template.ts — resolveTemplate renders session_context correctly
 *  2. history.ts  — buildLoopHistory truncates long turns at MAX_TURN_CHARS
 *  3. end-to-end  — prepareLoopHistory (the function both composer sites call) wires
 *                   turns through to resolveTemplate correctly
 *
 * Falsifiability:
 *  - Test 1 fails without the template.ts fix (session_context renders "" not placeholder)
 *  - Test 3 fails without history.ts (no truncation → "…" never appears)
 *  - Tests 4-5 guard prepareLoopHistory — the exact function composer invokes at both
 *    call sites. If prepareLoopHistory is removed or its warnEmpty logic is dropped,
 *    tests 4-5 fail.
 *
 * Verification limit: Rite is a terminal (opentui) app with no browser DOM. There is no
 * automated harness that can drive the TUI end-to-end. The one untested hop is composer
 * (SolidJS) → runLoopTui — a single positional arg pass that the TypeScript compiler
 * validates at build time. Everything from runLoopTui inward is covered by tests 3-5.
 */

import { vi, describe, test, expect, beforeEach } from "vitest"

// vi.hoisted ensures the mock fn is created before vi.mock hoisting resolves the factory.
const { mockRunLlmStep } = vi.hoisted(() => ({
  mockRunLlmStep: vi.fn(async () => ({ output: "done", resolvedPrompt: "" })),
}))
vi.mock("./steps/llm.js", () => ({ runLlmStep: mockRunLlmStep }))

// Mock IO side-effects so runLoopTui doesn't make real API calls or file writes.
vi.mock("../extraction/extractor.js", () => ({ extractMemories: vi.fn(async () => {}) }))
vi.mock("../audit/writer.js", () => ({ appendAuditEvent: vi.fn() }))
vi.mock("../memory/reader.js", () => ({ loadMemories: vi.fn(() => ({ always: [], semantic: [], all: [] })) }))
vi.mock("../sessions/store.js", () => ({
  makeSessionId: vi.fn(() => "test-session-id"),
  SessionStore: { create: vi.fn(() => ({ id: "", loopName: "", loopContext: "", stepOutputs: {}, memoriesActive: [], turns: [] })), save: vi.fn(async () => {}) },
}))

import { resolveTemplate } from "../utils/template.js"
import type { StepContext } from "./runner.js"
import { runLoopTui } from "./runner.js"
import { buildLoopHistory, prepareLoopHistory, LOOP_HISTORY_MAX_TURN_CHARS } from "./history.js"

const EMPTY_MEMORIES = { always: [], semantic: [], all: [] }
const EMPTY_CONFIG = {} as any

function makeCtx(
  conversationHistory?: StepContext["conversationHistory"]
): StepContext {
  return {
    context: "implement option b",
    stepOutputs: {},
    memories: EMPTY_MEMORIES,
    config: EMPTY_CONFIG,
    conversationHistory,
  }
}

const PROPOSE_TEMPLATE = `
Prior session:
{{{session_context}}}

Task: {{context}}
`.trim()

const OPTIONS_TURNS: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "What are my options for the auth refactor?" },
  {
    role: "assistant",
    content:
      "Here are three options:\n\nOption A: Keep session tokens, patch expiry handling.\nOption B: Switch to OAuth2 client credentials — the recommended path.\nOption C: Replace the integration entirely with a third-party auth provider.",
  },
  { role: "user", content: "implement option b" },
]

describe("session_context template rendering", () => {
  test("renders placeholder when no conversationHistory", () => {
    const rendered = resolveTemplate(PROPOSE_TEMPLATE, makeCtx(undefined))
    expect(rendered).toContain("(no prior conversation)")
    expect(rendered).not.toContain("Option A")
  })

  test("renders turns when conversationHistory is injected", () => {
    const rendered = resolveTemplate(PROPOSE_TEMPLATE, makeCtx(OPTIONS_TURNS))
    expect(rendered).not.toContain("(no prior conversation)")
    expect(rendered).toContain("Option B")
    expect(rendered).toContain("Assistant:")
  })
})

describe("buildLoopHistory", () => {
  test("truncates turns longer than MAX_TURN_CHARS and appends ellipsis", () => {
    const longContent = "x".repeat(LOOP_HISTORY_MAX_TURN_CHARS + 100) + " Option B is OAuth2"
    const history = buildLoopHistory([{ role: "assistant", content: longContent }])
    const truncated = history[0]?.content ?? ""
    expect(truncated.endsWith("…")).toBe(true)
    expect(truncated.length).toBe(LOOP_HISTORY_MAX_TURN_CHARS + 1) // content + ellipsis char
    expect(truncated).not.toContain("Option B is OAuth2")
  })

  test("does not truncate turns at or below MAX_TURN_CHARS", () => {
    const content = "x".repeat(LOOP_HISTORY_MAX_TURN_CHARS)
    const history = buildLoopHistory([{ role: "user", content }])
    expect(history[0]?.content).toBe(content)
    expect(history[0]?.content.endsWith("…")).toBe(false)
  })

  test("returns empty array for empty turns", () => {
    expect(buildLoopHistory([])).toEqual([])
  })
})

describe("runLoopTui threads conversationHistory into StepContext", () => {
  beforeEach(() => { mockRunLlmStep.mockClear() })

  test("conversationHistory reaches the llm step's context arg", async () => {
    const loop = {
      name: "t",
      steps: [{ id: "propose", type: "llm" as const, prompt: "" }],
    } as any
    const history = [{ role: "assistant" as const, content: "Option B: OAuth2" }]
    const callbacks = {
      onMessage: () => {},
      waitForInput: async () => "",
    } as any

    await runLoopTui(loop, "implement option b", {} as any, callbacks, history)

    expect(mockRunLlmStep).toHaveBeenCalled()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (mockRunLlmStep.mock.calls as any)[0][1] as StepContext
    expect(ctx.conversationHistory).toEqual(history)
  })

  test("returns all step outputs so the main session can retain loop context", async () => {
    mockRunLlmStep
      .mockResolvedValueOnce({ output: "proposal output", resolvedPrompt: "" })
      .mockResolvedValueOnce({ output: "review output", resolvedPrompt: "" })
    const loop = {
      name: "t",
      steps: [
        { id: "propose", type: "llm" as const, prompt: "" },
        { id: "review", type: "llm" as const, prompt: "" },
      ],
    } as any
    const callbacks = {
      onMessage: () => {},
      waitForInput: async () => "",
    } as any

    const output = await runLoopTui(loop, "implement option b", {} as any, callbacks, [])

    expect(output).toContain("[propose]: proposal output")
    expect(output).toContain("[review]: review output")
  })
})

describe("prepareLoopHistory — the function both composer call sites invoke", () => {
  test("Option B from session turns reaches the rendered prompt", () => {
    // prepareLoopHistory is what composer actually calls; testing it directly means this
    // test is tied to the real code path, not a re-implementation of the glue.
    const sessionTurns = [
      { role: "user", content: "What are my options?" },
      {
        role: "assistant",
        content: "Option A: Keep tokens.\nOption B: Switch to OAuth2.\nOption C: Replace.",
      },
      { role: "user", content: "implement option b" },
    ]
    const { history, warnEmpty } = prepareLoopHistory(sessionTurns)
    expect(warnEmpty).toBe(false)
    const rendered = resolveTemplate(PROPOSE_TEMPLATE, makeCtx(history))
    expect(rendered).toContain("Option B")
    expect(rendered).not.toContain("(no prior conversation)")
  })

  test("empty s.turns → warnEmpty=true and placeholder rendered", () => {
    const { history, warnEmpty } = prepareLoopHistory([])
    expect(warnEmpty).toBe(true)
    expect(history).toHaveLength(0)
    const rendered = resolveTemplate(PROPOSE_TEMPLATE, makeCtx(history))
    expect(rendered).toContain("(no prior conversation)")
  })
})
