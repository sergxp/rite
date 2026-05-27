import { execa } from "execa";
import { resolveTemplate } from "../../utils/template.js";
import type { ShellStep } from "../types.js";
import type { StepContext } from "../runner.js";

export async function runShellStep(
  step: ShellStep,
  context: StepContext
): Promise<string> {
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

    return output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Shell step error: ${message}`);
    return message;
  }
}
