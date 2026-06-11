import { Command } from "commander"
import { startApp } from "./app.js"

const program = new Command()
  .name("rite")
  .description("Rite — AI coding assistant")
  .version("2.0.0")

program
  .command("session", { isDefault: true })
  .description("Start or resume an interactive session")
  .option("-r, --resume <id>", "Resume a session by ID")
  .option("-d, --dir <path>", "Working directory", process.cwd())
  .action(async (opts) => {
    await startApp({
      resumeSessionId: opts.resume,
      cwd: opts.dir,
    })
  })

program.parseAsync(process.argv).catch((err) => {
  console.error(err)
  process.exit(1)
})
