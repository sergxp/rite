import Anthropic from "@anthropic-ai/sdk";
import type { ConditionStep } from "../types.js";
import type { StepContext } from "../runner.js";

export async function runConditionStep(
  step: ConditionStep,
  context: StepContext
): Promise<"true" | "false"> {
  try {
    const apiKey =
      process.env.ANTHROPIC_API_KEY ?? context.config.anthropicApiKey ?? "";
    if (!apiKey) return "false";

    const stepIds = Object.keys(context.stepOutputs);
    const lastStepId = stepIds[stepIds.length - 1];
    const recentOutput =
      lastStepId !== undefined
        ? context.stepOutputs[lastStepId]
        : context.context;

    const promptText = [
      "Previous step context:",
      recentOutput,
      "",
      `Question: ${step.prompt}`,
      "",
      "Respond with only: true or false",
    ].join("\n");

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 10,
      messages: [{ role: "user", content: promptText }],
    });

    const text =
      response.content[0]?.type === "text"
        ? response.content[0].text.toLowerCase().trim()
        : "";

    return text.includes("true") ? "true" : "false";
  } catch {
    return "false";
  }
}
