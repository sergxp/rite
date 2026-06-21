import { callUtilityBlocking } from "../../backends/utility.js";
import { resolveTemplate } from "../../utils/template.js";
import type { ConditionStep } from "../types.js";
import type { StepContext } from "../runner.js";

export interface ConditionStepResult {
  output: "true" | "false";
  rawResponse: string;
  question: string;
}

export async function runConditionStep(
  step: ConditionStep,
  context: StepContext
): Promise<ConditionStepResult> {
  try {
    // Resolve {{steps.X.output}} and {{context}} references in the prompt so
    // the condition always evaluates the explicitly named step, not whatever
    // happened to run last (which breaks in loops where step order cycles).
    const resolvedPrompt = resolveTemplate(step.prompt, context);

    const question = [
      resolvedPrompt,
      "",
      "Respond with only: true or false",
    ].join("\n");

    const rawResponse = await callUtilityBlocking(question, context.config, {
      maxTokens: 10,
    });
    const normalized = rawResponse.toLowerCase().trim();
    const output = normalized.includes("true") ? "true" : "false";
    return { output, rawResponse: normalized, question };
  } catch {
    return { output: "false", rawResponse: "", question: step.prompt };
  }
}
