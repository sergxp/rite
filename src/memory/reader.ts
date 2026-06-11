import { readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { getMemoryRoot, getMemoryDir, pathToSlug, slugToTier } from "./paths.js";
import type { MemoryFile, MemoryFrontmatter } from "./types.js";

function loadMemoriesFromDir(
  dir: string,
  slug: string,
  cwd: string
): MemoryFile[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const tier = slugToTier(slug, cwd);
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
      slug,
    });
  }

  return memories;
}

/**
 * Silently migrate old in-project .rite/memory/ files to the centralized store.
 * Runs once per cwd; no-ops if cwd dir doesn't exist or is already empty.
 */
function migrateProjectDir(cwd: string): void {
  const oldDir = join(cwd, ".rite", "memory");
  if (!existsSync(oldDir)) return;

  let files: string[];
  try {
    files = readdirSync(oldDir).filter((f) => f.endsWith(".md"));
  } catch {
    return;
  }

  if (files.length === 0) return;

  const targetDir = getMemoryDir("project", cwd);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  for (const file of files) {
    const src = join(oldDir, file);
    const dest = join(targetDir, file);
    if (!existsSync(dest)) {
      try { renameSync(src, dest); } catch { /* best-effort */ }
    }
  }
}

export interface LoadedMemories {
  always: MemoryFile[];
  semantic: MemoryFile[];
  all: MemoryFile[];
}

export function loadMemories(cwd: string = process.cwd()): LoadedMemories {
  // Silently migrate old per-project memory dir if present.
  migrateProjectDir(cwd);

  const root = getMemoryRoot();
  if (!existsSync(root)) return { always: [], semantic: [], all: [] };

  // Enumerate all subdirectories of ~/.rite/memory/
  let slugs: string[];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return { always: [], semantic: [], all: [] };
  }

  const projectSlug = pathToSlug(cwd);

  // Load order: global first, then project/workspace, then other project dirs.
  // "always" injection only fires for global + project tiers.
  const all: MemoryFile[] = [];

  for (const slug of slugs) {
    const dir = join(root, slug);
    const memories = loadMemoriesFromDir(dir, slug, cwd);
    all.push(...memories);
  }

  // Project slug dir may not exist yet — that's fine.
  // Ensure global and project are represented even if empty (writer handles creation).

  const always = all.filter(
    (m) =>
      m.frontmatter.inject === "always" &&
      (m.tier === "global" || m.tier === "project")
  );
  const semantic = all.filter((m) => m.frontmatter.inject === "semantic");

  return { always, semantic, all };
}

/** Export for use in writer.ts */
export { pathToSlug };

