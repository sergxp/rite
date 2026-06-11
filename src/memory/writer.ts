import { writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { writeFrontmatter, parseFrontmatter } from "../utils/frontmatter.js";
import { getMemoryRoot, getMemoryDir } from "./paths.js";
import type { MemoryFrontmatter } from "./types.js";
import { embedAndCacheMemory } from "./embeddings.js";

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function createMemory(
  name: string,
  frontmatter: Omit<MemoryFrontmatter, "name" | "created" | "updated">,
  body: string,
  scope: "global" | "workspace" | "project" = "project"
): string {
  const dir = getMemoryDir(scope);
  ensureDir(dir);

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
  scope: "global" | "workspace" | "project" = "project"
): string | null {
  try {
    const dir = getMemoryDir(scope);
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

/**
 * Delete a memory by name, searching all subfolders of ~/.rite/memory/.
 * If scope is specified, only search that scope's directory.
 */
export function deleteMemory(
  name: string,
  scope?: "global" | "workspace" | "project"
): boolean {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let deleted = false;

  if (scope) {
    const filePath = join(getMemoryDir(scope), `${slug}.md`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }

  // No scope specified: search all subdirs.
  const root = getMemoryRoot();
  if (!existsSync(root)) return false;

  try {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(root, e.name));

    for (const dir of dirs) {
      const filePath = join(dir, `${slug}.md`);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        deleted = true;
      }
    }
  } catch {
    // best-effort
  }

  return deleted;
}

/**
 * Check if a memory file exists anywhere in the central store.
 * Returns the scope where found, or null.
 */
export function findMemoryScope(
  name: string
): "global" | "workspace" | "project" | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  for (const scope of ["global", "workspace", "project"] as const) {
    const filePath = join(getMemoryDir(scope), `${slug}.md`);
    if (existsSync(filePath)) return scope;
  }
  return null;
}
