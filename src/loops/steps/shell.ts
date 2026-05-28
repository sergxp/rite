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

    const output = result.all ?? "";
    if (output) {
      process.stdout.write(output);
      process.stdout.write("\n");
    }

    return {
      output,
      resolvedCommand,
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Shell step error: ${message}`);
    return {
      output: message,
      resolvedCommand,
      exitCode: 1,
      stdout: "",
      stderr: message,
    };
  }
}
