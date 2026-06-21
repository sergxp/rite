import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import os from "os"
import { deflateSync } from "zlib"

type Writer = (chunk: string) => void

export type TaskbarProgressState = "none" | "normal" | "error" | "indeterminate" | "warning"
export type TerminalTaskState = "idle" | "running" | "complete"
export type TerminalTabStatusKind = "idle" | "busy" | "complete" | null

const PROGRESS_STATE_CODE: Record<TaskbarProgressState, number> = {
  none: 0,
  normal: 1,
  error: 2,
  indeterminate: 3,
  warning: 4,
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const RITE_TITLE_STATIC_PREFIX = "✦"
export const RITE_TITLE_ANIMATION_FRAMES = ["✧", "✦"]

function safeOscText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f\x9b]/g, "").trim()
}

export function formatTerminalTitle(sessionName: string, state: TerminalTaskState, spinnerFrame = SPINNER_FRAMES[0]): string {
  const safeName = safeOscText(sessionName) || "Rite"
  if (state === "running") return `${spinnerFrame} ${safeName}`
  if (state === "complete") return `✓ ${safeName}`
  return `${RITE_TITLE_STATIC_PREFIX} ${safeName}`
}

export function writeTerminalTitle(title: string, writer: Writer = process.stdout.write.bind(process.stdout)): void {
  if (process.platform === "win32") {
    process.title = safeOscText(title)
    return
  }
  writer(`\x1b]2;${safeOscText(title)}\x07`)
}

// Terminal focus tracking via focus-reporting mode (\x1b[?1004h).
// When enabled, the terminal sends \x1b[I on focus-in and \x1b[O on focus-out.
// We default to "focused" (true) so the bell is suppressed until we get a
// definitive focus-out event — better to miss a bell than to spam one.
let _terminalFocused = true

export function isTerminalFocused(): boolean {
  return _terminalFocused
}

// Call this with each raw input sequence from the terminal. Returns true if
// the sequence was a focus event (caller should suppress it from further input
// handling), false otherwise.
export function handleFocusSequence(seq: string): boolean {
  if (seq === "\x1b[I") { _terminalFocused = true; return true }
  if (seq === "\x1b[O") { _terminalFocused = false; return true }
  return false
}

// The escape sequence to enable focus reporting. Write this to stdout at
// startup and disable it (\x1b[?1004l) on shutdown.
export const FOCUS_REPORTING_ENABLE  = "\x1b[?1004h"
export const FOCUS_REPORTING_DISABLE = "\x1b[?1004l"

export function writeTerminalBell(writer: Writer = process.stdout.write.bind(process.stdout)): void {
  writer("\x07")
}

/**
 * Pretty-print a tool name for status display.
 * MCP tools arrive as "mcp__server__method" — converts to "server › method".
 * Regular tool names are returned as-is.
 */
export function formatToolName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.slice(5).split("__")
    if (parts.length >= 2) return `${parts[0]} › ${parts.slice(1).join("__")}`
  }
  return name
}

export function supportsWindowsTerminalIntegration(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.WT_SESSION
}

export function writeWindowsTerminalProgress(
  state: TaskbarProgressState,
  value = 0,
  writer: Writer = process.stdout.write.bind(process.stdout),
): void {
  if (!supportsWindowsTerminalIntegration()) return
  const progress = Math.max(0, Math.min(100, Math.round(value)))
  writer(`\x1b]9;4;${PROGRESS_STATE_CODE[state]};${progress}\x07`)
}

export function writeTerminalTabStatus(
  kind: TerminalTabStatusKind,
  writer: Writer = process.stdout.write.bind(process.stdout),
): void {
  writer(wrapForMultiplexer(tabStatusSequence(kind)))
}

export function tabStatusSequence(kind: TerminalTabStatusKind): string {
  if (kind === null) return "\x1b]21337;indicator=;status=;status-color=\x07"
  if (kind === "busy") {
    return "\x1b]21337;indicator=#ff9500;status=Working…;status-color=#ff9500\x07"
  }
  if (kind === "complete") {
    return "\x1b]21337;indicator=#00d75f;status=Done;status-color=#00d75f\x07"
  }
  return "\x1b]21337;indicator=#00d75f;status=Idle;status-color=#888888\x07"
}

