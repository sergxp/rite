import { execa } from "execa";

export async function* callCodex(
  prompt: string
): AsyncIterable<string> {
  let codexPath: string;
  try {
    const which = await execa("which", ["codex"]);
    codexPath = which.stdout.trim();
  } catch {
    throw new Error(
      "codex binary not found in PATH. Install OpenAI Codex CLI first."
    );
  }

  const subprocess = execa(codexPath, ["--quiet", prompt], {
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

  for await (const chunk of subprocess.stdout) {
    yield chunk.toString();
  }

  await subprocess;
}
