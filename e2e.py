#!/usr/bin/env python3
"""
E2E test for Rite v2.

Spawns the TUI in a real PTY, acts as a mock terminal (responds to @opentui's
capability queries, tracks cursor position honestly, maintains a screen
buffer), then drives keyboard interaction and prints rendered screenshots.
"""
import fcntl, json, os, pty, re, select, signal, struct, sys, termios, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
RITE = os.path.join(HERE, "dist/index.js")
BUN  = os.path.expanduser("~/.bun/bin/bun")
WIDTH, HEIGHT = 120, 40

# Scripted agent turn replayed by the RITE_FAKE_BACKEND seam: one JSON
# BackendEvent per line. Exercises session capture, thinking, tools, and text.
FAKE_SCRIPT = [
    {"type": "session_id", "sessionId": "fake-cli-session-1"},
    {"type": "thinking", "content": "The user greeted me. I should reply."},
    {"type": "tool_call", "name": "Bash", "id": "t1"},
    {"type": "tool_done", "name": "Bash", "id": "t1", "inputJson": json.dumps({"command": "echo hi"})},
    {"type": "tool_result", "id": "t1", "result": "hi\n", "isError": False},
    {"type": "text", "content": "Hello! I ran a command and "},
    {"type": "text", "content": "everything works."},
]
CELL_W, CELL_H = 8, 16


def set_winsize(fd: int):
    fcntl.ioctl(fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", HEIGHT, WIDTH, WIDTH * CELL_W, HEIGHT * CELL_H))


def set_raw_noecho(fd: int):
    """Raw mode + echo off so the app's output isn't fed back as input."""
    attr = termios.tcgetattr(fd)
    attr[0] &= ~(termios.IGNBRK | termios.BRKINT | termios.PARMRK |
                 termios.ISTRIP | termios.INLCR | termios.IGNCR |
                 termios.ICRNL | termios.IXON)
    attr[1] &= ~termios.OPOST
    attr[2] &= ~(termios.CSIZE | termios.PARENB)
    attr[2] |= termios.CS8
    attr[3] &= ~(termios.ECHO | termios.ECHOE | termios.ECHOK |
                 termios.ECHONL | termios.ICANON | termios.ISIG |
                 termios.IEXTEN)
    attr[6][termios.VMIN] = 1
    attr[6][termios.VTIME] = 0
    termios.tcsetattr(fd, termios.TCSANOW, attr)


class Screen:
    """Minimal terminal emulator: cursor tracking, screen buffer, fg colors,
    and replies for the capability queries @opentui actually waits on."""

    CSI = re.compile(rb'\x1b\[([\x20-\x3f]*)([\x40-\x7e])')
    OSC = re.compile(rb'\x1b\]([^\x07\x1b]*)(\x07|\x1b\\)')
    DCS = re.compile(rb'\x1bP.*?\x1b\\', re.DOTALL)
    APC = re.compile(rb'\x1b_.*?\x1b\\', re.DOTALL)

    def __init__(self):
        self.row, self.col = 1, 1
        self.saved = (1, 1)
        self.fg = None  # current SGR truecolor fg as (r,g,b) or None
        self.cells = [[(" ", None)] * WIDTH for _ in range(HEIGHT)]

    def _put(self, ch: str):
        if 1 <= self.row <= HEIGHT and 1 <= self.col <= WIDTH:
            self.cells[self.row - 1][self.col - 1] = (ch, self.fg)
        self.col += 1

    def feed(self, data: bytes):
        """Consume app output; returns (replies, leftover_partial_bytes)."""
        replies = []
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 0x1b:
                rest = data[i:]
                if len(rest) == 1:
                    return replies, rest  # lone ESC at end — wait for more
                kind = rest[1]
                if kind == ord('['):
                    m = self.CSI.match(rest)
                    if not m:
                        return replies, rest
                    params, final = m.group(1), m.group(2)
                    if final == b'n' and params == b'6':
                        replies.append(f'\x1b[{self.row};{self.col}R'.encode())
                    elif final == b'H' or final == b'f':
                        p = params.split(b';')
                        self.row = int(p[0]) if p and p[0].isdigit() else 1
                        self.col = int(p[1]) if len(p) > 1 and p[1].isdigit() else 1
                    elif final == b's':
                        self.saved = (self.row, self.col)
                    elif final == b'u' and not params:
                        self.row, self.col = self.saved
                    elif final == b'm':
                        self._sgr(params)
                    elif final == b'J' and params in (b'', b'0', b'2'):
                        start = 0 if params == b'2' else self.row - 1
                        for r in range(start, HEIGHT):
                            self.cells[r] = [(" ", None)] * WIDTH
                    elif final == b'K':
                        r = self.row - 1
                        if 0 <= r < HEIGHT:
                            for c in range(self.col - 1, WIDTH):
                                self.cells[r][c] = (" ", None)
                    elif final == b't' and params == b'14':
                        replies.append(f'\x1b[4;{HEIGHT*CELL_H};{WIDTH*CELL_W}t'.encode())
                    i += m.end()
                    continue
                elif kind == ord(']'):
                    m = self.OSC.match(rest)
                    if not m:
                        return replies, rest
                    body = m.group(1)
                    # OSC 66 (text sizing) draws its payload at the cursor
                    if body.startswith(b'66;'):
                        payload = body.split(b';', 2)[2] if body.count(b';') >= 2 else b''
                        for ch in payload.decode('utf-8', 'replace'):
                            self._put(ch)
                    i += m.end()
                    continue
                elif kind in (ord('P'), ord('_')):
                    m = (self.DCS if kind == ord('P') else self.APC).match(rest)
                    if not m:
                        return replies, rest
                    i += m.end()
                    continue
                else:
                    i += 2
                    continue
            elif b == 0x0d:
                self.col = 1
                i += 1
            elif b == 0x0a:
                self.row += 1
                i += 1
            elif b < 0x20 or b == 0x7f:
                i += 1
            else:
                # decode one UTF-8 char
                size = 1
                if b >= 0xf0: size = 4
                elif b >= 0xe0: size = 3
                elif b >= 0xc0: size = 2
                if i + size > n:
                    return replies, data[i:]
                self._put(data[i:i+size].decode('utf-8', 'replace'))
                i += size
        return replies, b''

    def _sgr(self, params: bytes):
        parts = [p for p in params.split(b';')]
        j = 0
        while j < len(parts):
            p = parts[j]
            if p in (b'', b'0'):
                self.fg = None
            elif p == b'38' and j + 4 < len(parts) and parts[j+1] == b'2':
                self.fg = (int(parts[j+2] or 0), int(parts[j+3] or 0), int(parts[j+4] or 0))
                j += 5
                continue
            elif p == b'39':
                self.fg = None
            j += 1

    def text(self) -> str:
        lines = ["".join(ch for ch, _ in row).rstrip() for row in self.cells]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines)

    def colors_used(self) -> dict:
        """Map of fg color -> sample text, for verifying the palette."""
        out = {}
        for row in self.cells:
            for ch, fg in row:
                if fg and ch.strip():
                    out.setdefault(fg, "")
                    if len(out[fg]) < 40:
                        out[fg] += ch
        return out


