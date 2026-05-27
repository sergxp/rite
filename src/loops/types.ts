export type StepType = "llm" | "shell" | "human_input" | "condition";

export interface BaseStep {
  id: string;
  name?: string;
  type: StepType;
  human_checkpoint?: boolean;
  next?: string;
}

export interface LlmStep extends BaseStep {
  type: "llm";
  prompt: string;
}

export interface ShellStep extends BaseStep {
  type: "shell";
  command: string;
}

export interface HumanInputStep extends BaseStep {
  type: "human_input";
  prompt: string;
}

export interface ConditionStep extends BaseStep {
  type: "condition";
  prompt: string;
  if_true: string;
  if_false: string;
}

export type Step = LlmStep | ShellStep | HumanInputStep | ConditionStep;

export interface Loop {
  name: string;
  description?: string;
  backend?: "claude" | "codex";
  steps: Step[];
}
