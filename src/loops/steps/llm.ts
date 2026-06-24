import { getBackend } from "../../backends/index.js";
import { drainAgentStream } from "../../backends/drain.js";
import { formatSessionContext, resolveTemplate } from "../../utils/template.js";
import type { LlmStep } from "../types.js";
import type { StepContext } from "../runner.js";

export interface LlmStepResult {
  output: string;
  resolvedPrompt: string;
}

function promptReferencesSessionContext(prompt: string): boolean {
  return /\{\{\{?\s*session_context\s*\}?\}\}/.test(prompt);
}

export function injectLoopSessionContext(prompt: string, context: StepContext): string {
  if (promptReferencesSessionContext(prompt)) return resolveTemplate(prompt, context);

  const sessionContext = formatSessionContext(context);
  const resolvedPrompt = resolveTemplate(prompt, context);
  return [
    "Recent Rite session context:",
    sessionContext,
    "",
    "Loop step prompt:",
    resolvedPrompt,
  ].join("\n");
}

export async function runLlmStep(
  step: LlmStep,
  context: StepContext,
  options?: {
    onToken?: (text: string) => void;
    onThinkingDelta?: (accumulated: string) => void;
    onThinkingEnd?: (text: string) => void;
    onToolStatus?: (name: string) => void;
    onToolCall?: (name: string, id: string) => void;
    onToolDone?: (name: string, id: string, inputJson: string) => void;
    onToolResult?: (id: string, result: string, isError: boolean) => void;
    signal?: AbortSignal;
  }
): Promise<LlmStepResult> {
  const backend = context.config.backend ?? "claude";
  const backendFn = getBackend(backend);

  const resolvedPrompt = injectLoopSessionContext(step.prompt, context);
  const stream = backendFn(resolvedPrompt, options?.signal,
    (step.model || step.effort) ? { model: step.model, effort: step.effort } : undefined);

  let segmentLen = 0
  const { text } = await drainAgentStream(stream, {
    onTextDelta: (accumulated) => {
      const delta = accumulated.slice(segmentLen)
      segmentLen = accumulated.length
      if (delta) options?.onToken?.(delta)
    },
    onThinkingDelta: options?.onThinkingDelta,
    onThinkingEnd: options?.onThinkingEnd,
    onToolStart: (tool, id) => {
      segmentLen = 0
      options?.onToolStatus?.(tool.name)
      options?.onToolCall?.(tool.name, id)
    },
    onToolReady: (tool, id) => options?.onToolDone?.(tool.name, id, tool.inputJson),
    onToolResult: (tool, result, isError, id) => options?.onToolResult?.(id, result, isError),
  })

  return { output: text, resolvedPrompt };
}
