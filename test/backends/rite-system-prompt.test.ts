import { describe, expect, it } from "vitest"
import { RITE_SYSTEM_PROMPT } from "../../src/backends/rite-system-prompt"

describe("RITE_SYSTEM_PROMPT", () => {
  it("teaches backend agents Rite's runtime model and workflows", () => {
    expect(RITE_SYSTEM_PROMPT).toContain("Rite operating model")
    expect(RITE_SYSTEM_PROMPT).toContain("A Rite session is the durable user-visible conversation")
    expect(RITE_SYSTEM_PROMPT).toContain("Forks copy Rite history into a new branch/group")
    expect(RITE_SYSTEM_PROMPT).toContain("rite session list")
    expect(RITE_SYSTEM_PROMPT).toContain("rite memory")
    expect(RITE_SYSTEM_PROMPT).toContain("rite loop <name>")
  })

  it("documents configuration precedence and supported keys", () => {
    expect(RITE_SYSTEM_PROMPT).toContain(
      'defaults < ~/.rite/config.json < cosmiconfig("rite") < <cwd>/.rite/config.json',
    )
    for (const key of ["backend", "utilityBackend", "historyLimit", "tokenBudget", "anthropicApiKey"]) {
      expect(RITE_SYSTEM_PROMPT).toContain(key)
    }
  })

  it("documents durable Rite file locations without source-level detail", () => {
    for (const path of [
      "~/.rite/sessions/<projectSlug>/<sid>.json",
      "~/.rite/sessions/<sid>/cron.json",
      "~/.rite/memory/global/*.md",
      "~/.rite/models/",
      "~/.rite/loops/*.json",
      "~/.rite/skills/*.md",
      "~/.rite/logs/rite-YYYYMMDD.jsonl",
      "~/.rite/attachments/images/<sid>/*.png",
      "<cwd>/.rite/config.json",
      "<cwd>/.rite/audit.jsonl",
    ]) {
      expect(RITE_SYSTEM_PROMPT).toContain(path)
    }
  })

  it("keeps Rite-owned orchestration explicit", () => {
    for (const command of ["/cron", "/loop", "/memory", "/model", "/compact", "/resume", "/fork", "/clear", "/copy", "/logs"]) {
      expect(RITE_SYSTEM_PROMPT).toContain(command)
    }
    expect(RITE_SYSTEM_PROMPT).toContain("Alt+V")
    expect(RITE_SYSTEM_PROMPT).not.toContain("/paste")
    expect(RITE_SYSTEM_PROMPT).toContain("built-in scheduler tools")
    expect(RITE_SYSTEM_PROMPT).toContain("No background work")
    expect(RITE_SYSTEM_PROMPT).toContain("RITE_LOG_LEVEL=trace|debug|info|warn|error")
  })
})
