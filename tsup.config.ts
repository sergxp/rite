import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  bundle: true,
  platform: "node",
  esbuildOptions(options) {
    options.jsx = "automatic"
    options.jsxImportSource = "@opentui/solid"
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
})
