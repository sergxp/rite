import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, basename } from "path";
import os from "os";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { Skill } from "./types.js";

function skillsFromDir(dir: string, scope: "global" | "project"): Skill[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    try {
      const parsed = parseFrontmatter(filePath);
      if (!parsed) continue;
      const fm = parsed.data as Record<string, unknown>;
      if (!fm.name || typeof fm.name !== "string") continue;

      skills.push({
        name: fm.name,
        description: typeof fm.description === "string" ? fm.description : "",
        content: parsed.content.trim(),
        filePath,
        scope,
      });
    } catch {
      // skip unparseable files
    }
  }

  return skills;
}

export function loadSkills(): Skill[] {
  const globalDir = join(os.homedir(), ".rite", "skills");
  const projectDir = join(process.cwd(), ".rite", "skills");

  // Project skills shadow global ones with the same name
  const byName = new Map<string, Skill>();
  for (const s of skillsFromDir(globalDir, "global")) byName.set(s.name.toLowerCase(), s);
  for (const s of skillsFromDir(projectDir, "project")) byName.set(s.name.toLowerCase(), s);

  return [...byName.values()];
}

export function findSkill(name: string): Skill | null {
  const skills = loadSkills();
  const lower = name.toLowerCase();
  return skills.find((s) => s.name.toLowerCase() === lower) ?? null;
}

export function registerSkill(
  filePath: string,
  scope: "global" | "project" = "project"
): string {
  const parsed = parseFrontmatter(filePath);
  if (!parsed) throw new Error("Could not parse skill file");

  const fm = parsed.data as Record<string, unknown>;
  if (!fm.name || typeof fm.name !== "string") {
    throw new Error("Skill file must have a 'name' string in frontmatter");
  }

  const destDir =
    scope === "global"
      ? join(os.homedir(), ".rite", "skills")
      : join(process.cwd(), ".rite", "skills");

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  const raw = readFileSync(filePath, "utf-8");
  const destPath = join(destDir, basename(filePath));
  writeFileSync(destPath, raw, "utf-8");
  return destPath;
}
