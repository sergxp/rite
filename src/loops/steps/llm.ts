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
  options?: {
    onToken?: (text: string) => void;
    onToolStatus?: (name: string) => void;
    signal?: AbortSignal;
  }
): Promise<LlmStepResult> {
  const backend = context.config.backend ?? "claude";
  const backendFn = getBackend(backend);

  const resolvedPrompt = resolveTemplate(step.prompt, context);

  let output = "";
  const stream = backendFn(resolvedPrompt, options?.signal);

  // Output is surfaced only through callbacks — never written to stdout directly.
  // The TUI owns the terminal (Ink alt-screen); a raw write would corrupt/flicker
  // the display. The CLI path supplies callbacks that write to stdout.
  for await (const event of stream) {
    if (event.type === "text") {
      options?.onToken?.(event.content);
      output += event.content;
    } else if (event.type === "tool_call") {
      options?.onToolStatus?.(event.name);
    }
  }

  return { output, resolvedPrompt };
}
