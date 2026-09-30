#!/usr/bin/env python3
"""Render a managed template with an atomic, symlink-safe destination swap."""

from __future__ import annotations

import os
from pathlib import Path
import hashlib
import re
import stat
import sys
import tempfile


PLACEHOLDERS = (
    "AGENT_NAME", "OWNER_NAME", "OWNER_TG_USERNAME", "OWNER_CHAT_ID",
    "BOT_USERNAME", "TIMEZONE", "CALENDAR_EMAIL", "DEPLOY_DATE",
    "AGENT_HOME", "AGENT_SERVICE", "AGENT_USER",
)


def read_no_follow(path: Path) -> str:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "r", encoding="utf-8", newline="") as handle:
        return handle.read()


def destination_mode(path: Path) -> int:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 0o600
    if stat.S_ISREG(info.st_mode):
        return stat.S_IMODE(info.st_mode)
    return 0o600


def managed_baseline(path: Path) -> str | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    try:
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise ValueError
        digest = read_no_follow(path)
        if not re.fullmatch(r"[0-9a-f]{64}\n", digest):
            raise ValueError
        return digest.strip()
    except (OSError, UnicodeError, ValueError):
        raise SystemExit("FATAL: managed persona needs a reviewed migration before update") from None


def managed_destination(path: Path) -> str:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) not in (0o600, 0o644):
            raise ValueError
        return read_no_follow(path)
    except (FileNotFoundError, OSError, UnicodeError, ValueError):
        raise SystemExit("FATAL: managed persona needs a reviewed migration before update") from None


def write_atomic(path: Path, text: str, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main() -> None:
    check_unchanged = len(sys.argv) == 4 and sys.argv[1] == "--check-unchanged"
    managed_action = sys.argv[1] if len(sys.argv) == 5 and sys.argv[1] in (
        "--check-baseline", "--apply-baseline", "--accept-baseline"
    ) else None
    if not check_unchanged and not managed_action and len(sys.argv) != 3:
        raise SystemExit("usage: render-template.py [--check-unchanged | --check-baseline BASELINE | --apply-baseline BASELINE | --accept-baseline BASELINE] SOURCE DESTINATION")
    source = Path(sys.argv[-2])
    destination = Path(sys.argv[-1])
    text = read_no_follow(source)
    for name in PLACEHOLDERS:
        text = text.replace("{{" + name + "}}", os.environ.get(name, ""))

    if managed_action:
        baseline = Path(sys.argv[2])
        known_digest = managed_baseline(baseline)
        current = managed_destination(destination)
        current_digest = hashlib.sha256(current.encode("utf-8")).hexdigest()
        if managed_action == "--accept-baseline":
            if current != text:
                raise SystemExit("FATAL: managed persona needs a reviewed migration before update")
            write_atomic(baseline, current_digest + "\n", 0o600)
            return
        if current != text and current_digest != known_digest:
            raise SystemExit("FATAL: managed persona needs a reviewed migration before update")
        if managed_action == "--check-baseline" or current == text:
            return
        write_atomic(destination, text, destination_mode(destination))
        return

    if check_unchanged:
        try:
            info = destination.lstat()
            identical = (stat.S_ISREG(info.st_mode)
                         and stat.S_IMODE(info.st_mode) in (0o600, 0o644)
                         and read_no_follow(destination) == text)
        except (FileNotFoundError, OSError):
            identical = False
        if not identical:
            raise SystemExit("FATAL: managed persona needs a reviewed migration before instance update")
        return

    write_atomic(destination, text, destination_mode(destination))


if __name__ == "__main__":
    main()
