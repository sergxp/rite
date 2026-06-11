import { execa } from "execa"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import os from "os"
import type { BackendCallOpts, BackendEvent } from "./types.js"

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
}

function notFoundError(): Error {
  return new Error(
    "claude binary not found in PATH. Install Claude Code first: https://claude.ai/code",
  )
}

function noHooksSettingsPath(): string {
  const dir = join(os.homedir(), ".rite")
  const path = join(dir, "utility-settings.json")
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, JSON.stringify({ hooks: {} }), "utf-8")
  }
  return path
}

/**
 * One-shot, non-agentic claude CLI call. Used for utility work (naming,
 * extraction, summarization) — no session persistence, no hooks, no API key.
 */
export async function callClaudeCliBlocking(
  prompt: string,
  options?: { systemPrompt?: string; model?: string; noHooks?: boolean; signal?: AbortSignal },
): Promise<string> {
  const args = ["--print", "--output-format", "text", "--dangerously-skip-permissions", "--no-session-persistence"]
  if (options?.model) {
    args.push("--model", options.model)
  }
  if (options?.noHooks) {
    args.push("--settings", noHooksSettingsPath())
  }
  if (options?.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt)
  }

  try {
    const result = await execa("claude", args, {
      reject: false,
      stdin: "pipe",
      input: prompt,
      cancelSignal: options?.signal,
    })
    return result.stdout?.trim() ?? ""
  } catch (err) {
    if (isEnoent(err)) throw notFoundError()
    // Cancelled — return empty string silently.
    return ""
  }
}

/**
 * Agentic Claude turn via the Claude Code CLI, streaming structured events.
 * The CLI owns the conversation: pass `resumeSessionId` to continue an
 * existing CLI session, and watch for the `session_id` event to capture the
 * id of a new one.
 */
export async function* callClaude(
  prompt: string,
  signal?: AbortSignal,
  opts?: BackendCallOpts,
): AsyncIterable<BackendEvent> {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions"]
  if (opts?.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId)
  }

  const subprocess = execa("claude", args, {
    reject: false,
    stdin: "pipe",
    input: prompt,
    cancelSignal: signal,
  })

  if (!subprocess.stdout) {
    try {
      const result = await subprocess
      if (result.stdout) yield { type: "text", content: result.stdout }
    } catch (err) {
      if (isEnoent(err)) throw notFoundError()
      throw err
    }
    return
  }

  // Track tool_use blocks (to emit tool_done on stop) and thinking blocks (to route deltas).
  const toolBlocks = new Map<number, { name: string; id: string; inputJson: string }>()
  const thinkingBlocks = new Set<number>()

  // Track message turns so we can inject a separator between multi-turn responses.
  let assistantMessageCount = 0
  let hasEmittedText = false

  let buffer = ""
  try {
    for await (const chunk of subprocess.stdout) {
      buffer += chunk.toString()

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          // Non-JSON line from CLI (e.g. debug output) — discard, don't surface as text.
          continue
        }

        // Capture session ID from the init event so callers can resume the session.
        if (event.type === "system" && (event.subtype as string) === "init") {
          const sid = event.session_id
          if (typeof sid === "string" && sid) {
            yield { type: "session_id", sessionId: sid }
          }
          continue
        }

        // Tool results arrive as top-level "user" events (the CLI's synthetic tool_result turn).
        if (event.type === "user") {
          const message = event.message as Record<string, unknown> | undefined
          const content = message?.content as Array<Record<string, unknown>> | undefined
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const id = typeof block.tool_use_id === "string" ? block.tool_use_id : ""
                const isError = block.is_error === true
                // content may be a string or an array of content blocks
                let result = ""
                if (typeof block.content === "string") {
                  result = block.content
                } else if (Array.isArray(block.content)) {
                  result = (block.content as Array<Record<string, unknown>>)
                    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
                    .join("")
                }
                yield { type: "tool_result", id, result, isError }
              }
            }
          }
          continue
        }

        if (event.type !== "stream_event") continue

        const inner = event.event as Record<string, unknown> | undefined
        if (!inner) continue

        // Count assistant message turns so we can detect multi-turn agentic responses.
        if (inner.type === "message_start") {
          assistantMessageCount++
          continue
        }

        if (inner.type === "content_block_start") {
          const index = inner.index as number
          const block = inner.content_block as Record<string, unknown> | undefined
          if (block?.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "unknown"
            const id = typeof block.id === "string" ? block.id : `tool-${index}`
            toolBlocks.set(index, { name, id, inputJson: "" })
            yield { type: "tool_call", name, id }
          } else if (block?.type === "thinking") {
            thinkingBlocks.add(index)
          } else if (block?.type === "text" && assistantMessageCount > 1 && hasEmittedText) {
            // New text block in a subsequent agent step — separate it from the
            // previous one with a blank line (tool/thinking items already mark
            // step boundaries in the UI; a horizontal rule reads as noise).
            yield { type: "text", content: "\n\n" }
          }
          continue
        }

        if (inner.type === "content_block_stop") {
          const index = inner.index as number
          const info = toolBlocks.get(index)
          if (info) {
            yield { type: "tool_done", name: info.name, id: info.id, inputJson: info.inputJson }
            toolBlocks.delete(index)
          } else {
            thinkingBlocks.delete(index)
          }
          continue
        }

        if (inner.type === "content_block_delta") {
          const index = inner.index as number
          const delta = inner.delta as Record<string, unknown> | undefined
          if (thinkingBlocks.has(index)) {
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              yield { type: "thinking", content: delta.thinking }
            }
            continue
          }
          // Accumulate tool input JSON as it streams in.
          const toolBlock = toolBlocks.get(index)
          if (toolBlock) {
            if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              toolBlock.inputJson += delta.partial_json
            }
            continue
          }
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            hasEmittedText = true
            yield { type: "text", content: delta.text }
          }
          continue
        }
      }
    }
  } catch (err) {
    if (isEnoent(err)) throw notFoundError()
    throw err
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as Record<string, unknown>
      if (event.type === "stream_event") {
        const inner = event.event as Record<string, unknown> | undefined
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", content: delta.text }
          }
        }
      }
    } catch {
      yield { type: "text", content: buffer }
    }
  }

  await subprocess
}
