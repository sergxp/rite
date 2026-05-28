import { execa } from "execa";
import type { BackendEvent } from "./events.js";

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function* callCopilot(
  prompt: string,
  signal?: AbortSignal
): AsyncIterable<BackendEvent> {
  let result: { stdout: string; stderr: string; exitCode: number | null };

  try {
    const proc = await execa(
      "gh",
      ["copilot", "suggest", "--target", "shell", prompt],
      { reject: false, cancelSignal: signal }
    );
    result = {
      stdout: proc.stdout,
      stderr: proc.stderr,
      exitCode: proc.exitCode ?? null,
    };
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "gh binary not found in PATH. Install the GitHub CLI first: https://cli.github.com"
      );
    }
    throw err;
  }

  const output = result.stdout.trim();
  if (output) {
    yield { type: "text", content: output };
    return;
  }

  if (result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
}

export async function callCopilotBlocking(prompt: string): Promise<string> {
  try {
    const proc = await execa(
      "gh",
      ["copilot", "suggest", "--target", "shell", prompt],
      { reject: false }
    );
    return proc.stdout.trim() || proc.stderr.trim();
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(
        "gh binary not found in PATH. Install the GitHub CLI first: https://cli.github.com"
      );
    }
    return "";
  }
}
