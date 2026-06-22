import { Command } from "commander"
import * as readline from "readline"
import { existsSync } from "fs"
import { join } from "path"
import os from "os"
import { execSync } from "child_process"
import { startApp } from "./app.js"
import { ensureRiteDir, ensureDefaultLoops } from "./utils/init.js"
import { loadConfig } from "./config/loader.js"
import { loadMemories } from "./memory/reader.js"
import { createMemory, deleteMemory } from "./memory/writer.js"
import { parseFrontmatter } from "./utils/frontmatter.js"
import { loadLoops, findLoop, registerLoop } from "./loops/registry.js"
import { SessionStore } from "./sessions/store.js"
import { installWindowsTerminalProfileIcon } from "./utils/terminal.js"
import type { InjectMode, MemoryType, Priority } from "./memory/types.js"

const program = new Command()
  .name("rite")
  .description("Rite — AI coding assistant with persistent memory")
  .version("2.0.0")

program
  .command("session-start", { isDefault: true, hidden: true })
  .description("Start or resume an interactive session")
  .option("-r, --resume <id>", "Resume a session by ID")
  .action(async (opts: { resume?: string }) => {
    ensureDefaultLoops()
    await startApp({ resumeSessionId: opts.resume })
  })

// ---- terminal integration commands ----
const terminal = program.command("terminal").description("Manage terminal integration")

terminal
  .command("setup-icon")
  .description("Set the current Windows Terminal profile icon to Rite")
  .option("--settings <path>", "Path to Windows Terminal settings.json")
  .option("--profile <guid>", "Windows Terminal profile GUID (defaults to WT_PROFILE_ID)")
  .action((opts: { settings?: string; profile?: string }) => {
    try {
      const result = installWindowsTerminalProfileIcon({
        settingsPath: opts.settings,
        profileId: opts.profile,
      })
      console.log(result.changed ? "Windows Terminal profile icon updated." : "Windows Terminal profile icon already set.")
      console.log(`  Profile:  ${result.profileId}`)
      console.log(`  Icon:     ${result.iconPath}`)
      console.log(`  Settings: ${result.settingsPath}`)
      console.log("Open a new tab, or wait for Windows Terminal to reload settings, to see the icon.")
    } catch (err) {
      console.error(`Failed to set Windows Terminal profile icon: ${(err as Error).message}`)
      process.exit(1)
    }
  })

// ---- memory commands ----
const memory = program.command("memory").description("Manage memory files")

memory
  .command("list")
  .description("List all loaded memory files")
  .action(() => {
    const loaded = loadMemories()
    if (loaded.all.length === 0) {
      console.log("No memory files found.")
      return
    }
    console.log(`\nLoaded ${loaded.all.length} memory file(s):\n`)
    for (const m of loaded.all) {
      const { name, type, inject, priority, tags } = m.frontmatter
      const tagStr = tags.length > 0 ? `  [${tags.join(", ")}]` : ""
      console.log(`  ${name}`)
      console.log(`    tier: ${m.tier} | type: ${type} | inject: ${inject} | priority: ${priority}${tagStr}`)
      console.log(`    path: ${m.filePath}`)
      console.log()
    }
  })

