import * as readline from "readline";
import { loadMemories, type LoadedMemories } from "../memory/reader.js";
import { extractMemories } from "../extraction/extractor.js";
import { createSession, saveSession, makeSessionId } from "../sessions/store.js";
import { appendAuditEvent } from "../audit/writer.js";
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
  const sessionId = makeSessionId();
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
    const stepStartMs = Date.now();

    // Step-type-specific audit fields
    let auditExtra: Record<string, unknown> = {};

    switch (step.type) {
      case "llm": {
        const result = await runLlmStep(step, stepContext);
        output = result.output;
        auditExtra = { resolvedPrompt: result.resolvedPrompt };
        break;
      }
      case "shell": {
        const result = await runShellStep(step, stepContext);
        output = result.output;
        auditExtra = {
          command: result.resolvedCommand,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        break;
      }
      case "human_input": {
        output = await runHumanInputStep(step, stepContext);
        auditExtra = { humanPrompt: step.prompt };
        break;
      }
      case "condition": {
        const result = await runConditionStep(step, stepContext);
        nextStepId = result.output === "true" ? step.if_true : step.if_false;
        output = result.output;
        auditExtra = {
          conditionQuestion: result.question,
          conditionRawResponse: result.rawResponse,
          branchTaken: nextStepId,
        };
        break;
      }
    }

    const durationMs = Date.now() - stepStartMs;
    stepContext.stepOutputs[step.id] = output;

    appendAuditEvent(sessionId, "loop_step", {
      loopName: loop.name,
      stepId: step.id,
      stepName: step.name,
      stepType: step.type,
      output,
      durationMs,
      ...auditExtra,
    });

    // Determine next step
    if (step.type === "condition" && nextStepId) {
      const nextIdx = stepIndexById(steps, nextStepId);
      if (nextIdx === -1) {
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
    config,
    undefined,
    sessionId
  );

  // Save loop run as a session using the same sessionId generated at the top
  const session = createSession(config, "loop");
  session.id = sessionId;
  session.loopName = loop.name;
  session.loopContext = context;
  session.stepOutputs = { ...stepContext.stepOutputs };
  session.memoriesActive = memories.all.map((m) => ({
    name: m.frontmatter.name,
    tier: m.tier,
    inject: m.frontmatter.inject,
  }));
  for (const step of loop.steps) {
    const out = stepContext.stepOutputs[step.id];
    if (out === undefined) continue;
    const stepLabel = step.name ?? step.id;
    session.turns.push({ role: "user", content: `Step: ${stepLabel} (${step.type})` });
    session.turns.push({ role: "assistant", content: out });
  }
  saveSession(session);
}
