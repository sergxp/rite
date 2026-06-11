import { Show, Switch, Match } from "solid-js"
import { render, useTerminalDimensions } from "@opentui/solid"
import { createCliRenderer } from "@opentui/core"
import { ThemeProvider } from "./context/theme"
import { RouteProvider, useRoute } from "./context/route"
import { ExitProvider } from "./context/exit"
import { ConfigProvider } from "./context/config"
import { SessionStoreProvider } from "./context/session-store"
import { loadConfig } from "./config/loader"
import { ensureRiteDir } from "./utils/init"
import { Home } from "./routes/home"
import { Session } from "./routes/session/index"

function App() {
  const dimensions = useTerminalDimensions()
  const route = useRoute()

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
    >
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
  const config = await loadConfig()
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
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
    ),
    renderer,
  )
}
