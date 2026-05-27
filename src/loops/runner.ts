import * as readline from "readline";
import { loadMemories, type LoadedMemories } from "../memory/reader.js";
import { extractMemories } from "../extraction/extractor.js";
import type { RiteConfig } from "../config/types.js";
import type { Loop, Step } from "./types.js";
import { runLlmStep } from "./steps/llm.js";
import { runShellStep } from "./steps/shell.js";
import { runHumanInputStep } from "./steps/human_input.js";
import { runConditionStep } from "./steps/condition.js";

export interface StepContext {
  context: string;
  stepOutputs: Record<string, string>;
  memories: LoadedMemories;
  config: RiteConfig;
}

function waitForEnter(message: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

function findStepById(steps: Step[], id: string): Step | undefined {
  return steps.find((s) => s.id === id);
}

function stepIndexById(steps: Step[], id: string): number {
  return steps.findIndex((s) => s.id === id);
}

export async function runLoop(
  loop: Loop,
  context: string,
  config: RiteConfig
): Promise<void> {
  const memories = loadMemories();
  const stepContext: StepContext = {
    context,
    stepOutputs: {},
    memories,
    config,
  };

  const steps = loop.steps;
  if (steps.length === 0) {
    console.log("Loop has no steps.");
    return;
  }

  let currentIndex = 0;
  let forceNextId: string | undefined;

  while (currentIndex < steps.length) {
    const step = forceNextId
      ? findStepById(steps, forceNextId)
      : steps[currentIndex];
    forceNextId = undefined;

    if (!step) break;

    const label = step.name ?? step.id;
    console.log(`\n── Step: ${label} ──────────────────`);

    if (step.human_checkpoint) {
      await waitForEnter(
        `Press Enter to run step "${label}", or Ctrl+C to abort: `
      );
    }

    let output = "";
    let nextStepId: string | undefined;

    switch (step.type) {
      case "llm": {
        output = await runLlmStep(step, stepContext);
        break;
      }
      case "shell": {
        output = await runShellStep(step, stepContext);
        break;
      }
      case "human_input": {
        output = await runHumanInputStep(step, stepContext);
        break;
      }
      case "condition": {
        const result = await runConditionStep(step, stepContext);
        nextStepId = result === "true" ? step.if_true : step.if_false;
        output = result;
        break;
      }
    }

    stepContext.stepOutputs[step.id] = output;

    // Determine next step
    if (step.type === "condition" && nextStepId) {
      const nextIdx = stepIndexById(steps, nextStepId);
      if (nextIdx === -1) {
        // target id not found — stop
        break;
      }
      currentIndex = nextIdx;
    } else if (step.next) {
      const nextIdx = stepIndexById(steps, step.next);
      if (nextIdx === -1) break;
      currentIndex = nextIdx;
    } else {
      const currentIdx = stepIndexById(steps, step.id);
      currentIndex = currentIdx + 1;
    }
  }

  console.log("\n✓ Loop complete.");

  const allOutputs = Object.entries(stepContext.stepOutputs)
    .map(([id, out]) => `[${id}]: ${out}`)
    .join("\n\n");

  await extractMemories(
    `Loop: ${loop.name}\nContext: ${context}`,
    allOutputs,
    config
  );
}
