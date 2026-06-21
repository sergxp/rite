import { SyntaxStyle } from "@opentui/core"
import { createSimpleContext } from "./helper"

export interface Theme {
  border: string
  text: string | undefined
  textMuted: string
  textDim: string
  primary: string
  success: string
  warning: string
  error: string
  info: string
  userMsg: string | undefined
  assistantMsg: string | undefined
  toolName: string
  toolOutput: string
  syntaxStyle: SyntaxStyle
}

// Styles for the markdown markup groups the <markdown> renderer emits. Without
// these, SyntaxStyle.create() is empty: markers get concealed but emphasis
// (bold, inline code, headings, links) falls back to plain text — which is why
// assistant responses read flat. Registering these restores visual emphasis,
// using the system-tone palette so it stays terminal-native.
// Pure white is reserved for emphasis (bold) so it stands out from the
// off-white body text set in makeTheme().
function makeMarkdownStyle(): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    "markup.heading": { fg: "cyan", bold: true },
    "markup.strong": { fg: "white", bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { dim: true },
    "markup.raw": { fg: "#5f87af" },             // inline code + code fences
    "markup.link": { fg: "cyan", underline: true },
    "markup.link.label": { fg: "cyan" },
    "markup.link.url": { fg: "cyan", underline: true },
    "markup.list": { fg: "cyan" },               // list bullets / numbers
    "markup.quote": { fg: "gray", italic: true },
  })
}

function makeTheme(): Theme {
  // Off-white body text — pure white is reserved for emphasis (bold, highlights).
  const offWhite = "#c8c8c8"
  return {
    border: "gray",
    text: offWhite,
    textMuted: "gray",
    textDim: "gray",
    primary: "cyan",
    success: "brightGreen",
    warning: "yellow",
    error: "red",
    info: "cyan",
    userMsg: offWhite,
    assistantMsg: offWhite,
    toolName: "cyan",
    toolOutput: "gray",
    syntaxStyle: makeMarkdownStyle(),
  }
}

export const {
  use: useTheme,
  provider: ThemeProvider,
} = createSimpleContext({
  name: "Theme",
  init: makeTheme,
})
