#!/usr/bin/env python3
"""Remove one exact level-two Markdown section without touching other content."""

from pathlib import Path
import os
import re
import sys
import tempfile


SECTION_BOUNDARY = re.compile(r"^ {0,3}#{1,2}(?:[ \t]+|$)")


def remove_section(path: Path, heading: str) -> bool:
    if not path.is_file():
        return False
    original = path.stat()
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    start = next((index for index, line in enumerate(lines) if line.strip() == heading), None)
    if start is None:
        return False
    end = next(
        (
            index
            for index in range(start + 1, len(lines))
            if SECTION_BOUNDARY.match(lines[index])
        ),
        len(lines),
    )
    rendered = "".join(lines[:start] + lines[end:]).strip()
    if not rendered:
        path.unlink()
        return True

    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(rendered + "\n")
        os.chmod(temporary, original.st_mode & 0o777)
        if hasattr(os, "chown"):
            os.chown(temporary, original.st_uid, original.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: remove-markdown-section.py PATH HEADING")
    remove_section(Path(sys.argv[1]), sys.argv[2])
