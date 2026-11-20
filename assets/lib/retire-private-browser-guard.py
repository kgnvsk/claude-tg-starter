#!/usr/bin/env python3
"""Retire the private-browser guard the kits of 24-26.10.2026 left behind.

Those kits gave an agent a private browser and an nft table that rejects the agent's own uid on the shared browser
port 8931, kept by claude-browser-private-<uid>-guard.service, which the agent's unit requires through a drop-in.
The kit dropped the private browser on 29.10 without removing the guard, so the agent kept losing the shared browser
(Clone, 20.11.2026: «службу браузера не встановлено», the agent sent its owner to the server's administrator).

For one agent: the drop-in, the guard unit and its two files go to a backup folder, the unit is disabled and the table
is deleted. The private profile and its user stay. Nothing to retire, or no such account: nothing happens. A systemd or
nft step that fails stops the retirement where it is and says so; it never fails the install that calls it.
Usage: retire-private-browser-guard.py <agent user> <agent service>
"""
from __future__ import annotations

import os
import pwd
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("CLAUDE_GUARD_TEST_ROOT", "/"))  # tests run against a fake root


def run(*command: str) -> int:
    try:
        return subprocess.run(list(command), capture_output=True).returncode
    except OSError:
        return 127


def our_table(table: str, uid: int) -> bool | None:
    """True: the guard's own table (the kit named it and marked it «private-browser-<uid>-…»); False: absent or not the
    guard's; None: nft could not tell."""
    try:
        listed = subprocess.run(["nft", "list", "table", "inet", table], capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return False
    except (OSError, subprocess.TimeoutExpired):
        return None
    if listed.returncode != 0:
        return False if "No such file or directory" in listed.stderr else None
    return f'comment "private-browser-{uid}-' in listed.stdout


def warn(message: str) -> int:
    print(f"WARN: старий захист приватного браузера не знято до кінця: {message}", file=sys.stderr)
    return 0


def retire(user: str, service: str) -> int:
    try:
        uid = pwd.getpwnam(user).pw_uid
    except KeyError:
        return 0  # no such account yet: nothing of it to retire
    unit = f"claude-browser-private-{uid}-guard.service"
    units = ROOT / "etc/systemd/system"
    drop_in = units / f"{service}.d" / "40-private-browser-egress.conf"
    rest = [units / unit, ROOT / "etc/claude-browser-private" / f"{uid}-guard.json",
            ROOT / "etc/claude-browser-private" / f"{uid}-guard.py"]
    table = f"claude_browser_guard_{uid}"
    has_table = our_table(table, uid)
    if not drop_in.exists() and not any(path.exists() for path in rest) and not has_table:
        return 0 if has_table is False else warn("nft не відповів, чи стоїть захист")
    backup = ROOT / "var/backups/claude-browser-private" / f"{uid}-{time.strftime('%Y%m%d%H%M%S')}"
    backup.mkdir(parents=True, exist_ok=True)
    os.chmod(backup, 0o700)
    # The agent's unit stops requiring the guard before the guard goes; without a reload nothing else moves.
    if drop_in.exists():
        shutil.move(str(drop_in), str(backup / drop_in.name))
        if run("systemctl", "daemon-reload") != 0:
            shutil.move(str(backup / drop_in.name), str(drop_in))
            return warn("systemd не перечитав служби")
    if (units / unit).exists() and run("systemctl", "disable", "--now", unit) != 0:
        return warn(f"не вдалося зупинити {unit}")
    for path in rest:
        if path.exists():
            shutil.move(str(path), str(backup / path.name))
    if run("systemctl", "daemon-reload") != 0:
        return warn("systemd не перечитав служби після прибирання")
    left = our_table(table, uid)
    if left is None:
        return warn("nft не відповів, чи лишився захист")
    if left and run("nft", "delete", "table", "inet", table) != 0:
        return warn(f"не вдалося видалити таблицю {table}")
    print(f"старий захист приватного браузера агента {user} знято (копії: {backup})")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    try:
        return retire(argv[1], argv[2])
    except OSError as error:
        return warn(type(error).__name__)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
