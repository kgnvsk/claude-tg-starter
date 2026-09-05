#!/usr/bin/env python3
"""Keep ordered managed-rules imports without replacing owner-authored rules."""

from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "usage: sync-managed-claude.py OWNER_FILE MANAGED_IMPORT [...]",
            file=sys.stderr,
        )
        return 2

    path = Path(sys.argv[1])
    managed_imports = list(dict.fromkeys(sys.argv[2:]))
    managed_set = set(managed_imports)
    owner = (
        path.read_text(encoding="utf-8")
        if path.exists()
        else "# Правила власника\n"
    )
    lines = [
        line for line in owner.splitlines() if line.strip() not in managed_set
    ]
    path.write_text(
        "\n".join(managed_imports)
        + "\n\n"
        + "\n".join(lines).rstrip()
        + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
