import Anthropic from "@anthropic-ai/sdk";
import { execa } from "execa";
import type { BackendEvent } from "./events.js";

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

let cachedClient: Anthropic | null = null;
let cachedApiKey = "";

function resolveApiKey(apiKey?: string): string {
  return apiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || "";
}

function getAnthropicClient(apiKey?: string): Anthropic | null {
  const resolvedApiKey = resolveApiKey(apiKey);
  if (!resolvedApiKey) return null;

  if (!cachedClient || cachedApiKey !== resolvedApiKey) {
    cachedClient = new Anthropic({ apiKey: resolvedApiKey });
    cachedApiKey = resolvedApiKey;
  }

  return cachedClient;
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .join("");
}

export async function callClaudeBlocking(
  prompt: string,
  options?: {
    model?: string;
    systemPrompt?: string;
    apiKey?: string;
    maxTokens?: number;
  }
): Promise<string> {
  const client = getAnthropicClient(options?.apiKey);
  if (!client) return "";

  try {
    const message = await client.messages.create({
      model: options?.model ?? "claude-3-5-haiku-latest",
      max_tokens: options?.maxTokens ?? 1024,
      system: options?.systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    return extractText(message).trim();
  } catch {
    return "";
  }
}

export async function* callClaude(
  prompt: string,
  signal?: AbortSignal
): AsyncIterable<BackendEvent> {
  const subprocess = execa(
    "claude",
    ["-p", "--output-format", "stream-json", "--include-partial-messages"],
    { reject: false, stdin: "pipe", input: prompt, cancelSignal: signal }
  );

  if (!subprocess.stdout) {
    try {
      const result = await subprocess;
      if (result.stdout) yield { type: "text", content: result.stdout };
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error(
          "claude binary not found in PATH. Install Claude Code first: https://claude.ai/code"
        );
      }
      throw err;
    }
    return;
  }

  // Track which content block index is a tool_use block so we can emit tool_done on stop.
  const blockTypes = new Map<number, { name: string; id: string }>();

  let buffer = "";
  try {
    for await (const chunk of subprocess.stdout) {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;

          if (event.type !== "stream_event") continue;

          const inner = event.event as Record<string, unknown> | undefined;
          if (!inner) continue;

          if (inner.type === "content_block_start") {
            const index = inner.index as number;
            const block = inner.content_block as Record<string, unknown> | undefined;
            if (block?.type === "tool_use") {
              const name = typeof block.name === "string" ? block.name : "unknown";
              const id = typeof block.id === "string" ? block.id : `tool-${index}`;
              blockTypes.set(index, { name, id });
              yield { type: "tool_call", name, id };
            }
            continue;
          }

          if (inner.type === "content_block_stop") {
            const index = inner.index as number;
            const info = blockTypes.get(index);
            if (info) {
              yield { type: "tool_done", name: info.name, id: info.id };
              blockTypes.delete(index);
            }
            continue;
          }

          if (inner.type === "content_block_delta") {
            const delta = inner.delta as Record<string, unknown> | undefined;
            // Only surface text deltas; skip input_json_delta (tool args)
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              yield { type: "text", content: delta.text };
            }
            continue;
          }
        } catch {
          // not JSON — yield as raw text
          yield { type: "text", content: line + "\n" };
        }
      }
    }
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "claude binary not found in PATH. Install Claude Code first: https://claude.ai/code"
      );
    }
    throw err;
  }

  if (buffer.trim()) {
    try {
      const event = JSON.parse(buffer) as Record<string, unknown>;
      if (event.type === "stream_event") {
        const inner = event.event as Record<string, unknown> | undefined;
        if (inner?.type === "content_block_delta") {
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", content: delta.text };
          }
        }
      }
    } catch {
      yield { type: "text", content: buffer };
    }
  }

  await subprocess;
}