memory
  .command("add <file>")
  .description("Add a memory file (copy into .rite/memory/)")
  .option("--global", "Add to global memory (~/.rite/memory/)")
  .action((file: string, opts: { global?: boolean }) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`)
      process.exit(1)
    }
    const parsed = parseFrontmatter(file)
    if (!parsed) {
      console.error("Could not parse file.")
      process.exit(1)
    }
    const fm = parsed.data as Record<string, unknown>
    if (!fm.name || !fm.inject) {
      console.error("Memory file must have 'name' and 'inject' in frontmatter.")
      process.exit(1)
    }
    ensureRiteDir()
    const filePath = createMemory(
      fm.name as string,
      {
        type: (fm.type as MemoryType) ?? "reference",
        tags: (fm.tags as string[]) ?? [],
        inject: (fm.inject as InjectMode) ?? "semantic",
        priority: (fm.priority as Priority) ?? "normal",
      },
      parsed.content.trim(),
      opts.global ? "global" : "project",
    )
    console.log(`Memory added: ${filePath}`)
  })

memory
  .command("edit <name>")
  .description("Open a memory file in $EDITOR")
  .action((name: string) => {
    const loaded = loadMemories()
    const match = loaded.all.find(
      (m) => m.frontmatter.name.toLowerCase() === name.toLowerCase(),
    )
    if (!match) {
      console.error(`Memory not found: ${name}`)
      process.exit(1)
    }
    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi"
    try {
      execSync(`${editor} "${match.filePath}"`, { stdio: "inherit" })
    } catch {
      console.error("Editor exited with error.")
      process.exit(1)
    }
  })

memory
  .command("delete <name>")
  .description("Delete a memory file by name")
  .option("--global", "Delete from global memory only")
  .option("--project", "Delete from project memory only")
  .action((name: string, opts: { global?: boolean; project?: boolean }) => {
    let scope: "global" | "project" | undefined
    if (opts.global) scope = "global"
    else if (opts.project) scope = "project"
    if (deleteMemory(name, scope)) {
      console.log(`Memory deleted: ${name}`)
    } else {
      console.error(`Memory not found: ${name}`)
      process.exit(1)
    }
  })

memory
  .command("search <query>")
  .description("Search memories by name, tag, body content, or semantic similarity")
  .action(async (query: string) => {
    const { searchMemories } = await import("./memory/search.js")
    const results = await searchMemories(query)
    if (results.length === 0) {
      console.log(`No memories found matching '${query}'`)
      return
    }
    console.log(`\n${results.length} result(s) for '${query}':\n`)
    for (const m of results) {
      const tagStr = m.frontmatter.tags.length ? `  [${m.frontmatter.tags.join(", ")}]` : ""
      console.log(`  ${m.frontmatter.name}  (${m.tier} · ${m.frontmatter.inject})${tagStr}`)
    }
    console.log()
  })

// ---- loop commands ----
program
  .command("loop <name>")
  .description("Run a loop by name")
  .option("--context <text>", "Context string to pass into the loop", "")
  .action(async (name: string, opts: { context: string }) => {
    ensureRiteDir()
    const loop = findLoop(name)
    if (!loop) {
      console.error(`Loop not found: ${name}`)
      const available = loadLoops()
      if (available.length > 0) {
        console.error("\nAvailable loops:")
        for (const l of available) console.error(`  ${l.name}  [${l.steps.length} steps]`)
      }
      process.exit(1)
    }
    const config = await loadConfig()
    const { runLoop } = await import("./loops/runner.js")
    await runLoop(loop, opts.context, config)
  })

const loops = program.command("loops").description("Manage loop workflow files")

loops
  .command("list")
  .description("List all registered loops")
  .action(() => {
    const all = loadLoops()
    if (all.length === 0) {
      console.log("No loops registered.")
      console.log(`  Global:  ${join(os.homedir(), ".rite", "loops")}/`)
      console.log(`  Project: ${join(process.cwd(), ".rite", "loops")}/`)
      return
    }
    console.log(`\n${all.length} loop(s) registered:\n`)
    for (const l of all) {
      const desc = l.description ? `  ${l.description}` : ""
      console.log(`  ${l.name.padEnd(20)} [${l.steps.length} steps]${desc}`)
    }
    console.log()
  })

loops
  .command("add <file>")
  .description("Register a loop file (copy to .rite/loops/)")
  .action((file: string) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`)
      process.exit(1)
    }
    ensureRiteDir()
    try {
      console.log(`Loop registered: ${registerLoop(file)}`)
    } catch (err) {
      console.error(`Failed to register loop: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ---- session commands ----
const session = program.command("session").description("Manage sessions")

async function findSessionOrExit(idOrName: string) {
  const sessions = await SessionStore.list(process.cwd())
  const found = SessionStore.find(idOrName, sessions)
  if (!found) {
    console.error(`Session not found: ${idOrName}`)
    process.exit(1)
  }
  return found
}

session
  .command("list")
  .description("List all sessions for this project")
  .action(async () => {
    ensureRiteDir()
    const sessions = await SessionStore.list(process.cwd())
    if (sessions.length === 0) {
      console.log("No sessions found.")
      return
    }
    console.log(`\n${sessions.length} session(s):\n`)
    const pad = (s: string, n: number) => s.padEnd(n)
    console.log(`  ${pad("id", 26)}  ${pad("name", 24)}  ${pad("type", 12)}  ${pad("date", 12)}  turns`)
    console.log("  " + "-".repeat(84))
    for (const s of sessions) {
      const typeLabel = s.type === "loop" ? `loop:${s.loopName ?? "?"}` : "repl"
      const date = new Date(s.createdAt).toLocaleDateString()
      console.log(`  ${pad(s.id, 26)}  ${pad(s.name ?? "", 24)}  ${pad(typeLabel, 12)}  ${pad(date, 12)}  ${s.turns.length}`)
    }
    console.log()
  })

session
  .command("resume <id>")
  .description("Resume a session by id or name")
  .action(async (id: string) => {
    ensureRiteDir()
    const found = await findSessionOrExit(id)
    await startApp({ resumeSessionId: found.id })
  })

session
  .command("rename <id> <name>")
  .description("Rename a session")
  .action(async (id: string, name: string) => {
    ensureRiteDir()
    const found = await findSessionOrExit(id)
    await SessionStore.rename(found.id, name, process.cwd())
    console.log(`Session renamed: ${found.id} → ${name}`)
  })

session
  .command("delete <id>")
  .description("Delete a session")
  .action(async (id: string) => {
    ensureRiteDir()
    const found = await findSessionOrExit(id)
    const label = found.name ?? found.id
    const confirmed = await new Promise<boolean>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question(`Delete session "${label}"? [y/N] `, (answer) => {
        rl.close()
        resolve(answer.toLowerCase() === "y")
      })
    })
    if (!confirmed) {
      console.log("Cancelled.")
      return
    }
    await SessionStore.delete(found.id, process.cwd())
    console.log(`Session deleted: ${found.id}`)
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err)
  process.exit(1)
})
