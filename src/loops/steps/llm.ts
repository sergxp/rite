import { getBackend } from "../../backends/index.js";
import { resolveTemplate } from "../../utils/template.js";
import type { LlmStep } from "../types.js";
import type { StepContext } from "../runner.js";

export async function runLlmStep(
  step: LlmStep,
  context: StepContext
): Promise<string> {
  const backend = context.config.backend ?? "claude";
  const backendFn = getBackend(backend);

  const resolvedPrompt = resolveTemplate(step.prompt, context);

  let fullOutput = "";
  const stream = backendFn(resolvedPrompt);

  for await (const chunk of stream) {
    process.stdout.write(chunk);
    fullOutput += chunk;
  }

  process.stdout.write("\n");
  return fullOutput;
}
