import Anthropic from "@anthropic-ai/sdk"
import type { Turn } from "../sessions/types.js"
import type { Backend, StreamOptions } from "./types.js"

export class ClaudeBackend implements Backend {
  name = "claude"
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }

  async *stream(turns: Turn[], opts: StreamOptions = {}): AsyncIterable<string> {
    const messages = turns.map((t) => ({
      role: t.role as "user" | "assistant",
      content: t.content,
    }))

    const stream = await this.client.messages.stream({
      model: "claude-opus-4-5",
      max_tokens: opts.maxTokens ?? 8192,
      messages,
    })

    for await (const event of stream) {
      if (opts.signal?.aborted) return

      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text
      }
    }
  }
}
