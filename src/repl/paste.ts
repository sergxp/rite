/**
 * Bracketed paste mode support.
 *
 * Ink reads stdin via `stdin.read()` in a 'readable' event handler — NOT via
 * 'data' events. We therefore patch `stdin.read()` so Ink never sees the paste
 * escape bytes. The full paste content lands in one `_onPaste` call instead.
 *
 * Terminal bracketed paste wraps pasted content as:
 *   \x1b[200~ ... pasted text ... \x1b[201~
 */

type ReadFn = typeof process.stdin.read;

let _onPaste: ((text: string) => void) | null = null;
let _installed = false;
let _originalRead: ReadFn | null = null;

// Accumulates paste content when the bracketed sequence spans multiple reads.
let _pasteBuffer = "";
let _isPasting = false;

export function setPasteHandler(fn: (text: string) => void): void {
  _onPaste = fn;
}

export function installBracketedPaste(): void {
  if (_installed) return;
  _installed = true;

  process.stdout.write("\x1b[?2004h"); // ask terminal to bracket pastes

  _originalRead = process.stdin.read.bind(process.stdin) as ReadFn;
  const orig = _originalRead;

  (process.stdin as NodeJS.ReadStream).read = function (size?: number): string | Buffer | null {
    const raw = orig(size);
    if (raw === null) return null;

    // Ink sets encoding to 'utf8' before reading, so chunks are strings.
    const chunk: string = typeof raw === "string" ? raw : (raw as Buffer).toString("utf8");

    return filterPaste(chunk);
  } as ReadFn;
}

export function uninstallBracketedPaste(): void {
  if (!_installed) return;
  process.stdout.write("\x1b[?2004l");
  if (_originalRead) {
    (process.stdin as NodeJS.ReadStream).read = _originalRead as ReadFn;
    _originalRead = null;
  }
  _isPasting = false;
  _pasteBuffer = "";
  _installed = false;
}

/**
 * Strip bracketed paste sequences from a chunk, calling _onPaste when the
 * closing bracket is seen. Returns the non-paste remainder (may be empty string).
 * Empty string is safe to return — Ink's input loop treats it as no-op input.
 */
function filterPaste(chunk: string): string {
  let out = "";

  if (!_isPasting) {
    const startIdx = chunk.indexOf("\x1b[200~");
    if (startIdx === -1) {
      // No paste in this chunk — pass through unchanged.
      return chunk;
    }

    // Keep any text that arrived before the paste start (e.g. a typed char and
    // then an immediate paste in the same read — unlikely but possible).
    out = chunk.slice(0, startIdx);

    const afterStart = chunk.slice(startIdx + 6); // skip \x1b[200~
    const endIdx = afterStart.indexOf("\x1b[201~");

    if (endIdx !== -1) {
      // Entire paste arrived in one chunk.
      _onPaste?.(afterStart.slice(0, endIdx));
      // Anything after \x1b[201~ (very unusual) is also non-paste content.
      out += afterStart.slice(endIdx + 6);
    } else {
      _isPasting = true;
      _pasteBuffer = afterStart;
    }
  } else {
    // We're mid-paste — accumulate until closing bracket.
    const endIdx = chunk.indexOf("\x1b[201~");
    if (endIdx !== -1) {
      _pasteBuffer += chunk.slice(0, endIdx);
      _isPasting = false;
      _onPaste?.(_pasteBuffer);
      _pasteBuffer = "";
      out = chunk.slice(endIdx + 6);
    } else {
      _pasteBuffer += chunk;
      // Return empty string — Ink gets nothing to process this tick.
    }
  }

  // Return empty string rather than null so Ink's read-loop continues normally
  // (null would stop the while-loop prematurely if more data is queued).
  return out || "";
}
