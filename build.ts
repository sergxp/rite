import { writeFileSync, chmodSync } from "fs"
import solidPlugin from "@opentui/solid/bun-plugin"

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  // The solid plugin compiles our JSX with babel-preset-solid and swaps
  // solid-js's SSR build for the client build. @opentui/solid and solid-js
  // must be BUNDLED (not external) so the dist carries that client build and
  // a single solid-js instance — externalized, the runtime would resolve the
  // SSR build and context/reactivity break across the renderer boundary.
  plugins: [solidPlugin],
  // Keep @opentui/core external — it dynamically loads the native .dylib and
  // needs to resolve from node_modules at runtime.
  external: [
    "@opentui/core",
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-win32-x64",
    "@opentui/core-win32-arm64",
    "@opentui/keymap",
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
// Strip .exe suffix — on Windows, npm's .ps1 wrapper appends its own .exe,
// so including it in the shebang results in "bun.exe.exe".
const bunPath = (Bun.which("bun") ?? `${process.env.HOME}/.bun/bin/bun`).replace(/\.exe$/i, "")
writeFileSync(outPath, `#!/usr/bin/env -S ${bunPath}\n${content}`)
chmodSync(outPath, 0o755)

console.log("Built dist/index.js")
