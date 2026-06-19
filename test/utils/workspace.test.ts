import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, join } from "path"
import { describe, expect, it } from "vitest"
import { formatWorkspaceInfo, getWorkspaceInfo } from "../../src/utils/workspace"

describe("formatWorkspaceInfo", () => {
  it("shows folder name first outside a git repo", () => {
    expect(formatWorkspaceInfo({ cwd: "C:\\Users\\Serge\\project", repo: "project" })).toBe("project · C:\\Users\\Serge\\project")
  })

  it("shows repo and branch when available", () => {
    expect(formatWorkspaceInfo({
      cwd: "C:\\Users\\Serge\\rite",
      repo: "rite",
      branch: "feat/v2-feature-port",
    })).toBe("rite@feat/v2-feature-port · C:\\Users\\Serge\\rite")
  })

  it("shows repo without branch for detached or unknown branch states", () => {
    expect(formatWorkspaceInfo({
      cwd: "C:\\Users\\Serge\\rite",
      repo: "rite",
    })).toBe("rite · C:\\Users\\Serge\\rite")
  })
})

describe("getWorkspaceInfo", () => {
  it("falls back to parsing .git/HEAD when git subprocess metadata is unavailable or incomplete", () => {
    const dir = mkdtempSync(join(tmpdir(), "rite-workspace-"))
    const repo = join(dir, "inventory-lims")
    const child = join(repo, "src")

    try {
      mkdirSync(join(repo, ".git"), { recursive: true })
      mkdirSync(child, { recursive: true })
      writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/staging\n")

      const info = getWorkspaceInfo(child)

      expect(info).toMatchObject({
        cwd: child,
        repo: basename(repo),
        branch: "staging",
      })
      expect(formatWorkspaceInfo(info).startsWith("inventory-lims@staging · ")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
