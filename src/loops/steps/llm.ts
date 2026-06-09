import { getBackend } from "../../backends/index.js";
import { resolveTemplate } from "../../utils/template.js";
import type { LlmStep } from "../types.js";
import type { StepContext } from "../runner.js";

export interface LlmStepResult {
  output: string;
  resolvedPrompt: string;
}

export async function runLlmStep(
  step: LlmStep,
  context: StepContext,
  options?: { onToken?: (text: string) => void; signal?: AbortSignal }
): Promise<LlmStepResult> {
  const backend = context.config.backend ?? "claude";
  const backendFn = getBackend(backend);

  const resolvedPrompt = resolveTemplate(step.prompt, context);

  let output = "";
  const stream = backendFn(resolvedPrompt, options?.signal);

  for await (const event of stream) {
    if (event.type === "text") {
      process.stdout.write(event.content);
      options?.onToken?.(event.content);
      output += event.content;
    }
    // tool_call / tool_done: print a brief status line to stdout
    if (event.type === "tool_call") {
      process.stdout.write(`\n[tool: ${event.name}]\n`);
    }
  }

  process.stdout.write("\n");
  return { output, resolvedPrompt };
}
