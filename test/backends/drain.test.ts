import { describe, it, expect } from "vitest"
import { drainAgentStream } from "../../src/backends/drain.js"
import type { BackendEvent } from "../../src/backends/types.js"

async function* stream(events: BackendEvent[]): AsyncIterable<BackendEvent> {
  for (const e of events) yield e
}

describe("drainAgentStream", () => {
  it("accumulates text and reports the session id", async () => {
    let sid = ""
    const result = await drainAgentStream(
      stream([
        { type: "session_id", sessionId: "abc" },
        { type: "text", content: "Hello " },
        { type: "text", content: "world" },
      ]),
      { onSessionId: (id) => (sid = id) },
    )
    expect(sid).toBe("abc")
    expect(result.text).toBe("Hello world")
  })

  it("flushes thinking blocks when text or tools arrive", async () => {
    const thinks: string[] = []
    const result = await drainAgentStream(
      stream([
        { type: "thinking", content: "hmm " },
        { type: "thinking", content: "okay" },
        { type: "text", content: "answer" },
        { type: "thinking", content: "post-text thought" },
      ]),
      { onThinkingEnd: (t) => thinks.push(t) },
    )
    // First block flushed by the text event, trailing block flushed at stream end.
    expect(thinks).toEqual(["hmm okay", "post-text thought"])
    expect(result.text).toBe("answer")
  })

  it("pairs tool_call/tool_done/tool_result and collects evidence", async () => {
    const tools: Array<{ name: string; result: string; isError: boolean }> = []
    const result = await drainAgentStream(
      stream([
        { type: "tool_call", name: "Bash", id: "t1" },
        { type: "tool_done", name: "Bash", id: "t1", inputJson: '{"command":"ls"}' },
        { type: "tool_result", id: "t1", result: "file.txt", isError: false },
        { type: "text", content: "done" },
      ]),
      { onToolResult: (tool, res, isErr) => tools.push({ name: tool.name, result: res, isError: isErr }) },
    )
    expect(tools).toEqual([{ name: "Bash", result: "file.txt", isError: false }])
    expect(result.completedToolCalls).toHaveLength(1)
    expect(result.completedToolCalls[0]).toContain("Bash")
    expect(result.completedToolCalls[0]).toContain("ls")
    expect(result.text).toBe("done")
  })

  it("ignores tool_result for unknown ids", async () => {
    const result = await drainAgentStream(
      stream([{ type: "tool_result", id: "ghost", result: "x", isError: false }]),
    )
    expect(result.completedToolCalls).toHaveLength(0)
  })
})
