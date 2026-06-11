import type { BackendName } from "../config/types.js";

export type StepType = "llm" | "shell" | "human_input" | "condition" | "review";

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

export interface ReviewStep extends BaseStep {
  type: "review";
  /** Template string describing what requirements to check. Supports {{steps.ID.output}} and {{context}}. */
  criteria: string;
  /** Step ID to jump back to when the review fails. */
  implementation_step: string;
  /** Maximum number of implement→review cycles before giving up. Defaults to 3. */
  max_iterations?: number;
}

export type Step = LlmStep | ShellStep | HumanInputStep | ConditionStep | ReviewStep;

export interface Loop {
  name: string;
  description?: string;
  backend?: BackendName;
  steps: Step[];
}
