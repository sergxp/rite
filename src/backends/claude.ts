import { execa } from "execa";

export async function* callClaude(
  prompt: string
): AsyncIterable<string> {
  let claudePath: string;
  try {
    const which = await execa("which", ["claude"]);
    claudePath = which.stdout.trim();
  } catch {
    throw new Error(
      "claude binary not found in PATH. Install Claude Code first: https://claude.ai/code"
    );
  }

  const subprocess = execa(claudePath, ["--print", prompt], {
    reject: false,
    all: true,
  });

  if (!subprocess.stdout) {
    const result = await subprocess;
    if (result.stdout) {
      yield result.stdout;
    }
    return;
  }

  let buffer = "";
  for await (const chunk of subprocess.stdout) {
    const text = chunk.toString();
    buffer += text;

    // Try to detect stream-json lines; if not, yield raw text chunks
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      // Attempt to parse as stream-json event
      if (line.startsWith("{")) {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (
            event.type === "content_block_delta" &&
            event.delta &&
            typeof (event.delta as Record<string, unknown>).text === "string"
          ) {
            yield (event.delta as Record<string, unknown>).text as string;
            continue;
          }
          if (
            event.type === "text" &&
            typeof event.text === "string"
          ) {
            yield event.text;
            continue;
          }
          // Skip non-text JSON events silently
          continue;
        } catch {
          // Not JSON, fall through to yield as raw text
        }
      }

      yield line + "\n";
    }
  }

  // flush remaining buffer
  if (buffer.trim()) {
    yield buffer;
  }

  await subprocess;
}
