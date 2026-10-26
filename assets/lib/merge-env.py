#!/usr/bin/env python3
"""Merge managed shell assignments while preserving safe owner variables."""

from __future__ import annotations

import codecs
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile
import warnings


ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
ANSI_C_VALUE = re.compile(r"^\$'(?:[^'\\]|\\.)*'$", re.DOTALL)


def ansi_c_value(raw: str) -> str:
    # Legacy install-core used printf %q. Decode only one literal, never source/eval it.
    if ANSI_C_VALUE.fullmatch(raw) is None:
        raise ValueError
    with warnings.catch_warnings():
        warnings.simplefilter("error", DeprecationWarning)
        decoded = codecs.escape_decode(raw[2:-1].encode("utf-8"))[0]
    if b"\0" in decoded:
        raise ValueError
    return decoded.decode("utf-8")


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
            try:
                value = ansi_c_value(raw)
            except (UnicodeError, ValueError, DeprecationWarning) as error:
                raise ValueError(f"invalid value for {name} on line {number}") from error
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
        if any(character in value for character in "\0\n\r"):
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
    payload = "".join(f"{name}={shlex.quote(merged[name])}\n" for name in ordered_names)

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
