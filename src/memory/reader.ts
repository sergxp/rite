import { readdirSync, existsSync } from "fs";
import { join } from "path";
import os from "os";
import { parseFrontmatter } from "../utils/frontmatter.js";
import type { MemoryFile, MemoryFrontmatter } from "./types.js";

function loadMemoriesFromDir(
  dir: string,
  tier: "global" | "project"
): MemoryFile[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const memories: MemoryFile[] = [];
  for (const file of files) {
    const filePath = join(dir, file);
    const parsed = parseFrontmatter(filePath);
    if (!parsed) continue;

    const fm = parsed.data as Partial<MemoryFrontmatter>;
    if (!fm.name || !fm.inject) continue;

    memories.push({
      frontmatter: {
        name: fm.name,
        type: fm.type ?? "reference",
        tags: fm.tags ?? [],
        inject: fm.inject,
        priority: fm.priority ?? "normal",
        created: fm.created ?? "",
        updated: fm.updated ?? "",
      },
      content: parsed.content.trim(),
      filePath,
      tier,
    });
  }

  return memories;
}

export interface LoadedMemories {
  always: MemoryFile[];
  semantic: MemoryFile[];
  all: MemoryFile[];
}

export function loadMemories(): LoadedMemories {
  const globalDir = join(os.homedir(), ".rite", "memory");
  const projectDir = join(process.cwd(), ".rite", "memory");

  const globalMemories = loadMemoriesFromDir(globalDir, "global");
  const projectMemories = loadMemoriesFromDir(projectDir, "project");

  const all = [...globalMemories, ...projectMemories];

  const always = all.filter((m) => m.frontmatter.inject === "always");
  const semantic = all.filter((m) => m.frontmatter.inject === "semantic");

  return { always, semantic, all };
}
