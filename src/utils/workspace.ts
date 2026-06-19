import { execFileSync } from "child_process"
import { existsSync, readFileSync, statSync } from "fs"
import { basename, dirname, isAbsolute, join, resolve } from "path"

export interface WorkspaceInfo {
  cwd: string
  repo?: string
  branch?: string
}

export function getWorkspaceInfo(cwd = process.cwd()): WorkspaceInfo {
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd) ?? findGitRoot(cwd)
  if (!repoRoot) return { cwd, repo: basename(cwd) }

  const branch =
    git(["branch", "--show-current"], cwd) ||
    readGitHeadBranch(repoRoot) ||
    git(["rev-parse", "--short", "HEAD"], cwd) ||
    undefined
  return {
    cwd,
    repo: basename(repoRoot),
    branch,
  }
}

export function formatWorkspaceInfo(info: WorkspaceInfo): string {
  if (!info.repo) return info.cwd
  return `${info.repo}${info.branch ? `@${info.branch}` : ""} · ${info.cwd}`
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim() || null
  } catch {
    return null
  }
}

function findGitRoot(cwd: string): string | null {
  let current = resolve(cwd)
  while (true) {
    const dotGit = join(current, ".git")
    if (existsSync(dotGit)) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function readGitHeadBranch(repoRoot: string): string | null {
  const gitDir = resolveGitDir(repoRoot)
  if (!gitDir) return null

  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim()
    const prefix = "ref: refs/heads/"
    if (head.startsWith(prefix)) return head.slice(prefix.length)
    return head.slice(0, 7) || null
  } catch {
    return null
  }
}

function resolveGitDir(repoRoot: string): string | null {
  const dotGit = join(repoRoot, ".git")
  try {
    if (statSync(dotGit).isDirectory()) return dotGit
    const raw = readFileSync(dotGit, "utf-8").trim()
    const prefix = "gitdir:"
    if (!raw.toLowerCase().startsWith(prefix)) return null
    const gitDir = raw.slice(prefix.length).trim()
    return isAbsolute(gitDir) ? gitDir : resolve(repoRoot, gitDir)
  } catch {
    return null
  }
}
