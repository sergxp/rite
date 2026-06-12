#!/usr/bin/env python3
"""
Scroll-wheel e2e for Rite v2.

Drives the transcript with a tall scripted turn and real SGR wheel events to
verify: (1) the app enables button + scroll tracking but NOT all-motion
(?1003h, the mode that previously leaked movement gibberish); (2) the wheel
actually scrolls the transcript scrollbox; (3) all mouse modes are reset on
exit so nothing leaks into the terminal afterward.

Reuses the PTY harness (Screen + PTYDriver) from e2e.py.
"""
import fcntl, json, os, pty, signal, sys, termios, time
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("e2e", os.path.join(HERE, "e2e.py"))
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)

# Tall scripted turn: top + bottom markers with 70 filler lines between, so a
# 40-row terminal shows only one marker at a time.
LINES = ["SCROLLTOP_MARKER"] + [f"filler line {i}" for i in range(70)] + ["SCROLLBOT_MARKER"]
FAKE = [{"type": "text", "content": "\n".join(LINES)}]

failures = []
def check(name, cond):
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        failures.append(name)


def main():
    fake_path = os.path.join(HERE, ".scroll-fake.jsonl")
    with open(fake_path, "w") as f:
        for ev in FAKE:
            f.write(json.dumps(ev) + "\n")

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
        env["RITE_FAKE_BACKEND"] = fake_path
        os.execve(e2e.BUN, [e2e.BUN, e2e.RITE], env)
        os._exit(1)
    os.close(slave)
    d = e2e.PTYDriver(master)

    # Tap raw output to inspect the mouse-mode control sequences.
    raw = bytearray()
    orig_feed = d.screen.feed
    d.screen.feed = lambda data: (raw.extend(data), orig_feed(data))[1]

    try:
        d.wait_idle(timeout=10.0, idle_for=1.0)
        startup = bytes(raw)
        has = lambda seq: seq.encode() in startup
        check("mouse: button tracking enabled (?1000h)", has("?1000h"))
        check("mouse: SGR encoding enabled (?1006h)", has("?1006h"))
        check("mouse: all-motion NOT enabled (?1003h off)", not has("?1003h"))

        # Open a session and send the tall turn.
        d.send(b"\r")
        d.wait_for(lambda s: "Message" in s, timeout=6.0)
        for ch in b"scroll please":
            d.send(bytes([ch])); time.sleep(0.02)
        d.send(b"\r")
        d.wait_for(lambda s: "SCROLLBOT_MARKER" in s, timeout=8.0)
        d.wait_idle(timeout=3.0, idle_for=0.6)
        before = d.snapshot()
        check("scroll: sticky-bottom shows last line", "SCROLLBOT_MARKER" in before)
        check("scroll: top line off-screen initially", "SCROLLTOP_MARKER" not in before)

        # Sensitivity: a few notches should move several lines each, not 1:1.
        import re
        def topmost_filler(snap):
            nums = [int(m.group(1)) for ln in snap.splitlines()
                    for m in [re.search(r"filler line (\d+)", ln)] if m]
            return min(nums) if nums else None
        t0 = topmost_filler(before)
        for _ in range(3):
            d.send(b"\x1b[<64;20;5M")
            time.sleep(0.06)
        d.wait_idle(timeout=2.0, idle_for=0.4)
        t1 = topmost_filler(d.snapshot())
        moved = (t0 - t1) if (t0 is not None and t1 is not None) else 0
        print(f"  [sensitivity] topmost filler {t0} -> {t1}: {moved} lines over 3 notches")
        check("scroll: multiple lines per notch (not 1:1)", moved >= 5)

        # Wheel up (SGR button 64 = wheel up) over the transcript, enough ticks
        # to reach the top regardless of acceleration.
        for _ in range(160):
            d.send(b"\x1b[<64;20;5M")
            time.sleep(0.005)
        d.wait_idle(timeout=3.0, idle_for=0.6)
        after = d.snapshot()
        check("scroll: wheel-up reveals top line", "SCROLLTOP_MARKER" in after)
        check("scroll: wheel-up hides bottom line", "SCROLLBOT_MARKER" not in after)

        # Wheel back down to the bottom.
        for _ in range(160):
            d.send(b"\x1b[<65;20;5M")
            time.sleep(0.005)
        d.wait_idle(timeout=3.0, idle_for=0.6)
        back = d.snapshot()
        check("scroll: wheel-down returns to bottom", "SCROLLBOT_MARKER" in back)

        # Quit and verify mouse teardown.
        raw_exit = bytearray()
        d.screen.feed = lambda data: (raw_exit.extend(data), orig_feed(data))[1]
        d.send(b"q")
        d.wait_for(lambda s: "New session" in s, timeout=6.0)
        d.send(b"q")
        time.sleep(1.0)
        ex = bytes(raw_exit)
        check("exit: button mode reset (?1000l)", b"?1000l" in ex)
        check("exit: SGR mode reset (?1006l)", b"?1006l" in ex)

        print()
        if failures:
            print(f"✗ SCROLL E2E FAILED: {failures}")
        else:
            print("✓ Scroll e2e complete — all checks passed")
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
        try: os.unlink(fake_path)
        except OSError: pass

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
