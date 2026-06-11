#!/usr/bin/env python3
"""
Default-system-loop (memory-compliance review) e2e.

Isolates HOME to a temp dir with one always-inject behavioral memory so the
review fires, then scripts a fail→pass verdict sequence via RITE_FAKE_REVIEW to
drive the correction loop deterministically. Confirms: the reviewer's feedback
surfaces as a system notice, a correction turn streams a fresh assistant bubble,
and the loop terminates once the verdict passes (no runaway).

Reuses the PTY harness (Screen + PTYDriver) from e2e.py.
"""
import fcntl, json, os, pty, shutil, signal, sys, termios, time
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("e2e", os.path.join(HERE, "e2e.py"))
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)

ORIG = "ORIGINALMARKER reply"
FEEDBACK = "FEEDBACKMARKER add a citation"

failures = []
def check(name, cond):
    print(("  ✓ " if cond else "  ✗ ") + name)
    if not cond:
        failures.append(name)


def main():
    home = os.path.join(HERE, ".e2e-review-home")
    shutil.rmtree(home, ignore_errors=True)
    mem_dir = os.path.join(home, ".rite", "memory", "global")
    os.makedirs(mem_dir, exist_ok=True)
    with open(os.path.join(mem_dir, "test-rule.md"), "w") as f:
        f.write("---\nname: test-rule\ninject: always\n---\nAlways cite the source file.\n")

    fake_backend = os.path.join(HERE, ".review-backend.jsonl")
    with open(fake_backend, "w") as f:
        f.write(json.dumps({"type": "text", "content": ORIG}) + "\n")

    fake_review = os.path.join(HERE, ".review-verdicts.jsonl")
    with open(fake_review, "w") as f:
        f.write(json.dumps({"passed": False, "feedback": FEEDBACK}) + "\n")
        f.write(json.dumps({"passed": True, "feedback": ""}) + "\n")

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
        env["HOME"] = home                       # isolate ~/.rite to the temp dir
        env["RITE_FAKE_BACKEND"] = fake_backend
        env["RITE_FAKE_REVIEW"] = fake_review
        os.execve(e2e.BUN, [e2e.BUN, e2e.RITE], env)
        os._exit(1)
    os.close(slave)
    d = e2e.PTYDriver(master)

    try:
        d.wait_idle(timeout=10.0, idle_for=1.0)
        d.send(b"\r")
        d.wait_for(lambda s: "Message" in s, timeout=6.0)
        for ch in b"do the thing":
            d.send(bytes([ch])); time.sleep(0.02)
        d.send(b"\r")

        # The correction loop should produce: original reply → review feedback
        # → corrected reply. Wait until the feedback marker appears.
        got_review = d.wait_for(lambda s: FEEDBACK in s, timeout=12.0)
        d.wait_idle(timeout=4.0, idle_for=0.8)
        snap = d.snapshot()
        e2e.hr("REVIEW + CORRECTION")
        e2e.print_frame(snap)

        check("review: reviewer feedback shown as system notice", FEEDBACK in snap)
        check("review: 'review (compliance)' label present", "review (compliance)" in snap)
        check("review: original response rendered", ORIG in snap)
        check("review: correction produced a second assistant reply",
              snap.count(ORIG) >= 2)
        # two Rite labels: the original turn and the correction turn
        rite_labels = [ln for ln in snap.splitlines() if ln.strip() == "Rite"]
        check("review: correction is its own labeled Rite turn", len(rite_labels) >= 2)

        # loop terminated (pass on 2nd verdict) — app still running, not looping
        time.sleep(1.0)
        wpid, _ = os.waitpid(pid, os.WNOHANG)
        check("review: app still running (loop terminated)", wpid == 0)
        # exactly one correction (not 3): only one feedback notice
        check("review: stopped after the passing verdict (single correction)",
              snap.count(FEEDBACK) == 1)

        print()
        if failures:
            print(f"✗ REVIEW E2E FAILED: {failures}")
        else:
            print("✓ Review e2e complete — all checks passed")
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
        shutil.rmtree(home, ignore_errors=True)
        for p in (fake_backend, fake_review):
            try: os.unlink(p)
            except OSError: pass

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
