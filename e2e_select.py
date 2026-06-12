#!/usr/bin/env python3
"""
Text-selection → clipboard e2e.

Drives a real SGR mouse drag across a word in the transcript and asserts the
selected text reaches the clipboard (via the RITE_FAKE_CLIPBOARD seam, so the
real system clipboard is never touched). Confirms that enabling mouse tracking
for scroll did not cost us select-to-copy — opentui's own selection handles it.

Reuses the PTY harness (Screen + PTYDriver) from e2e.py.
"""
import fcntl, json, os, pty, signal, sys, termios, time
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("e2e", os.path.join(HERE, "e2e.py"))
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)

TARGET = "hello rite"          # the user message — a plain selectable <text>
FAKE = [{"type": "text", "content": "Hello! Selection works end to end."}]

failures = []
def check(name, cond):
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        failures.append(name)


def find_text(screen, needle):
    """Return (row, col) 0-based of the first cell of `needle`, or None."""
    for r, row in enumerate(screen.cells):
        line = "".join(ch for ch, _ in row)
        c = line.find(needle)
        if c >= 0:
            return r, c
    return None


def main():
    fake_backend = os.path.join(HERE, ".select-backend.jsonl")
    with open(fake_backend, "w") as f:
        for ev in FAKE:
            f.write(json.dumps(ev) + "\n")
    clip_file = os.path.join(HERE, ".select-clipboard.txt")
    if os.path.exists(clip_file):
        os.unlink(clip_file)

    master, slave = pty.openpty()
    e2e.set_winsize(slave)
    e2e.set_raw_noecho(slave)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        try: fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        except Exception: pass
        os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(slave, 2)
        os.close(master); os.close(slave)
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"; env["COLORTERM"] = "truecolor"
        env["RITE_FAKE_BACKEND"] = fake_backend
        env["RITE_FAKE_CLIPBOARD"] = clip_file
        os.execve(e2e.BUN, [e2e.BUN, e2e.RITE], env)
        os._exit(1)
    os.close(slave)
    d = e2e.PTYDriver(master)

    try:
        d.wait_idle(timeout=10.0, idle_for=1.0)
        d.send(b"\r")
        d.wait_for(lambda s: "Message" in s, timeout=6.0)
        for ch in TARGET.encode():
            d.send(bytes([ch])); time.sleep(0.02)
        d.send(b"\r")
        d.wait_for(lambda s: "end to end" in s, timeout=8.0)
        d.wait_idle(timeout=3.0, idle_for=0.6)

        # Locate the user message on screen and drag-select it.
        with d._lock:
            pos = find_text(d.screen, TARGET)
        check("select: target text located on screen", pos is not None)
        if pos is None:
            return
        r0, c0 = pos
        # 1-based mouse coords. Press at the first char; the focus cell is
        # exclusive, so drag a couple columns past the last char to include it.
        row = r0 + 1
        col_start = c0 + 1
        col_end = c0 + len(TARGET) + 2
        d.send(f"\x1b[<0;{col_start};{row}M".encode())   # left press at start
        time.sleep(0.05)
        d.send(f"\x1b[<32;{col_end};{row}M".encode())    # drag past end (button held)
        time.sleep(0.05)
        d.send(f"\x1b[<0;{col_end};{row}m".encode())     # release → finishSelection
        time.sleep(0.6)

        copied = ""
        if os.path.exists(clip_file):
            copied = open(clip_file).read()
        print(f"  [clipboard] {copied!r}")
        check("select: clipboard received the selected text", TARGET in copied)

        snap = d.snapshot()
        check("select: footer confirms the copy", "copied" in snap)

        wpid, _ = os.waitpid(pid, os.WNOHANG)
        check("select: app still running", wpid == 0)

        print()
        if failures:
            print(f"✗ SELECT E2E FAILED: {failures}")
        else:
            print("✓ Select e2e complete — all checks passed")
    finally:
        d.stop()
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
        for _ in range(20):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]: break
            except ChildProcessError: break
            time.sleep(0.1)
        else:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        try: os.close(master)
        except OSError: pass
        for p in (fake_backend, clip_file):
            try: os.unlink(p)
            except OSError: pass

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
