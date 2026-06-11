import { execa } from "execa";
import { resolveTemplate } from "../../utils/template.js";
import type { ShellStep } from "../types.js";
import type { StepContext } from "../runner.js";

export interface ShellStepResult {
  output: string;
  resolvedCommand: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runShellStep(
  step: ShellStep,
  context: StepContext
): Promise<ShellStepResult> {
  const resolvedCommand = resolveTemplate(step.command, context);

  try {
    const result = await execa("sh", ["-c", resolvedCommand], {
      all: true,
      reject: false,
    });

    // Output is returned for the runner to surface via its callbacks — never
    // written to stdout here, which would corrupt the TUI's Ink alt-screen.
    const output = result.all ?? "";

    return {
      output,
      resolvedCommand,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: message,
      resolvedCommand,
      exitCode: 1,
      stdout: "",
      stderr: message,
    };
  }
}
