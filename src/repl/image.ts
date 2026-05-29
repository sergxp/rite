import { execFileSync } from "child_process";
export type { ImageAttachment } from "../backends/events.js";
import type { ImageAttachment } from "../backends/events.js";

/** Read an image from the system clipboard.
 *  Returns null if clipboard has no image or on unsupported platforms. */
export function readImageFromClipboard(): ImageAttachment | null {
  if (process.platform === "win32") return readClipboardWindows();
  if (process.platform === "darwin") return readClipboardMac();
  return null;
}

function readClipboardWindows(): ImageAttachment | null {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$img = [System.Windows.Forms.Clipboard]::GetImage()",
    "if ($img -eq $null) { exit 1 }",
    "$stream = New-Object System.IO.MemoryStream",
    "$img.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)",
    "$bytes = $stream.ToArray()",
    "$stream.Dispose(); $img.Dispose()",
    "[Convert]::ToBase64String($bytes)",
  ].join("; ");

  try {
    const result = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const base64 = result.toString().trim();
    if (!base64) return null;
    return { base64, mediaType: "image/png", label: "clipboard.png" };
  } catch {
    return null;
  }
}

function readClipboardMac(): ImageAttachment | null {
  try {
    // pngpaste writes clipboard image to stdout as base64 when given -
    // Fallback: use osascript
    const result = execFileSync(
      "osascript",
      ["-e", 'set img to (the clipboard as «class PNGf»)', "-e", "return base64 encoded (img as string)"],
      { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const base64 = result.toString().trim();
    if (!base64) return null;
    return { base64, mediaType: "image/png", label: "clipboard.png" };
  } catch {
    return null;
  }
}
