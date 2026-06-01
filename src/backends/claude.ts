import Anthropic from "@anthropic-ai/sdk";
import { execa } from "execa";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import os from "os";
import type { BackendEvent, ImageAttachment } from "./events.js";

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

let cachedClient: Anthropic | null = null;
let cachedApiKey = "";
// rite-owned API key — only used for SDK calls (vision/image). Never written to process.env
// so it doesn't leak to claude CLI subprocesses or any other child process.
let riteApiKey = "";

export function setRiteApiKey(key: string): void {
  riteApiKey = key.trim();
  // Invalidate cached client so it's rebuilt with the new key on next use.
  cachedClient = null;
  cachedApiKey = "";
}

function resolveApiKey(apiKey?: string): string {
  return apiKey?.trim() || riteApiKey || "";
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

function noHooksSettingsPath(): string {
  const dir = join(os.homedir(), ".rite");
  const path = join(dir, "utility-settings.json");
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ hooks: {} }), "utf-8");
  }
  return path;
}

export async function callClaudeCliBlocking(
  prompt: string,
  options?: { systemPrompt?: string; model?: string; noHooks?: boolean }
): Promise<string> {
  const args = ["--print", "--output-format", "text"];
  if (options?.model) {
    args.push("--model", options.model);
  }
  if (options?.noHooks) {
    args.push("--settings", noHooksSettingsPath());
  }
  if (options?.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  try {
    const result = await execa("claude", args, {
      reject: false,
      stdin: "pipe",
      input: prompt,
    });
    return result.stdout?.trim() ?? "";
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "claude binary not found in PATH. Install Claude Code first: https://claude.ai/code"
      );
    }
    throw err;
  }
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

/** Stream a Claude response using the Anthropic SDK directly (supports vision). */
async function* callClaudeSdk(
  prompt: string,
  images: ImageAttachment[],
  signal?: AbortSignal
): AsyncIterable<BackendEvent> {
  const client = getAnthropicClient();
  if (!client) {
    yield { type: "text", content: "No ANTHROPIC_API_KEY set — cannot use vision." };
    return;
  }

  const imageBlocks: Anthropic.ImageBlockParam[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.mediaType, data: img.base64 },
  }));

  const stream = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 8096,
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
    stream: true,
  }, { signal });

  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        yield { type: "text", content: event.delta.text };
      }
    }
  }
}

export async function* callClaude(
  prompt: string,
  signal?: AbortSignal,
  images?: ImageAttachment[]
): AsyncIterable<BackendEvent> {
  if (images && images.length > 0) {
    yield* callClaudeSdk(prompt, images, signal);
    return;
  }

  const subprocess = execa(
    "claude",
    ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"],
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

  // Track tool_use blocks (to emit tool_done on stop) and thinking blocks (to route deltas).
  const toolBlocks = new Map<number, { name: string; id: string; inputJson: string }>();
  const thinkingBlocks = new Set<number>();

  // Track message turns so we can inject a separator between multi-turn responses.
  let assistantMessageCount = 0;
  let hasEmittedText = false;

  let buffer = "";
  try {
    for await (const chunk of subprocess.stdout) {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Non-JSON line from CLI (e.g. debug output) — discard, don't surface as text.
          continue;
        }

        // Tool results arrive as top-level "user" events (the CLI's synthetic tool_result turn).
        if (event.type === "user") {
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "tool_result") {
                const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
                const isError = block.is_error === true;
                // content may be a string or an array of content blocks
                let result = "";
                if (typeof block.content === "string") {
                  result = block.content;
                } else if (Array.isArray(block.content)) {
                  result = (block.content as Array<Record<string, unknown>>)
                    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
                    .join("");
                }
                yield { type: "tool_result", id, result, isError };
              }
            }
          }
          continue;
        }

        if (event.type !== "stream_event") continue;

        const inner = event.event as Record<string, unknown> | undefined;
        if (!inner) continue;

        // Count assistant message turns so we can detect multi-turn agentic responses.
        if (inner.type === "message_start") {
          assistantMessageCount++;
          continue;
        }

        if (inner.type === "content_block_start") {
          const index = inner.index as number;
          const block = inner.content_block as Record<string, unknown> | undefined;
          if (block?.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "unknown";
            const id = typeof block.id === "string" ? block.id : `tool-${index}`;
            toolBlocks.set(index, { name, id, inputJson: "" });
            yield { type: "tool_call", name, id };
          } else if (block?.type === "thinking") {
            thinkingBlocks.add(index);
          } else if (block?.type === "text" && assistantMessageCount > 1 && hasEmittedText) {
            // New text block in a subsequent assistant turn — inject a horizontal rule
            // so each agent step is visually separated rather than running together.
            yield { type: "text", content: "\n\n---\n\n" };
          }
          continue;
        }

        if (inner.type === "content_block_stop") {
          const index = inner.index as number;
          const info = toolBlocks.get(index);
          if (info) {
            yield { type: "tool_done", name: info.name, id: info.id, inputJson: info.inputJson };
            toolBlocks.delete(index);
          } else {
            thinkingBlocks.delete(index);
          }
          continue;
        }

        if (inner.type === "content_block_delta") {
          const index = inner.index as number;
          const delta = inner.delta as Record<string, unknown> | undefined;
          if (thinkingBlocks.has(index)) {
            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              yield { type: "thinking", content: delta.thinking };
            }
            continue;
          }
          // Accumulate tool input JSON as it streams in.
          const toolBlock = toolBlocks.get(index);
          if (toolBlock) {
            if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              toolBlock.inputJson += delta.partial_json;
            }
            continue;
          }
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            hasEmittedText = true;
            yield { type: "text", content: delta.text };
          }
          continue;
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
