#!/usr/bin/env python3
"""Render a managed template with an atomic, symlink-safe destination swap."""

import os
from pathlib import Path
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
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        return handle.read()


def destination_mode(path: Path) -> int:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 0o600
    if stat.S_ISREG(info.st_mode):
        return stat.S_IMODE(info.st_mode)
    return 0o600


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-template.py SOURCE DESTINATION")
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    text = read_no_follow(source)
    for name in PLACEHOLDERS:
        text = text.replace("{{" + name + "}}", os.environ.get(name, ""))

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        dir=destination.parent,
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, destination_mode(destination))
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


if __name__ == "__main__":
    main()
