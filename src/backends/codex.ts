import { execa } from "execa";
import type { BackendEvent } from "./events.js";

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function* callCodex(
  prompt: string,
  signal?: AbortSignal
): AsyncIterable<BackendEvent> {
  const subprocess = execa("codex", ["exec", "--skip-git-repo-check", "--json", "-"], {
    reject: false,
    stdin: "pipe",
    input: prompt,
    cancelSignal: signal,
  });

  if (!subprocess.stdout) {
    try {
      const result = await subprocess;
      if (result.stdout) {
        const text = extractCodexTextFromOutput(result.stdout);
        if (text) yield { type: "text", content: text };
      }
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error("codex binary not found in PATH. Install OpenAI Codex CLI first.");
      }
      throw err;
    }
    return;
  }

  let buffer = "";
  try {
    for await (const chunk of subprocess.stdout) {
      buffer += chunk.toString();

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseCodexEvent(line);
        if (event) yield event;
      }
    }
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error("codex binary not found in PATH. Install OpenAI Codex CLI first.");
    }
    throw err;
  }

  if (buffer.trim()) {
    const event = parseCodexEvent(buffer);
    if (event) yield event;
  }

  await subprocess;
}

function parseCodexEvent(line: string): BackendEvent | null {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    const item = event.item as Record<string, unknown> | undefined;

    // item.created: tool call starting
    if (event.type === "item.created" && item) {
      if (item.type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "tool";
        const id = (typeof item.call_id === "string" ? item.call_id : null)
          ?? (typeof item.id === "string" ? item.id : "?");
        return { type: "tool_call", name, id };
      }
    }

    // item.completed: tool call done or text response
    if (event.type === "item.completed" && item) {
      if (item.type === "function_call") {
        const name = typeof item.name === "string" ? item.name : "tool";
        const id = (typeof item.call_id === "string" ? item.call_id : null)
          ?? (typeof item.id === "string" ? item.id : "?");
        return { type: "tool_done", name, id };
      }
      if (item.type === "agent_message" && typeof item.text === "string" && item.text) {
        return { type: "text", content: item.text };
      }
    }

    return null;
  } catch {
    return null;
  }
}

function extractCodexTextFromOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const event = parseCodexEvent(line);
      return event?.type === "text" ? event.content : null;
    })
    .filter((v): v is string => Boolean(v))
    .join("\n")
    .trim();
}

export async function callCodexBlocking(prompt: string): Promise<string> {
  try {
    const result = await execa("codex", ["exec", "--skip-git-repo-check", "--json", "-"], {
      reject: false,
      stdin: "pipe",
      input: prompt,
    });
    return extractCodexTextFromOutput(result.stdout) || result.stderr.trim();
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error("codex binary not found in PATH. Install OpenAI Codex CLI first.");
    }
    return "";
  }
}

