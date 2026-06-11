import { Show, Switch, Match } from "solid-js"
import { render, useTerminalDimensions } from "@opentui/solid"
import { createCliRenderer } from "@opentui/core"
import { ThemeProvider, useTheme } from "./context/theme"
import { RouteProvider, useRoute } from "./context/route"
import { ExitProvider } from "./context/exit"
import { SessionStoreProvider } from "./context/session-store"
import { Home } from "./routes/home"
import { Session } from "./routes/session/index"

function App() {
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const route = useRoute()

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
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
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: true,
    clearOnShutdown: true,
    targetFps: 60,
  })

  await render(
    () => (
      <ExitProvider exit={() => renderer.destroy()}>
        <ThemeProvider>
          <SessionStoreProvider>
            <RouteProvider initialSessionId={options.resumeSessionId}>
              <App />
            </RouteProvider>
          </SessionStoreProvider>
        </ThemeProvider>
      </ExitProvider>
    ),
    renderer,
  )
}
