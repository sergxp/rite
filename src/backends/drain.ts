import type { BackendEvent } from "./types.js"

export interface PendingTool {
  name: string
  inputJson: string
  startedAt: number
}

export interface DrainCallbacks {
  onSessionId?(id: string): void
  /** Text or tool activity ends the current thinking block. */
  onThinkingEnd?(text: string): void
  onThinkingDelta?(accumulated: string): void
  onTextDelta?(accumulated: string): void
  onToolStart?(tool: PendingTool): void
  onToolResult?(tool: PendingTool, result: string, isError: boolean): void
}

export interface DrainResult {
  text: string
  /** Compact evidence strings for each completed tool call, for reviewers. */
  completedToolCalls: string[]
}

/**
 * Drains a backend event stream into accumulated text, invoking callbacks as
 * structured events arrive. Pure async logic — no UI dependencies — so the
 * TUI, loops runner, and tests share one implementation.
 */
export async function drainAgentStream(
  stream: AsyncIterable<BackendEvent>,
  cb: DrainCallbacks = {},
): Promise<DrainResult> {
  let accumulated = ""
  let thinking = ""
  const pendingTools = new Map<string, PendingTool>()
  const completedToolCalls: string[] = []

  const endThinkingBlock = () => {
    if (thinking.trim()) cb.onThinkingEnd?.(thinking)
    thinking = ""
  }

  for await (const event of stream) {
    switch (event.type) {
      case "session_id":
        cb.onSessionId?.(event.sessionId)
        break
      case "text":
        endThinkingBlock()
        accumulated += event.content
        cb.onTextDelta?.(accumulated)
        break
      case "thinking":
        thinking += event.content
        cb.onThinkingDelta?.(thinking)
        break
      case "tool_call": {
        endThinkingBlock()
        const tool: PendingTool = { name: event.name, inputJson: "", startedAt: Date.now() }
        pendingTools.set(event.id, tool)
        cb.onToolStart?.(tool)
        break
      }
      case "tool_done": {
        const p = pendingTools.get(event.id)
        if (p) p.inputJson = event.inputJson ?? ""
        break
      }
      case "tool_result": {
        const p = pendingTools.get(event.id)
        if (p) {
          pendingTools.delete(event.id)
          const snippet = (event.result ?? "").slice(0, 300)
          completedToolCalls.push(`[${p.name}(${p.inputJson.slice(0, 200)}) → ${snippet}]`)
          cb.onToolResult?.(p, event.result ?? "", event.isError)
        }
        break
      }
    }
  }
  endThinkingBlock()

  return { text: accumulated, completedToolCalls }
}
