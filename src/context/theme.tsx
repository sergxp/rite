import { SyntaxStyle } from "@opentui/core"
import { createSimpleContext } from "./helper"

export interface Theme {
  background: string
  surface: string
  border: string
  text: string
  textMuted: string
  textDim: string
  primary: string
  success: string
  warning: string
  error: string
  info: string
  userMsg: string
  assistantMsg: string
  toolName: string
  toolOutput: string
  syntaxStyle: SyntaxStyle
}

function makeDarkTheme(): Theme {
  return {
    background: "#1a1b26",
    surface: "#24283b",
    border: "#3d4466",
    text: "#a9b1d6",
    textMuted: "#565f89",
    textDim: "#414868",
    primary: "#7aa2f7",
    success: "#9ece6a",
    warning: "#e0af68",
    error: "#f7768e",
    info: "#2ac3de",
    userMsg: "#c0caf5",
    assistantMsg: "#a9b1d6",
    toolName: "#7dcfff",
    toolOutput: "#565f89",
    syntaxStyle: SyntaxStyle.create(),
  }
}

export const {
  use: useTheme,
  provider: ThemeProvider,
} = createSimpleContext({
  name: "Theme",
  init: makeDarkTheme,
})
