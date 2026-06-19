import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { afterEach, describe, expect, it } from "vitest"
import {
  ensureRiteTabIcon,
  formatTerminalTitle,
  installWindowsTerminalProfileIcon,
  tabStatusSequence,
  writeTerminalBell,
  writeTerminalTabStatus,
  writeTerminalTitle,
  writeWindowsTerminalProgress,
  windowsTerminalSettingsPathCandidates,
} from "../../src/utils/terminal"

const originalWtSession = process.env.WT_SESSION
const originalWtProfileId = process.env.WT_PROFILE_ID
const originalLocalAppData = process.env.LOCALAPPDATA

afterEach(() => {
  if (originalWtSession === undefined) delete process.env.WT_SESSION
  else process.env.WT_SESSION = originalWtSession
  if (originalWtProfileId === undefined) delete process.env.WT_PROFILE_ID
  else process.env.WT_PROFILE_ID = originalWtProfileId
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = originalLocalAppData
})

describe("terminal integration helpers", () => {
  it("formats task state into terminal tab title badges", () => {
    expect(formatTerminalTitle("Build", "idle")).toBe("✦ Build")
    expect(formatTerminalTitle("Build", "running", "✧")).toBe("✧ Build")
    expect(formatTerminalTitle("Build", "complete")).toBe("✓ Build")
  })

  it("uses a Rite-specific title mark, not Claude Code's mark", async () => {
    const terminal = await import("../../src/utils/terminal")

    expect(terminal.RITE_TITLE_STATIC_PREFIX).toBe("✦")
    expect(terminal.RITE_TITLE_STATIC_PREFIX).not.toBe("✳")
    expect(terminal.RITE_TITLE_ANIMATION_FRAMES).toEqual(["✧", "✦"])
  })

  it("sanitizes OSC title content", () => {
    const writes: string[] = []
    const originalTitle = process.title

    try {
      writeTerminalTitle("hello\x1b]0;pwn\x07world", (chunk) => writes.push(chunk))

      if (process.platform === "win32") {
        expect(writes).toEqual([])
        expect(process.title).toBe("hello]0;pwnworld")
      } else {
        expect(writes).toEqual(["\x1b]2;hello]0;pwnworld\x07"])
      }
    } finally {
      process.title = originalTitle
    }
  })

  it("writes a terminal bell for completion alerts", () => {
    const writes: string[] = []

    writeTerminalBell((chunk) => writes.push(chunk))

    expect(writes).toEqual(["\x07"])
  })

  it("emits Claude Code-style OSC 21337 tab status sequences", () => {
    expect(tabStatusSequence("idle")).toBe("\x1b]21337;indicator=#00d75f;status=Idle;status-color=#888888\x07")
    expect(tabStatusSequence("busy")).toBe("\x1b]21337;indicator=#ff9500;status=Working…;status-color=#ff9500\x07")
    expect(tabStatusSequence("complete")).toBe("\x1b]21337;indicator=#00d75f;status=Done;status-color=#00d75f\x07")
    expect(tabStatusSequence(null)).toBe("\x1b]21337;indicator=;status=;status-color=\x07")
  })

  it("wraps tab status for tmux passthrough like Claude Code", () => {
    const writes: string[] = []
    const originalTmux = process.env.TMUX
    process.env.TMUX = "/tmp/tmux-1000/default,123,0"

    try {
      writeTerminalTabStatus("busy", (chunk) => writes.push(chunk))
      expect(writes[0]).toBe("\x1bPtmux;\x1b\x1b]21337;indicator=#ff9500;status=Working…;status-color=#ff9500\x07\x1b\\")
    } finally {
      if (originalTmux === undefined) delete process.env.TMUX
      else process.env.TMUX = originalTmux
    }
  })

  it("gates Windows Terminal progress OSC sequences behind WT_SESSION", () => {
    const writes: string[] = []
    delete process.env.WT_SESSION

    writeWindowsTerminalProgress("indeterminate", 0, (chunk) => writes.push(chunk))
    expect(writes).toEqual([])

    process.env.WT_SESSION = "test-session"
    writeWindowsTerminalProgress("indeterminate", 0, (chunk) => writes.push(chunk))
    writeWindowsTerminalProgress("normal", 100, (chunk) => writes.push(chunk))
    writeWindowsTerminalProgress("none", 0, (chunk) => writes.push(chunk))

    expect(writes).toEqual([
      "\x1b]9;4;3;0\x07",
      "\x1b]9;4;1;100\x07",
      "\x1b]9;4;0;0\x07",
    ])
  })

  it("generates a local png file for the Windows Terminal tab favicon", () => {
    const dir = mkdtempSync(join(tmpdir(), "rite-terminal-"))
    const iconPath = join(dir, "rite-tab.png")

    try {
      expect(ensureRiteTabIcon(iconPath)).toBe(iconPath)
      const bytes = readFileSync(iconPath)
      expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR")
      expect(bytes.readUInt32BE(16)).toBe(32)
      expect(bytes.readUInt32BE(20)).toBe(32)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("discovers documented Windows Terminal settings paths", () => {
    const root = "C:\\Users\\Test\\AppData\\Local"

    expect(windowsTerminalSettingsPathCandidates({ LOCALAPPDATA: root })).toEqual([
      join(root, "Packages", "Microsoft.WindowsTerminal_8wekyb3d8bbwe", "LocalState", "settings.json"),
      join(root, "Packages", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe", "LocalState", "settings.json"),
      join(root, "Packages", "Microsoft.WindowsTerminalCanary_8wekyb3d8bbwe", "LocalState", "settings.json"),
      join(root, "Microsoft", "Windows Terminal", "settings.json"),
    ])
  })

  it("sets the documented Windows Terminal profile icon setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "rite-terminal-"))
    const settingsPath = join(dir, "settings.json")
    const iconPath = join(dir, "rite-tab.png")
    process.env.WT_PROFILE_ID = "{profile-1}"
    writeFileSync(settingsPath, `{
      // Windows Terminal settings are JSONC.
      "profiles": {
        "list": [
          { "guid": "{profile-1}", "name": "PowerShell" },
          { "guid": "{profile-2}", "name": "Command Prompt" }
        ]
      }
    }`)

    try {
      const result = installWindowsTerminalProfileIcon({ settingsPath, iconPath })
      const updated = JSON.parse(readFileSync(settingsPath, "utf-8"))

      expect(result).toMatchObject({
        settingsPath,
        profileId: "{profile-1}",
        iconPath,
        changed: true,
      })
      expect(updated.profiles.list[0].icon).toBe(iconPath)
      expect(updated.profiles.list[1].icon).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
