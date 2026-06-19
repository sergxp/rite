import { Switch, Match, ErrorBoundary } from "solid-js"
import { render, useTerminalDimensions, useKeyboard, useSelectionHandler } from "@opentui/solid"
import { createCliRenderer } from "@opentui/core"
import { ThemeProvider } from "./context/theme"
import { RouteProvider, useRoute } from "./context/route"
import { ExitProvider } from "./context/exit"
import { ConfigProvider } from "./context/config"
import { SessionStoreProvider } from "./context/session-store"
import { loadConfig } from "./config/loader"
import { ensureRiteDir } from "./utils/init"
import { installCrashHandlers, log } from "./utils/logger"
import { getEmbeddingPipeline } from "./memory/embeddings"
import { copyToClipboard } from "./utils/clipboard"
import { markdownCopyTextForSelection } from "./utils/markdown-copy-source"
import { Home } from "./routes/home"
import { Session } from "./routes/session/index"

function ErrorFallback(props: { err: unknown; exit: () => void }) {
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.exit()
    if (key.name === "q") props.exit()
  })
  return (
    <box flexDirection="column" padding={2}>
      <text fg="red">{`⚠ Render error — see logs (${(props.err as Error)?.message ?? String(props.err)})`}</text>
      <text fg="gray">Press Ctrl+C or q to exit.</text>
    </box>
  )
}

export function GlobalSelectionCopy() {
  useSelectionHandler((selection) => {
    const text = selection ? (markdownCopyTextForSelection(selection) ?? selection.getSelectedText()) : ""
    if (!text.trim()) return
    void copyToClipboard(text)
  })
  return null
}

export function App() {
  const dimensions = useTerminalDimensions()
  const route = useRoute()

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
    >
      <GlobalSelectionCopy />
      <Switch>
        <Match when={route.data().type === "home"}>
          <Home />
        </Match>
        <Match when={route.data().type === "session"}>
          <Session />
        </Match>
      </Switch>
    </box>
  )
}

export interface AppOptions {
  resumeSessionId?: string
  cwd?: string
}

export async function startApp(options: AppOptions = {}) {
  ensureRiteDir()
  installCrashHandlers()
  // Warm up the local embedding pipeline in the background so it's ready by
  // the time the user finishes typing their first message. Failure is silent —
  // semantic search already has its own disabled-flag fallback.
  void getEmbeddingPipeline().catch(() => {})
  let claudeVersion: string | undefined
  try {
    const { execSync } = await import("child_process")
    claudeVersion = execSync("claude --version", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString().trim()
  } catch {
    claudeVersion = undefined
  }
  log.info("app.start", {
    scope: "app",
    resumeSessionId: options.resumeSessionId,
    cwd: options.cwd ?? process.cwd(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    term: process.env.TERM,
    termProgram: process.env.TERM_PROGRAM,
    bun: typeof Bun !== "undefined" ? Bun.version : undefined,
    claudeVersion,
    riteVersion: "2.0.0",
    logLevel: (await import("./utils/logger")).getLogLevel(),
  })
  const config = await loadConfig()
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 60,
    // Enable mouse button + scroll-wheel tracking so the transcript scrollbox
    // responds to the wheel, but keep enableMouseMovement OFF: all-motion
    // tracking (?1003h) is what leaked movement gibberish into the terminal,
    // and the wheel doesn't need it. opentui's native enableMouse() takes the
    // movement flag separately, and disables all mouse modes on shutdown.
    useMouse: true,
    enableMouseMovement: false,
    // Absorb async terminal capability responses so they don't leak as text
    // if they arrive after destroy() releases stdin from raw mode.
    // Covers: OSC color replies, DCS/XTVERSION, DECRPM mode reports, cursor pos.
    prependInputHandlers: [
      (seq: string) =>
        seq.startsWith("\x1b]") ||   // OSC  (color queries)
        seq.startsWith("\x9d") ||    // C1 OSC
        seq.startsWith("\x1bP") ||   // DCS  (XTVERSION: \x1bP>|iTerm2...\x1b\\)
        seq.startsWith("\x90") ||    // C1 DCS
        /^\x1b\[\?[\d;]+\$y/.test(seq) || // DECRPM mode reports (N;M$y)
        /^\x1b\[\d+;\d+R/.test(seq) ||    // cursor position reports
        /^\x1b\[4;\d+;\d+t/.test(seq),    // pixel dimension reports (\x1b[14t reply)
    ],
  })

  await render(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          log.error("render.boundary", { scope: "render", err })
          return <ErrorFallback err={err} exit={() => renderer.destroy()} />
        }}
      >
        <ExitProvider exit={() => renderer.destroy()}>
          <ThemeProvider>
            <ConfigProvider config={config}>
              <SessionStoreProvider>
                <RouteProvider initialSessionId={options.resumeSessionId}>
                  <App />
                </RouteProvider>
              </SessionStoreProvider>
            </ConfigProvider>
          </ThemeProvider>
        </ExitProvider>
      </ErrorBoundary>
    ),
    renderer,
  )
}
