"""Run a command while holding the machine-wide full-suite lock (fleet rule 2)."""
import fcntl, os, subprocess, sys

d = os.path.expanduser("~/.cache/skep-test-tmp")
os.makedirs(d, exist_ok=True)
with open(os.path.join(d, "suite.lock"), "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    sys.exit(subprocess.call(sys.argv[1:]))
