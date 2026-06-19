import { execFile } from "child_process"
import { existsSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import os from "os"
import { promisify } from "util"
import { log } from "./logger.js"

const execFileP = promisify(execFile)

const clog = log.child("clipboard.image")

/**
 * Save the system clipboard's current image (if any) to `outPath` as PNG.
 * Returns the path on success, null when the clipboard holds no image or the
 * platform's clipboard tooling is unavailable. Never throws.
 *
 * Terminal paste events only carry text — image bytes never reach the TUI
 * via the standard paste path, so we have to shell out to a platform helper.
 */
export async function saveClipboardImage(outPath: string): Promise<string | null> {
  const dir = dirname(outPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const platform = os.platform()
  try {
    if (platform === "win32") return await saveOnWindows(outPath)
    if (platform === "darwin") return await saveOnMac(outPath)
    return await saveOnLinux(outPath)
  } catch (err) {
    clog.warn("save.failed", { platform, outPath, err })
    return null
  }
}

async function saveOnWindows(outPath: string): Promise<string | null> {
  // STA mode is required for the WPF/WinForms Clipboard APIs.
  const escaped = outPath.replace(/'/g, "''")
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $img = [System.Windows.Forms.Clipboard]::GetImage()
    if ($img -eq $null) { Write-Output 'NONE'; exit 0 }
    $img.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()
    Write-Output 'OK'
  `
  const { stdout } = await execFileP(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script],
    { timeout: 8000, windowsHide: true },
  )
  if (stdout.includes("OK") && existsSync(outPath)) {
    clog.debug("save.win.ok", { outPath })
    return outPath
  }
  clog.debug("save.win.empty", { stdout: stdout.trim() })
  return null
}

async function saveOnMac(outPath: string): Promise<string | null> {
  // Prefer pngpaste if installed; fall back to AppleScript.
  try {
    await execFileP("pngpaste", [outPath], { timeout: 8000 })
    if (existsSync(outPath)) {
      clog.debug("save.mac.pngpaste.ok", { outPath })
      return outPath
    }
  } catch {
    // try osascript next
  }
  const script = `set png to (the clipboard as «class PNGf»)
set fp to open for access POSIX file "${outPath}" with write permission
set eof of fp to 0
write png to fp
close access fp`
  try {
    await execFileP("osascript", ["-e", script], { timeout: 8000 })
    if (existsSync(outPath)) {
      clog.debug("save.mac.osascript.ok", { outPath })
      return outPath
    }
  } catch (err) {
    clog.debug("save.mac.failed", { err })
  }
  return null
}

async function saveOnLinux(outPath: string): Promise<string | null> {
  const isWayland = !!process.env.WAYLAND_DISPLAY
  const tools: Array<{ cmd: string; args: string[] }> = isWayland
    ? [{ cmd: "wl-paste", args: ["--type", "image/png"] }]
    : [
        { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
        { cmd: "wl-paste", args: ["--type", "image/png"] },
      ]

  for (const tool of tools) {
    try {
      const { stdout } = await execFileP(tool.cmd, tool.args, {
        timeout: 8000,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
      })
      const buf = stdout as unknown as Buffer
      if (buf && buf.length > 0) {
        const { writeFileSync } = await import("fs")
        writeFileSync(outPath, buf)
        clog.debug("save.linux.ok", { tool: tool.cmd, outPath, bytes: buf.length })
        return outPath
      }
    } catch {
      // try next tool
    }
  }
  return null
}

/** Build the per-session storage path for a fresh paste. */
export function nextAttachmentImagePath(sessionId: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)
  const rand = Math.random().toString(36).slice(2, 6)
  return join(os.homedir(), ".rite", "attachments", "images", sessionId, `${stamp}-${rand}.png`)
}
