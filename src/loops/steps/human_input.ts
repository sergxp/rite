import * as readline from "readline";
import type { HumanInputStep } from "../types.js";
import type { StepContext } from "../runner.js";

export async function runHumanInputStep(
  step: HumanInputStep,
  _context: StepContext
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(`${step.prompt}\n> `, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
