import { Command } from "commander";
import { loadConfig } from "./config/loader.js";
import { loadMemories } from "./memory/reader.js";
import { createMemory, deleteMemory } from "./memory/writer.js";
import { ensureRiteDir } from "./utils/init.js";
import { parseFrontmatter } from "./utils/frontmatter.js";
import { existsSync } from "fs";
import { join } from "path";
import os from "os";
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { loadLoops, findLoop, registerLoop } from "./loops/registry.js";

const program = new Command();

program
  .name("rite")
  .description("A CLI that wraps Claude Code with persistent memory")
  .version("0.1.0");

// Default command: start REPL
program
  .command("start", { isDefault: true })
  .description("Start the Rite REPL (default)")
  .action(async () => {
    ensureRiteDir();
    const config = await loadConfig();
    const { startRepl } = await import("./repl/index.js");
    await startRepl(config.backend, config.historyLimit, config);
  });

// ---- memory commands ----
const memory = program.command("memory").description("Manage memory files");

memory
  .command("list")
  .description("List all loaded memory files")
  .action(() => {
    const loaded = loadMemories();
    if (loaded.all.length === 0) {
      console.log("No memory files found.");
      console.log(
        `  Global:  ${join(os.homedir(), ".rite", "memory")}/*.md`
      );
      console.log(
        `  Project: ${join(process.cwd(), ".rite", "memory")}/*.md`
      );
      return;
    }

    console.log(`\nLoaded ${loaded.all.length} memory file(s):\n`);
    for (const m of loaded.all) {
      const { name, type, inject, priority, tags } = m.frontmatter;
      const tagStr = tags.length > 0 ? `  [${tags.join(", ")}]` : "";
      console.log(`  ${name}`);
      console.log(
        `    tier: ${m.tier} | type: ${type} | inject: ${inject} | priority: ${priority}${tagStr}`
      );
      console.log(`    path: ${m.filePath}`);
      console.log();
    }
  });

memory
  .command("add <file>")
  .description("Add a memory file (copy into .rite/memory/)")
  .option("--global", "Add to global memory (~/.rite/memory/)")
  .action((file: string, opts: { global?: boolean }) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }

    const parsed = parseFrontmatter(file);
    if (!parsed) {
      console.error("Could not parse file.");
      process.exit(1);
    }

    const fm = parsed.data as Record<string, unknown>;
    if (!fm.name || !fm.inject) {
      console.error(
        "Memory file must have 'name' and 'inject' in frontmatter."
      );
      process.exit(1);
    }

    const scope = opts.global ? "global" : "project";
    ensureRiteDir();

    const filePath = createMemory(
      fm.name as string,
      {
        type: (fm.type as "rule") ?? "reference",
        tags: (fm.tags as string[]) ?? [],
        inject: (fm.inject as "always") ?? "semantic",
        priority: (fm.priority as "normal") ?? "normal",
      },
      parsed.content.trim(),
      scope
    );

    console.log(`Memory added: ${filePath}`);
  });

memory
  .command("edit <name>")
  .description("Open a memory file in $EDITOR")
  .option("--global", "Edit from global memory (~/.rite/memory/)")
  .action((name: string, opts: { global?: boolean }) => {
    const loaded = loadMemories();
    const match = loaded.all.find(
      (m) =>
        m.frontmatter.name === name ||
        m.frontmatter.name.toLowerCase() === name.toLowerCase()
    );

    if (!match) {
      console.error(`Memory not found: ${name}`);
      process.exit(1);
    }

    if (opts.global && match.tier !== "global") {
      console.error(`Memory '${name}' is not in global tier.`);
      process.exit(1);
    }

    const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
    try {
      execSync(`${editor} "${match.filePath}"`, { stdio: "inherit" });
    } catch {
      console.error("Editor exited with error.");
      process.exit(1);
    }
  });

memory
  .command("delete <name>")
  .description("Delete a memory file by name")
  .option("--global", "Delete from global memory only")
  .option("--project", "Delete from project memory only")
  .action((name: string, opts: { global?: boolean; project?: boolean }) => {
    let scope: "global" | "project" | "both" = "both";
    if (opts.global) scope = "global";
    else if (opts.project) scope = "project";

    const deleted = deleteMemory(name, scope);
    if (deleted) {
      console.log(`Memory deleted: ${name}`);
    } else {
      console.error(`Memory not found: ${name}`);
      process.exit(1);
    }
  });

