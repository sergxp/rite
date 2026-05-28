import { callUtilityBlocking } from "../../backends/utility.js";
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
    const stepIds = Object.keys(context.stepOutputs);
    const lastStepId = stepIds[stepIds.length - 1];
    const recentOutput =
      lastStepId !== undefined
        ? context.stepOutputs[lastStepId]
        : context.context;

    const question = [
      "Previous step context:",
      recentOutput,
      "",
      `Question: ${step.prompt}`,
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
