import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, basename } from "path";
import os from "os";
import type { Loop } from "./types.js";

function loopsFromDir(dir: string): Loop[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const loops: Loop[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "name" in parsed &&
        typeof (parsed as Record<string, unknown>).name === "string" &&
        "steps" in parsed &&
        Array.isArray((parsed as Record<string, unknown>).steps)
      ) {
        loops.push(parsed as Loop);
      }
    } catch {
      // skip unparseable files
    }
  }

  return loops;
}

export function loadLoops(): Loop[] {
  const globalDir = join(os.homedir(), ".rite", "loops");
  const projectDir = join(process.cwd(), ".rite", "loops");
  return [...loopsFromDir(globalDir), ...loopsFromDir(projectDir)];
}

export function findLoop(name: string): Loop | null {
  const loops = loadLoops();
  const lower = name.toLowerCase();
  return loops.find((l) => l.name.toLowerCase() === lower) ?? null;
}

export function registerLoop(filePath: string): string {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("name" in parsed) ||
    typeof (parsed as Record<string, unknown>).name !== "string"
  ) {
    throw new Error("Loop file must have a 'name' string field");
  }

  const loop = parsed as Loop;
  if (!Array.isArray(loop.steps)) {
    throw new Error("Loop file must have a 'steps' array");
  }

  const destDir = join(process.cwd(), ".rite", "loops");
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const fileName = basename(filePath);
  const destPath = join(destDir, fileName);
  writeFileSync(destPath, raw, "utf-8");
  return destPath;
}