memory
  .command("search <query>")
  .description("Search memories by name, tag, body content, or semantic similarity")
  .action(async (query: string) => {
    const { searchMemories } = await import("./memory/search.js");
    const results = await searchMemories(query);

    if (results.length === 0) {
      console.log(`No memories found matching '${query}'`);
      return;
    }

    const nameW = Math.max(4, ...results.map((m) => m.frontmatter.name.length));
    const typeW = Math.max(4, ...results.map((m) => m.frontmatter.type.length));
    const injectW = Math.max(6, ...results.map((m) => m.frontmatter.inject.length));
    const tierW = Math.max(4, ...results.map((m) => m.tier.length));
    const tagsW = Math.max(4, ...results.map((m) => m.frontmatter.tags.join(", ").length));

    const pad = (s: string, n: number) => s.padEnd(n);
    const header = `${pad("name", nameW)}  ${pad("type", typeW)}  ${pad("inject", injectW)}  ${pad("tier", tierW)}  tags`;
    const divider = "-".repeat(header.length + tagsW);

    console.log(`\n${results.length} result(s) for '${query}':\n`);
    console.log(header);
    console.log(divider);
    for (const m of results) {
      const tagStr = m.frontmatter.tags.join(", ");
      console.log(
        `${pad(m.frontmatter.name, nameW)}  ${pad(m.frontmatter.type, typeW)}  ${pad(m.frontmatter.inject, injectW)}  ${pad(m.tier, tierW)}  ${tagStr}`
      );
    }
    console.log();
  });

// ---- backend command ----
program
  .command("backend")
  .description("Manage backend settings")
  .addCommand(
    new Command("set")
      .argument("<name>", "Backend name: claude | codex")
      .description("Set the active backend")
      .action(async (name: string) => {
        if (name !== "claude" && name !== "codex") {
          console.error(
            `Invalid backend: ${name}. Valid options: claude, codex`
          );
          process.exit(1);
        }

        ensureRiteDir();

        const projectConfigPath = join(process.cwd(), ".rite", "config.json");
        let existing: Record<string, unknown> = {};
        if (existsSync(projectConfigPath)) {
          try {
            existing = JSON.parse(
              readFileSync(projectConfigPath, "utf-8")
            ) as Record<string, unknown>;
          } catch {
            existing = {};
          }
        }

        existing.backend = name;
        writeFileSync(
          projectConfigPath,
          JSON.stringify(existing, null, 2),
          "utf-8"
        );

        console.log(`Backend set to: ${name}`);
      })
  );

// ---- loop command ----
program
  .command("loop <name>")
  .description("Run a loop by name")
  .option("--context <text>", "Context string to pass into the loop", "")
  .action(async (name: string, opts: { context: string }) => {
    ensureRiteDir();
    const loop = findLoop(name);
    if (!loop) {
      const available = loadLoops();
      if (available.length === 0) {
        console.error(`Loop not found: ${name}`);
        console.error("No loops registered. Use: rite loops add <file.json>");
      } else {
        console.error(`Loop not found: ${name}`);
        console.error("\nAvailable loops:");
        for (const l of available) {
          console.error(`  ${l.name}  [${l.steps.length} steps]`);
        }
      }
      process.exit(1);
    }

    const config = await loadConfig();
    const { runLoop } = await import("./loops/runner.js");
    await runLoop(loop, opts.context, config);
  });

// ---- loops command group ----
const loops = program.command("loops").description("Manage loop workflow files");

loops
  .command("list")
  .description("List all registered loops")
  .action(() => {
    const all = loadLoops();
    if (all.length === 0) {
      console.log("No loops registered.");
      console.log(
        `  Global:  ${join(os.homedir(), ".rite", "loops")}/`
      );
      console.log(
        `  Project: ${join(process.cwd(), ".rite", "loops")}/`
      );
      return;
    }

    console.log(`\n${all.length} loop(s) registered:\n`);
    for (const l of all) {
      const desc = l.description ? `  ${l.description}` : "";
      console.log(`  ${l.name.padEnd(20)} [${l.steps.length} steps]${desc}`);
    }
    console.log();
    console.log(`  Global:  ${join(os.homedir(), ".rite", "loops")}/`);
    console.log(`  Project: ${join(process.cwd(), ".rite", "loops")}/`);
    console.log();
  });

loops
  .command("add <file>")
  .description("Register a loop file (copy to .rite/loops/)")
  .action((file: string) => {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      process.exit(1);
    }

    ensureRiteDir();

    try {
      const dest = registerLoop(file);
      console.log(`Loop registered: ${dest}`);
    } catch (err) {
      console.error(
        `Failed to register loop: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
