import * as readline from "readline";
import { loadMemories, type LoadedMemories } from "../memory/reader.js";
import { extractMemories } from "../extraction/extractor.js";
import { SessionStore, makeSessionId } from "../sessions/store.js";
import { appendAuditEvent } from "../audit/writer.js";
import type { RiteConfig } from "../config/types.js";
import type { Loop, Step } from "./types.js";
import { runLlmStep } from "./steps/llm.js";
import { runShellStep } from "./steps/shell.js";
import { runConditionStep } from "./steps/condition.js";
import { runReviewStep } from "./steps/review.js";
import { log as riteLog } from "../utils/logger.js";

export interface StepContext {
  context: string;
  stepOutputs: Record<string, string>;
  memories: LoadedMemories;
  config: RiteConfig;
  conversationHistory?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

export interface LoopCallbacks {
  onMessage(text: string): void;
  waitForInput(prompt: string): Promise<string>;
  onStepStart?(stepId: string, stepLabel: string, stepType: string, stepIndex: number, stepTotal: number): void;
  onToken?(text: string): void;
  onThinkingDelta?(accumulated: string): void;
  onThinkingEnd?(text: string): void;
  onToolStatus?(name: string): void;
  onToolCall?(name: string, id: string): void;
  onToolDone?(name: string, id: string, inputJson: string): void;
  onToolResult?(id: string, result: string, isError: boolean): void;
}

function findStepById(steps: Step[], id: string): Step | undefined {
  return steps.find((s) => s.id === id);
}

function stepIndexById(steps: Step[], id: string): number {
  return steps.findIndex((s) => s.id === id);
}

async function runLoopCore(
  loop: Loop,
  context: string,
  config: RiteConfig,
  sessionId: string,
  log: (s: string) => void,
  askUser: (prompt: string) => Promise<string>,
  onStepStart?: (stepId: string, stepLabel: string, stepType: string, stepIndex: number, stepTotal: number) => void,
  onToken?: (text: string) => void,
  onThinkingDelta?: (accumulated: string) => void,
  onThinkingEnd?: (text: string) => void,
  onToolStatus?: (name: string) => void,
  onToolCall?: (name: string, id: string) => void,
  onToolDone?: (name: string, id: string, inputJson: string) => void,
  onToolResult?: (id: string, result: string, isError: boolean) => void,
  conversationHistory?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  signal?: AbortSignal
): Promise<string | undefined> {
  const llog = riteLog.child("loops", { sessionId, loopName: loop.name });
  llog.info("loop.start", { contextLen: context.length, stepCount: loop.steps.length });
  const memories = loadMemories();
  const stepContext: StepContext = {
    context,
    stepOutputs: {},
    memories,
    config,
    conversationHistory,
  };

  const steps = loop.steps;
  if (steps.length === 0) {
    log("Loop has no steps.");
    llog.warn("loop.empty");
    return;
  }

  let currentIndex = 0;
  let forceNextId: string | undefined;
  const reviewIterations: Record<string, number> = {};
  let lastOutput: string | undefined;

  while (currentIndex < steps.length) {
    if (signal?.aborted) {
      llog.info("loop.aborted", { atIndex: currentIndex });
      break;
    }

    const step = forceNextId
      ? findStepById(steps, forceNextId)
      : steps[currentIndex];
    forceNextId = undefined;

    if (!step) break;

    const label = step.name ?? step.id;
    const stepIdx = stepIndexById(steps, step.id);
    onStepStart?.(step.id, label, step.type, stepIdx, steps.length);
    llog.info("step.start", { stepId: step.id, label, type: step.type });

    if (step.human_checkpoint) {
      await askUser(`Press Enter to run step "${label}", or Ctrl+C to abort: `);
    }

    let output = "";
    let nextStepId: string | undefined;
    const stepStartMs = Date.now();
    let auditExtra: Record<string, unknown> = {};

    switch (step.type) {
      case "llm": {
        const result = await runLlmStep(step, stepContext, {
          onToken,
          onThinkingDelta,
          onThinkingEnd,
          onToolStatus,
          onToolCall,
          onToolDone,
          onToolResult,
          signal,
        });
        output = result.output;
        auditExtra = { resolvedPrompt: result.resolvedPrompt };
        break;
      }
      case "shell": {
        const result = await runShellStep(step, stepContext);
        output = result.output;
        // Surface command output through the injected logger (stdout in the CLI,
        // a chat bubble in the TUI) instead of writing to stdout from the step.
        if (result.output.trim()) log(result.output);
        auditExtra = {
          command: result.resolvedCommand,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
        break;
      }
      case "human_input": {
        output = await askUser(step.prompt);
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
      case "review": {
        const iteration = (reviewIterations[step.id] ?? 0) + 1;
        reviewIterations[step.id] = iteration;
        const maxIter = step.max_iterations ?? 3;

        const implOutput = stepContext.stepOutputs[step.implementation_step] ?? "";
        const result = await runReviewStep(step, stepContext, implOutput);
        output = result.feedback;

        if (result.passed) {
          log(`\n✓ Review passed.`);
          auditExtra = { passed: true, feedback: "", iteration };
        } else if (iteration >= maxIter) {
          log(`\n⚠ Review failed after ${maxIter} attempt(s). Max iterations reached.`);
          log(`  Final feedback: ${result.feedback}`);
          const userInstruction = await askUser(
            `What would you like to do? (type instructions, or leave blank to abort)`
          );
          if (userInstruction.trim()) {
            stepContext.stepOutputs[step.id] = `${result.feedback}\n\nUser instruction: ${userInstruction}`;
            output = stepContext.stepOutputs[step.id];
            reviewIterations[step.id] = 0;
            nextStepId = step.implementation_step;
          }
          auditExtra = { passed: false, feedback: result.feedback, iteration, exhausted: true, userInstruction };
        } else {
          log(`\n✗ Review failed (attempt ${iteration}/${maxIter}). Sending back to "${step.implementation_step}".`);
          log(`  Feedback: ${result.feedback}`);
          auditExtra = { passed: false, feedback: result.feedback, iteration };
          nextStepId = step.implementation_step;
        }
        break;
      }
    }

    const durationMs = Date.now() - stepStartMs;
    stepContext.stepOutputs[step.id] = output;
    if (output.trim() && step.type !== "condition" && step.type !== "review") {
      lastOutput = output;
    }
    llog.info("step.done", {
      stepId: step.id,
      type: step.type,
      durationMs,
      outputLen: output.length,
      nextStepId,
    });

    appendAuditEvent(sessionId, "loop_step", {
      loopName: loop.name,
      stepId: step.id,
      stepName: step.name,
      stepType: step.type,
      output,
      durationMs,
      ...auditExtra,
    });

    if ((step.type === "condition" || step.type === "review") && nextStepId) {
      const nextIdx = stepIndexById(steps, nextStepId);
      if (nextIdx === -1) break;
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

  log("\n✓ Loop complete.");
  llog.info("loop.done", { stepOutputs: Object.keys(stepContext.stepOutputs).length });

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

  const session = SessionStore.create({ cwd: process.cwd(), backend: config.backend, type: "loop" });
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
  await SessionStore.save(session);
  return allOutputs || lastOutput;
}

export async function runLoop(
  loop: Loop,
  context: string,
  config: RiteConfig
): Promise<void> {
  const sessionId = makeSessionId();

  const askUser = (prompt: string): Promise<string> =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(prompt, (answer) => { rl.close(); resolve(answer.trim()); });
    });

  // CLI owns stdout directly, so stream llm tokens and tool status to it.
  const onToken = (text: string) => process.stdout.write(text);
  const onToolStatus = (name: string) => process.stdout.write(`\n[tool: ${name}]\n`);
  await runLoopCore(
    loop, context, config, sessionId, console.log, askUser,
    undefined, onToken, undefined, undefined, onToolStatus, undefined, undefined, undefined,
    undefined
  );
}

export async function runLoopTui(
  loop: Loop,
  context: string,
  config: RiteConfig,
  callbacks: LoopCallbacks,
  conversationHistory?: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  signal?: AbortSignal
): Promise<string | undefined> {
  const sessionId = makeSessionId();
  return runLoopCore(
    loop, context, config, sessionId,
    callbacks.onMessage,
    callbacks.waitForInput,
    callbacks.onStepStart,
    callbacks.onToken,
    callbacks.onThinkingDelta,
    callbacks.onThinkingEnd,
    callbacks.onToolStatus,
    callbacks.onToolCall,
    callbacks.onToolDone,
    callbacks.onToolResult,
    conversationHistory,
    signal
  );
}
