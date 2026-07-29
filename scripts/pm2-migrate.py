"""pm2 daemon proxy tool — invokes pm2 from within a single Python process and
records the state before and after each mutation. Designed to work around flaky
PowerShell-sandbox interop where individual pm2 stdout lines sometimes get
dropped between commands."""

from __future__ import annotations
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
LOGS.mkdir(exist_ok=True)


def run(args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace")
    return proc.returncode, (proc.stdout + proc.stderr).strip()


def jlist() -> list[dict]:
    code, out = run(["pm2", "jlist"])
    if code != 0 or not out:
        return []
    try:
        return json.loads(out)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"failed to parse jlist: {exc}\n{out[:300]}")


def find(j: list[dict], name: str) -> dict | None:
    return next((p for p in j if p.get("name") == name), None)


def dump_state(tag: str) -> None:
    apps = jlist()
    print(f"\n== {tag} ==")
    if not apps:
        print("  (no apps)")
        return
    for p in apps:
        env = p.get("pm2_env", {}) or {}
        print(
            f"  {p.get('name'):10s} | pid={p.get('pid')} | status={env.get('status')} | "
            f"out={env.get('pm_out_log_path')} | cwd={env.get('pm_cwd')}"
        )


def main() -> int:
    target = "openmaic"

    dump_state("initial")

    # If the bad-config instance is around, kill the wrapper and let pm2 clean up.
    initial = find(jlist(), target)
    if initial:
        wrapper_pid = initial.get("pid")
        if wrapper_pid:
            print(f"\n-> taskkill wrapper pid={wrapper_pid}")
            code, out = run(["taskkill", "/F", "/T", "/PID", str(wrapper_pid)])
            print(f"  taskkill exit={code} out={out or '<empty>'}")

        time.sleep(2)
        dump_state("after-taskkill")

        print(f"\n-> pm2 delete {target}")
        code, out = run(["pm2", "delete", target])
        print(f"  exit={code} out={out or '<empty>'}")

        time.sleep(1)
        dump_state("after-delete")

    print("\n-> pm2 start ecosystem.dev.config.cjs --only", target)
    code, out = run(["pm2", "start", "ecosystem.dev.config.cjs", "--only", target])
    print(f"  exit={code} out={out or '<empty>'}")

    time.sleep(3)
    dump_state("after-start")

    final = find(jlist(), target)
    if final:
        env = final.get("pm2_env", {}) or {}
        out_path = env.get("pm_out_log_path", "")
        err_path = env.get("pm_err_log_path", "")
        ok_out = out_path.endswith("logs\\pm2-openmaic-out.log") or out_path.endswith("logs/pm2-openmaic-out.log")
        ok_err = err_path.endswith("logs\\pm2-openmaic-err.log") or err_path.endswith("logs/pm2-openmaic-err.log")
        print(f"\nlog paths now inside logs/? out={ok_out} err={ok_err}")
        print(f"  out={out_path}\n  err={err_path}")
        if not (ok_out and ok_err):
            print("!! migration FAILED: log paths not inside ./logs/")
            return 1
    else:
        print("\n!! migration FAILED: openmaic is missing from jlist")
        return 1

    print("\nmigration OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
