#!/usr/bin/env python3
"""Merge managed shell assignments while preserving safe owner variables."""

from __future__ import annotations

import os
from pathlib import Path
import re
import shlex
import sys
import tempfile


ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# The same reading as saved-env-export (each script stands alone where it is installed).
ANSI_C_ESCAPES = {"a": 7, "b": 8, "e": 27, "E": 27, "f": 12, "n": 10, "r": 13, "t": 9, "v": 11,
                  "\\": 92, "'": 39, '"': 34, "?": 63}
OCTAL, HEX = "01234567", "0123456789abcdefABCDEF"


def ansi_c_value(raw: str, name: str, number: int) -> str:
    """Bash's %q wrote $'…' for non-ASCII under `env -i` in older updates (Cash, 29.10.2026): read the escapes it
    uses, as data; anything else in that form is still refused."""
    invalid = ValueError(f"invalid value for {name} on line {number}")
    if len(raw) < 3 or not raw.endswith("'"):
        raise invalid
    body, out, index = raw[2:-1], bytearray(), 0
    while index < len(body):
        char = body[index]
        if char == "'":
            raise invalid
        if char != "\\":
            out += char.encode("utf-8")
            index += 1
            continue
        index += 1
        char = body[index] if index < len(body) else ""
        if char in ANSI_C_ESCAPES:
            out.append(ANSI_C_ESCAPES[char])
            index += 1
        elif char and char in OCTAL:
            end = index
            while end < len(body) and end - index < 3 and body[end] in OCTAL:
                end += 1
            out.append(int(body[index:end], 8) & 0xFF)
            index = end
        elif char == "x" and index + 1 < len(body) and body[index + 1] in HEX:
            end = index + 1
            while end < len(body) and end - index - 1 < 2 and body[end] in HEX:
                end += 1
            out.append(int(body[index + 1:end], 16))
            index = end
        else:
            raise invalid
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        raise invalid from None


def shell_word(value: str) -> str:
    """One line per setting: a value with a line break goes back in the $'…' form it was read from."""
    if value == "" or value.splitlines() == [value]:
        return shlex.quote(value)
    out = []
    for char in value:
        if char in "\\'":
            out.append("\\" + char)
        elif char.splitlines() != [char]:
            out.extend(f"\\x{byte:02x}" for byte in char.encode("utf-8"))
        else:
            out.append(char)
    return "$'" + "".join(out) + "'"


def parse(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        name, separator, raw = stripped.partition("=")
        if not separator or not ASSIGNMENT.fullmatch(name) or name in values:
            raise ValueError(f"invalid environment assignment on line {number}")
        if raw.startswith("$'"):
            value = ansi_c_value(raw, name, number)
        elif raw == "":
            value = ""
        else:
            lexer = shlex.shlex(raw, posix=True)
            lexer.whitespace_split = True
            lexer.commenters = ""
            tokens = list(lexer)
            if len(tokens) != 1:
                raise ValueError(f"invalid value for {name} on line {number}")
            value = tokens[0]
        # Readers split on NUL (saved-env-export prints NUL pairs): none in any form.
        if "\0" in value:
            raise ValueError(f"invalid value for {name} on line {number}")
        values[name] = value
    return values


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "--value":
        path = Path(sys.argv[2])
        name = sys.argv[3]
        if ASSIGNMENT.fullmatch(name) is None:
            raise SystemExit("invalid environment variable name")
        try:
            value = parse(path).get(name, "")
        except (OSError, UnicodeError, ValueError) as error:
            raise SystemExit(str(error)) from error
        sys.stdout.write(value)
        return
    if len(sys.argv) != 4:
        raise SystemExit(
            "usage: merge-env.py OLD_ENV MANAGED_ENV OUTPUT_ENV | "
            "merge-env.py --value ENV_FILE NAME"
        )
    old_path, managed_path, output_path = map(Path, sys.argv[1:])
    try:
        old = parse(old_path)
        managed = parse(managed_path)
    except (OSError, UnicodeError, ValueError) as error:
        raise SystemExit(str(error)) from error

    merged = dict(old)
    merged.update(managed)
    ordered_names = [*managed, *(name for name in old if name not in managed)]
    payload = "".join(f"{name}={shell_word(merged[name])}\n" for name in ordered_names)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{output_path.name}.", dir=output_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    main()
