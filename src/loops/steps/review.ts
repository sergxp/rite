import { callUtilityBlocking } from "../../backends/utility.js";
import { resolveTemplate } from "../../utils/template.js";
import type { ReviewStep } from "../types.js";
import type { StepContext } from "../runner.js";

export interface ReviewStepResult {
  passed: boolean;
  feedback: string;
}

export async function runReviewStep(
  step: ReviewStep,
  context: StepContext,
  implementationOutput: string
): Promise<ReviewStepResult> {
  const resolvedCriteria = resolveTemplate(step.criteria, context);

  const prompt = [
    "You are a strict quality reviewer. Evaluate whether the task output satisfies all requirements.",
    "",
    "Requirements:",
    resolvedCriteria,
    "",
    "Task output:",
    implementationOutput,
    "",
    'Respond with JSON only — no prose, no markdown fences. Exact format: {"passed": true, "feedback": ""} or {"passed": false, "feedback": "specific issues that must be fixed"}',
  ].join("\n");

  let raw: string;
  try {
    raw = await callUtilityBlocking(prompt, context.config, { maxTokens: 600 });
  } catch {
    return { passed: false, feedback: "Reviewer call failed — retrying implementation." };
  }

  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { passed?: unknown; feedback?: unknown };
      return {
        passed: parsed.passed === true,
        feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
      };
    } catch {
      // fall through to heuristic
    }
  }

  // Heuristic fallback when the model doesn't return valid JSON
  const lower = raw.toLowerCase();
  const passed = lower.includes('"passed":true') || lower.includes('"passed": true');
  return { passed, feedback: passed ? "" : raw.trim() };
}
