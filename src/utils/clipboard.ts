import { execa } from "execa"
import { writeFileSync } from "fs"

/**
 * Copy text to the system clipboard. Returns true on success, false if no
 * clipboard tool is available (so callers can surface a hint instead of
 * crashing). Tries the platform-native tool, with xclip→xsel fallback on Linux.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Test seam (mirrors RITE_FAKE_BACKEND): write to a file instead of the
  // system clipboard so e2e can assert the copied text without clobbering it.
  const fake = process.env.RITE_FAKE_CLIPBOARD
  if (fake) {
    try {
      writeFileSync(fake, text)
      return true
    } catch {
      return false
    }
  }

  try {
    if (process.platform === "darwin") {
      await execa("pbcopy", [], { input: text })
    } else if (process.platform === "win32") {
      await execa("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
      ], { input: text })
    } else {
      try {
        await execa("xclip", ["-selection", "clipboard"], { input: text })
      } catch {
        await execa("xsel", ["--clipboard", "--input"], { input: text })
      }
    }
    return true
  } catch {
    return false
  }
}
