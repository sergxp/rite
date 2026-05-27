import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import os from "os";
import { writeFrontmatter, parseFrontmatter } from "../utils/frontmatter.js";
import type { MemoryFrontmatter } from "./types.js";
import { embedAndCacheMemory } from "./embeddings.js";

function ensureMemoryDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function createMemory(
  name: string,
  frontmatter: Omit<MemoryFrontmatter, "name" | "created" | "updated">,
  body: string,
  scope: "global" | "project" = "project"
): string {
  const dir =
    scope === "global"
      ? join(os.homedir(), ".rite", "memory")
      : join(process.cwd(), ".rite", "memory");

  ensureMemoryDir(dir);

  const now = new Date().toISOString().split("T")[0];
  const fm: MemoryFrontmatter = {
    name,
    type: frontmatter.type,
    tags: frontmatter.tags,
    inject: frontmatter.inject,
    priority: frontmatter.priority,
    created: now,
    updated: now,
  };

  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const filePath = join(dir, `${slug}.md`);
  const content = writeFrontmatter(fm, body);
  writeFileSync(filePath, content, "utf-8");

  setImmediate(() => {
    void embedAndCacheMemory(filePath, body, now);
  });

  return filePath;
}

export function updateMemory(
  name: string,
  frontmatter: Omit<MemoryFrontmatter, "name" | "created" | "updated">,
  body: string,
  scope: "global" | "project" = "project"
): string | null {
  try {
    const dir =
      scope === "global"
        ? join(os.homedir(), ".rite", "memory")
        : join(process.cwd(), ".rite", "memory");

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const filePath = join(dir, `${slug}.md`);

    if (!existsSync(filePath)) {
      return createMemory(name, frontmatter, body, scope);
    }

    const parsed = parseFrontmatter(filePath);
    const originalCreated =
      parsed && (parsed.data as Record<string, unknown>).created
        ? String((parsed.data as Record<string, unknown>).created)
        : new Date().toISOString().split("T")[0];

    const now = new Date().toISOString().split("T")[0];
    const fm: MemoryFrontmatter = {
      name,
      type: frontmatter.type,
      tags: frontmatter.tags,
      inject: frontmatter.inject,
      priority: frontmatter.priority,
      created: originalCreated,
      updated: now,
    };

    const content = writeFrontmatter(fm, body);
    writeFileSync(filePath, content, "utf-8");

    setImmediate(() => {
      void embedAndCacheMemory(filePath, body, now);
    });

    return filePath;
  } catch {
    return null;
  }
}

export function deleteMemory(
  name: string,
  scope: "global" | "project" | "both" = "both"
): boolean {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let deleted = false;

  const dirs: Array<{ dir: string; tier: "global" | "project" }> = [];

  if (scope === "global" || scope === "both") {
    dirs.push({ dir: join(os.homedir(), ".rite", "memory"), tier: "global" });
  }
  if (scope === "project" || scope === "both") {
    dirs.push({
      dir: join(process.cwd(), ".rite", "memory"),
      tier: "project",
    });
  }

  for (const { dir } of dirs) {
    const filePath = join(dir, `${slug}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      deleted = true;
    }
  }

  return deleted;
}
