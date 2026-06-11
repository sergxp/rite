import { join, dirname, sep } from "path";
import os from "os";

const HOME = os.homedir();

/**
 * Encode an absolute path into a folder-name slug, mirroring ~/.claude/projects/:
 *   C:\Repositories\rite  →  C--Repositories-rite
 *   /home/user/projects/foo  →  home-user-projects-foo
 */
export function pathToSlug(absPath: string): string {
  // Normalize separators to forward slash for uniform handling.
  const normalized = absPath.replace(/\\/g, "/");

  // Replace drive letter colon-slash (e.g. "C:/") with "C--".
  const withDrive = normalized.replace(/^([A-Za-z]):\//, "$1--");

  // Replace remaining separators and dots with dashes.
  return withDrive
    .replace(/\//g, "-")
    .replace(/\./g, "-")
    .replace(/-{2,}/g, "--") // collapse 3+ dashes but keep intentional --
    .replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
}

/**
 * The single root where all Rite memories live.
 */
export function getMemoryRoot(): string {
  return join(HOME, ".rite", "memory");
}

/**
 * Resolve the memory subdirectory for a given scope.
 *
 * - "global"    → ~/.rite/memory/global/
 * - "project"   → ~/.rite/memory/<pathToSlug(cwd)>/
 * - "workspace" → ~/.rite/memory/<pathToSlug(parent of cwd)>/
 */
export function getMemoryDir(
  scope: "global" | "workspace" | "project",
  cwd: string = process.cwd()
): string {
  const root = getMemoryRoot();
  if (scope === "global") return join(root, "global");
  if (scope === "project") return join(root, pathToSlug(cwd));
  // workspace → parent directory of cwd
  const parent = dirname(cwd);
  return join(root, pathToSlug(parent === cwd ? cwd : parent));
}

/**
 * Classify a memory subfolder name (slug) into a tier relative to the current cwd.
 */
export function slugToTier(
  slug: string,
  cwd: string = process.cwd()
): "global" | "workspace" | "project" {
  if (slug === "global") return "global";

  const projectSlug = pathToSlug(cwd);
  if (slug === projectSlug) return "project";

  // Any ancestor path slug is workspace.
  const parts = cwd.split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestorSlug = pathToSlug(parts.slice(0, i).join(sep));
    if (slug === ancestorSlug) return "workspace";
  }

  // Memories from other unrelated projects are still surfaced (via semantic search)
  // but classed as workspace for display purposes.
  return "workspace";
}
