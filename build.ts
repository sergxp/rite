import { writeFileSync, chmodSync } from "fs"

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  // Keep opentui packages external — they use dynamic imports to load the
  // native .dylib and need to resolve from node_modules at runtime.
  external: [
    "@opentui/core",
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
    "@opentui/solid",
    "@opentui/keymap",
    "solid-js",
    "solid-js/store",
    "solid-js/web",
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// Prepend bun shebang so npm-linked binary runs without `bun` prefix
const outPath = "dist/index.js"
const content = await Bun.file(outPath).text()
// Use env -S so macOS accepts the fallback path in one shebang line
const bunPath = Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`
writeFileSync(outPath, `#!/usr/bin/env -S ${bunPath}\n${content}`)
chmodSync(outPath, 0o755)

console.log("Built dist/index.js")
