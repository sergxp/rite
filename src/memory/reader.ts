import { readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { getMemoryRoot, getMemoryDir, pathToSlug, slugToTier } from "./paths.js";
import type { MemoryFile, MemoryFrontmatter } from "./types.js";
import { log } from "../utils/logger.js";

function loadMemoriesFromDir(
  dir: string,
  slug: string,
  cwd: string
): MemoryFile[] {
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch (err) {
    log.warn("memory.readdir.failed", { scope: "memory.reader", dir, err });
    return [];
  }

  const tier = slugToTier(slug, cwd);
  const memories: MemoryFile[] = [];
  let skipped = 0;

  for (const file of files) {
    const filePath = join(dir, file);
    const parsed = parseFrontmatter(filePath);
    if (!parsed) {
      log.warn("memory.parse.failed", { scope: "memory.reader", filePath });
      skipped++;
      continue;
    }

    const fm = parsed.data as Partial<MemoryFrontmatter>;
    if (!fm.name || !fm.inject) {
      log.warn("memory.frontmatter.incomplete", { scope: "memory.reader", filePath, hasName: !!fm.name, inject: fm.inject });
      skipped++;
      continue;
    }

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

  log.debug("memory.dir.loaded", { scope: "memory.reader", dir, tier, files: files.length, loaded: memories.length, skipped });
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
  if (!existsSync(root)) {
    log.debug("memory.root.missing", { scope: "memory.reader", root });
    return { always: [], semantic: [], all: [] };
  }

  let slugs: string[];
  try {
    slugs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    log.warn("memory.root.scan.failed", { scope: "memory.reader", root, err });
    return { always: [], semantic: [], all: [] };
  }

  const projectSlug = pathToSlug(cwd);

  const all: MemoryFile[] = [];

  for (const slug of slugs) {
    const dir = join(root, slug);
    const memories = loadMemoriesFromDir(dir, slug, cwd);
    all.push(...memories);
  }

  const always = all.filter(
    (m) =>
      m.frontmatter.inject === "always" &&
      (m.tier === "global" || m.tier === "project")
  );
  const semantic = all.filter((m) => m.frontmatter.inject === "semantic");

  log.info("memory.loaded", {
    scope: "memory.reader",
    cwd,
    projectSlug,
    slugs: slugs.length,
    total: all.length,
    always: always.length,
    semantic: semantic.length,
  });

  return { always, semantic, all };
}

/** Export for use in writer.ts */
export { pathToSlug };