class PTYDriver:
    """Single thread owns the master fd — reads output, replies to queries,
    writes queued keyboard input."""

    def __init__(self, master: int):
        self.master = master
        self.screen = Screen()
        self._partial = b""
        self._lock = threading.Lock()
        self._pending_input = []
        self._activity = time.monotonic()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            with self._lock:
                want_write = bool(self._pending_input)
            r, w, _ = select.select([self.master], [self.master] if want_write else [], [], 0.05)
            if r:
                try:
                    chunk = os.read(self.master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                with self._lock:
                    replies, self._partial = self.screen.feed(self._partial + chunk)
                    self._activity = time.monotonic()
                for rep in replies:
                    try:
                        os.write(self.master, rep)
                    except OSError:
                        break
            if w:
                with self._lock:
                    data = self._pending_input.pop(0) if self._pending_input else None
                if data is not None:
                    try:
                        os.write(self.master, data)
                    except OSError:
                        break

    def send(self, data: bytes):
        with self._lock:
            self._pending_input.append(data)

    def wait_for(self, predicate, timeout: float = 8.0) -> bool:
        """Wait until predicate(screen_text) is true."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate(self.snapshot()):
                return True
            time.sleep(0.05)
        return False

    def wait_idle(self, timeout: float = 8.0, idle_for: float = 0.5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            time.sleep(0.05)
            with self._lock:
                idle = time.monotonic() - self._activity
            if idle >= idle_for:
                return
        # timed out waiting for quiet — proceed with whatever we have

    def snapshot(self) -> str:
        with self._lock:
            return self.screen.text()

    def colors(self) -> dict:
        with self._lock:
            return self.screen.colors_used()

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=1)


def hr(label: str):
    print(f"\n┌─ {label} " + "─" * max(0, WIDTH - len(label) - 3))


def print_frame(text: str):
    for line in text.splitlines():
        print("│" + line)
    print("└" + "─" * WIDTH)


def main():
    fake_script_path = os.path.join(HERE, ".e2e-fake-backend.jsonl")
    with open(fake_script_path, "w") as f:
        for ev in FAKE_SCRIPT:
            f.write(json.dumps(ev) + "\n")

    master, slave = pty.openpty()
    set_winsize(slave)
    set_raw_noecho(slave)
    err_r, err_w = os.pipe()

    pid = os.fork()
    if pid == 0:
        os.setsid()
        try:
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        except Exception:
            pass
        os.dup2(slave, 0); os.dup2(slave, 1); os.dup2(err_w, 2)
        for fd in (master, slave, err_r, err_w):
            try: os.close(fd)
            except Exception: pass
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["RITE_FAKE_BACKEND"] = fake_script_path
        os.execve(BUN, [BUN, RITE], env)
        os._exit(1)

    os.close(slave)
    os.close(err_w)
    driver = PTYDriver(master)
    failures = []

    def check(name: str, cond: bool):
        print(("  ✓ " if cond else "  ✗ ") + name)
        if not cond:
            failures.append(name)

    try:
        # ── Home screen ──────────────────────────────────────────────────────
        driver.wait_idle(timeout=10.0, idle_for=1.0)
        home = driver.snapshot()
        hr("HOME SCREEN")
        print_frame(home)
        check("home: shows Rite title", "Rite" in home)
        check("home: shows new-session row", "New session" in home)
        check("home: shows key hints", "navigate" in home)

        # ── Enter → new session ──────────────────────────────────────────────
        driver.send(b"\r")
        navigated = driver.wait_for(lambda s: "New session" not in s, timeout=8.0)
        driver.wait_idle(timeout=3.0, idle_for=0.6)
        sess = driver.snapshot()
        hr("SESSION (after Enter)")
        print_frame(sess)
        check("session: left home screen", navigated)
        check("session: shows composer hint or footer", "q back" in sess)

        # ── Type into composer ───────────────────────────────────────────────
        for ch in b"hello rite":
            driver.send(bytes([ch]))
            time.sleep(0.03)
        driver.wait_idle(timeout=4.0, idle_for=0.6)
        typed = driver.snapshot()
        check("composer: shows typed text", "hello rite" in typed)

        # ── Send → scripted agent turn (thinking, tool, text) ────────────────
        driver.send(b"\r")
        done = driver.wait_for(lambda s: "everything works" in s, timeout=10.0)
        driver.wait_idle(timeout=3.0, idle_for=0.6)
        turn = driver.snapshot()
        hr("AGENT TURN (scripted backend)")
        print_frame(turn)
        check("turn: user message echoed", "hello rite" in turn)
        check("turn: assistant text rendered", done)
        check("turn: tool call rendered", "Bash" in turn)
        check("turn: thinking indicator rendered", "thought" in turn)
        check("turn: footer counts 2 turns", "2 turns" in turn)
        # speaker labels on their own lines: "you" heads the user message,
        # "Rite" heads the assistant run (thinking/tool/text grouped under it).
        turn_lines = [ln.strip() for ln in turn.splitlines()]
        check("format: 'you' is a standalone label line", "you" in turn_lines)
        check("format: 'Rite' is a standalone label line", "Rite" in turn_lines)
        check(
            "format: Rite label sits below the user turn",
            "Rite" in turn_lines and "hello rite" in turn_lines
            and turn_lines.index("Rite") > turn_lines.index("hello rite"),
        )

        # ── Autocomplete: suggestion list + arrow nav + completion ───────────
        for ch in b"/c":
            driver.send(bytes([ch]))
            time.sleep(0.04)
        driver.wait_for(lambda s: "/compact" in s, timeout=4.0)
        driver.wait_idle(timeout=2.0, idle_for=0.4)
        ac = driver.snapshot()
        hr("AUTOCOMPLETE (typed '/c')")
        print_frame(ac)
        check("autocomplete: lists /clear", "/clear" in ac)
        check("autocomplete: lists /copy", "/copy" in ac)
        check("autocomplete: lists /compact", "/compact" in ac)
        check("autocomplete: first suggestion highlighted", "▶ /clear" in ac)

        driver.send(b"\x1b[B")  # down arrow → move highlight to /copy
        driver.wait_for(lambda s: "▶ /copy" in s, timeout=3.0)
        ac2 = driver.snapshot()
        check("autocomplete: arrow moves highlight", "▶ /copy" in ac2)

        driver.send(b"\t")  # Tab → complete to highlighted /copy, list collapses
        driver.wait_for(lambda s: "▶ /clear" not in s, timeout=3.0)
        ac3 = driver.snapshot()
        check("autocomplete: Tab completes + collapses list", "▶ /clear" not in ac3)

        # clear the field, then test Enter resolving a partial command
        for _ in range(8):
            driver.send(b"\x7f")
            time.sleep(0.02)
        driver.wait_idle(timeout=2.0, idle_for=0.4)

        for ch in b"/comp":  # unique prefix of /compact
            driver.send(bytes([ch]))
            time.sleep(0.04)
        driver.send(b"\r")  # Enter resolves "/comp" → /compact
        compacted = driver.wait_for(lambda s: "compact" in s.lower() and "History" in s, timeout=5.0)
        check("autocomplete: Enter resolves partial command", compacted)

        # ── Slash command: /help ─────────────────────────────────────────────
        for ch in b"/help":
            driver.send(bytes([ch]))
            time.sleep(0.03)
        driver.send(b"\r")
        helped = driver.wait_for(lambda s: "/compact" in s, timeout=5.0)
        check("slash: /help lists commands", helped)

        # ── q → back home ────────────────────────────────────────────────────
        driver.send(b"q")
        back = driver.wait_for(lambda s: "New session" in s, timeout=6.0)
        driver.wait_idle(timeout=3.0, idle_for=0.6)
        home2 = driver.snapshot()
        hr("BACK TO HOME (after q)")
        print_frame(home2)
        check("q returns to home", back)
        check("home: session row shows turn count or name", "Session" in home2 or "session" in home2)

        # ── Resume the session from home → transcript restored ──────────────
        driver.send(b"\x1b[B")  # down arrow to first existing session
        time.sleep(0.2)
        driver.send(b"\r")
        resumed = driver.wait_for(lambda s: "hello rite" in s and "everything works" in s, timeout=8.0)
        driver.wait_idle(timeout=3.0, idle_for=0.6)
        res = driver.snapshot()
        hr("RESUMED SESSION")
        print_frame(res)
        check("resume: transcript restored from disk", resumed)
        check("resume: footer shows 2 turns", "2 turns" in res)

        # back to home for the exit step
        driver.send(b"q")
        driver.wait_for(lambda s: "New session" in s, timeout=6.0)

        # ── Colors actually used ─────────────────────────────────────────────
        hr("FOREGROUND COLORS IN USE")
        for fg, sample in sorted(driver.colors().items()):
            print(f"│ rgb{fg}: {sample!r}")
        print("└" + "─" * WIDTH)

        wpid, status = os.waitpid(pid, os.WNOHANG)
        check("app still running", wpid == 0)

        # ── q on home → clean exit ───────────────────────────────────────────
        driver.send(b"q")
        exited = False
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            wpid, status = os.waitpid(pid, os.WNOHANG)
            if wpid:
                exited = True
                break
            time.sleep(0.1)
        check("q on home exits the app", exited)
        if exited:
            check("exit code 0", os.waitstatus_to_exitcode(status) == 0)

        print()
        if failures:
            print(f"✗ E2E FAILED: {len(failures)} check(s): {failures}")
        else:
            print("✓ E2E complete — all checks passed")

    finally:
        driver.stop()
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
        # give it a moment, then force-kill — don't block forever in waitpid
        for _ in range(20):
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    break
            except ChildProcessError:
                break
            time.sleep(0.1)
        else:
            try: os.kill(pid, signal.SIGKILL)
            except ProcessLookupError: pass
            try: os.waitpid(pid, 0)
            except ChildProcessError: pass
        try: os.close(master)
        except OSError: pass
        stderr = b""
        if select.select([err_r], [], [], 0.3)[0]:
            try: stderr = os.read(err_r, 65536)
            except OSError: pass
        os.close(err_r)
        if stderr.strip():
            print("\n── STDERR ──")
            print(stderr.decode("utf-8", errors="replace"))
        try:
            os.unlink(fake_script_path)
        except OSError:
            pass

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