function wrapForMultiplexer(sequence: string): string {
  if (process.env.TMUX) {
    return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`
  }
  if (process.env.STY) {
    return `\x1bP${sequence}\x1b\\`
  }
  return sequence
}

export function riteTabIconPath(): string {
  return join(os.homedir(), ".rite", "assets", "rite-tab.png")
}

export function ensureRiteTabIcon(filePath = riteTabIconPath()): string {
  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, createRitePng())
  }
  return filePath
}

export interface WindowsTerminalIconSetupResult {
  settingsPath: string
  profileId: string
  iconPath: string
  changed: boolean
}

export function windowsTerminalSettingsPathCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) return []
  return [
    join(localAppData, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(localAppData, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(localAppData, "Packages", "Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe", "LocalState", "settings.json"),
    join(localAppData, "Microsoft", "Windows Terminal", "settings.json"),
  ]
}

export function findWindowsTerminalSettingsPath(
  candidates = windowsTerminalSettingsPathCandidates(),
): string | null {
  return candidates.find((path) => existsSync(path)) ?? null
}

export function installWindowsTerminalProfileIcon(options: {
  settingsPath?: string
  profileId?: string
  iconPath?: string
} = {}): WindowsTerminalIconSetupResult {
  const settingsPath = options.settingsPath ?? findWindowsTerminalSettingsPath()
  if (!settingsPath) {
    throw new Error("Windows Terminal settings.json not found.")
  }

  const profileId = options.profileId ?? process.env.WT_PROFILE_ID
  if (!profileId) {
    throw new Error("WT_PROFILE_ID is not set. Run this from inside the Windows Terminal profile you want to update, or pass --profile <guid>.")
  }

  const iconPath = ensureRiteTabIcon(options.iconPath)
  const raw = readFileSync(settingsPath, "utf-8")
  const settings = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>
  const profiles = settings.profiles as { list?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined
  const list = Array.isArray(profiles) ? profiles : profiles?.list
  if (!Array.isArray(list)) {
    throw new Error("Windows Terminal settings.json does not contain profiles.list.")
  }

  const target = list.find((profile) => String(profile.guid ?? "").toLowerCase() === profileId.toLowerCase())
  if (!target) {
    throw new Error(`Windows Terminal profile not found: ${profileId}`)
  }

  const changed = target.icon !== iconPath
  if (changed) {
    target.icon = iconPath
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
  }

  return { settingsPath, profileId, iconPath, changed }
}

function stripJsonComments(raw: string): string {
  let out = ""
  let inString = false
  let escaped = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    const next = raw[i + 1]

    if (inLineComment) {
      if (c === "\n" || c === "\r") {
        inLineComment = false
        out += c
      }
      continue
    }

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false
        i++
      } else if (c === "\n" || c === "\r") {
        out += c
      }
      continue
    }

    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === "\"") inString = false
      continue
    }

    if (c === "\"") {
      inString = true
      out += c
      continue
    }

    if (c === "/" && next === "/") {
      inLineComment = true
      i++
      continue
    }

    if (c === "/" && next === "*") {
      inBlockComment = true
      i++
      continue
    }

    out += c
  }

  return out
}

function createRitePng(): Buffer {
  const size = 32
  const rows = Buffer.alloc((size * 4 + 1) * size)
  let o = 0

  for (let y = 0; y < size; y++) {
    rows[o++] = 0
    for (let x = 0; x < size; x++) {
      const border = x < 2 || y < 2 || x >= size - 2 || y >= size - 2
      const inRStem = x >= 8 && x <= 12 && y >= 7 && y <= 24
      const inRTop = x >= 8 && x <= 22 && y >= 7 && y <= 11
      const inRBowl = x >= 19 && x <= 23 && y >= 10 && y <= 16
      const inRMid = x >= 8 && x <= 21 && y >= 15 && y <= 18
      const inRLeg = y - x >= -7 && y - x <= -3 && x >= 14 && x <= 24 && y >= 17 && y <= 26
      const mark = inRStem || inRTop || inRBowl || inRMid || inRLeg
      const r = mark ? 245 : border ? 16 : 22
      const g = mark ? 255 : border ? 185 : 135
      const b = mark ? 255 : border ? 129 : 245
      rows[o++] = r
      rows[o++] = g
      rows[o++] = b
      rows[o++] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii")
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
