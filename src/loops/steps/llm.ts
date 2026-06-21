import { getBackend } from "../../backends/index.js";
import { drainAgentStream } from "../../backends/drain.js";
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

  const resolvedPrompt = resolveTemplate(step.prompt, context);
  const stream = backendFn(resolvedPrompt, options?.signal, step.model ? { model: step.model } : undefined);

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
