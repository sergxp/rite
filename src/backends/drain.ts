import type { BackendEvent } from "./types.js"
import { log } from "../utils/logger.js"

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
  onToolStart?(tool: PendingTool, id: string): void
  /** Fires once the tool's input JSON has fully streamed. Use this for chat rendering — input is empty in onToolStart. */
  onToolReady?(tool: PendingTool, id: string): void
  onToolResult?(tool: PendingTool, result: string, isError: boolean, id: string): void
}

export interface DrainResult {
  text: string
  /** Compact evidence strings for each completed tool call, for reviewers. */
  completedToolCalls: string[]
}

export interface DrainOpts {
  /** Correlation fields attached to drain logs (turnId, sessionId). */
  logFields?: { sessionId?: string; turnId?: string }
}

/**
 * Drains a backend event stream into accumulated text, invoking callbacks as
 * structured events arrive. Pure async logic — no UI dependencies — so the
 * TUI, loops runner, and tests share one implementation.
 */
export async function drainAgentStream(
  stream: AsyncIterable<BackendEvent>,
  cb: DrainCallbacks = {},
  opts: DrainOpts = {},
): Promise<DrainResult> {
  const dlog = log.child("drain", opts.logFields ?? {})
  let accumulated = ""
  // Text accumulated since the last tool call. The UI starts a fresh assistant
  // bubble after each tool, so it expects only the text in that current
  // segment — not the full turn-to-date. Reset on tool_call.
  let currentSegment = ""
  let thinking = ""
  const pendingTools = new Map<string, PendingTool>()
  const completedToolCalls: string[] = []
  let textEvents = 0
  let toolEvents = 0

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
        currentSegment += event.content
        textEvents++
        cb.onTextDelta?.(currentSegment)
        break
      case "thinking":
        thinking += event.content
        cb.onThinkingDelta?.(thinking)
        break
      case "tool_call": {
        endThinkingBlock()
        currentSegment = ""
        const tool: PendingTool = { name: event.name, inputJson: "", startedAt: Date.now() }
        pendingTools.set(event.id, tool)
        toolEvents++
        dlog.debug("tool.start", { tool: event.name, toolId: event.id })
        cb.onToolStart?.(tool, event.id)
        break
      }
      case "tool_done": {
        const p = pendingTools.get(event.id)
        if (p) {
          p.inputJson = event.inputJson ?? ""
          cb.onToolReady?.(p, event.id)
        }
        break
      }
      case "tool_result": {
        const p = pendingTools.get(event.id)
        if (p) {
          pendingTools.delete(event.id)
          const snippet = (event.result ?? "").slice(0, 300)
          completedToolCalls.push(`[${p.name}(${p.inputJson.slice(0, 200)}) → ${snippet}]`)
          dlog.debug("tool.result", {
            tool: p.name,
            toolId: event.id,
            durationMs: Date.now() - p.startedAt,
            isError: event.isError,
            inputLen: p.inputJson.length,
            resultLen: (event.result ?? "").length,
          })
          cb.onToolResult?.(p, event.result ?? "", event.isError, event.id)
        }
        break
      }
    }
  }
  endThinkingBlock()

  dlog.info("drain.done", {
    textLen: accumulated.length,
    textEvents,
    toolEvents,
    completedTools: completedToolCalls.length,
  })

  return { text: accumulated, completedToolCalls }
}

