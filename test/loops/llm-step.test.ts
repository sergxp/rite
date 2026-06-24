import { describe, it, expect, afterEach } from "vitest";
import { setBackendOverride } from "../../src/backends/index.js";
import { injectLoopSessionContext, runLlmStep } from "../../src/loops/steps/llm.js";
import { scriptedBackend } from "../util/backend.js";
import type { LlmStep } from "../../src/loops/types.js";
import type { StepContext } from "../../src/loops/runner.js";

// Minimal step + context to drive runLlmStep in isolation.
const step: LlmStep = { id: "s", type: "llm", prompt: "do the thing" };
const ctx: StepContext = {
  context: "",
  stepOutputs: {},
  memories: { all: [], always: [], semantic: [] } as unknown as StepContext["memories"],
  config: { backend: "claude" } as unknown as StepContext["config"],
};

afterEach(() => setBackendOverride(null));

describe("runLlmStep output routing", () => {
  it("streams text via onToken and never touches stdout", async () => {
    setBackendOverride(
      scriptedBackend([
        { type: "text", content: "Hello, " },
        { type: "text", content: "world" },
      ])
    );

    const tokens: string[] = [];
    const result = await runLlmStep(step, ctx, { onToken: (t) => tokens.push(t) });

    expect(tokens).toEqual(["Hello, ", "world"]);
    expect(result.output).toBe("Hello, world");
  });

  it("reports tool activity via onToolStatus (the loop ⏳ chain)", async () => {
    // This is the deterministic version of the link we previously could only
    // confirm by reading code: backend tool_call -> runLlmStep -> onToolStatus.
    setBackendOverride(
      scriptedBackend([
        { type: "text", content: "let me check" },
        { type: "tool_call", name: "Bash", id: "t1" },
        { type: "text", content: " done" },
      ])
    );

    const tokens: string[] = [];
    const tools: string[] = [];
    const result = await runLlmStep(step, ctx, {
      onToken: (t) => tokens.push(t),
      onToolStatus: (n) => tools.push(n),
    });

    expect(tools).toEqual(["Bash"]);
    expect(result.output).toBe("let me check done"); // tool_call contributes no text
  });
});

describe("loop llm session context injection", () => {
  it("injects prior Rite session context even when the loop prompt omits the placeholder", () => {
    const enriched = injectLoopSessionContext("Task: {{context}}", {
      ...ctx,
      context: "implement option b",
      conversationHistory: [
        { role: "user", content: "What are my options?" },
        { role: "assistant", content: "Option B is OAuth2." },
      ],
    });

    expect(enriched).toContain("Recent Rite session context:")
    expect(enriched).toContain("User: What are my options?")
    expect(enriched).toContain("Assistant: Option B is OAuth2.")
    expect(enriched).toContain("Loop step prompt:")
    expect(enriched).toContain("Task: implement option b")
  });

  it("does not duplicate context when the loop prompt already references session_context", () => {
    const enriched = injectLoopSessionContext("Prior:\n{{{session_context}}}\n\nTask: {{context}}", {
      ...ctx,
      context: "implement option b",
      conversationHistory: [{ role: "assistant", content: "Option B is OAuth2." }],
    });

    expect(enriched.match(/Recent Rite session context:/g)).toBeNull()
    expect(enriched.match(/Option B is OAuth2/g)).toHaveLength(1)
    expect(enriched).toContain("Task: implement option b")
  });
});
