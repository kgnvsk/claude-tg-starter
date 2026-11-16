#!/usr/bin/env python3
"""Refuse an in-place kit update if its managed plugin contract would change."""

from __future__ import annotations

import os
from pathlib import Path
import json
import re
import stat
import sys


FILES = (
    "managed-plugins.json",
    "plugin-contract.json",
)
MAX_BYTES = 1024 * 1024
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_constant(_value: str) -> None:
    raise ValueError("nonfinite number")


def pinned_telegram_source(data: bytes) -> dict[str, object]:
    value = json.loads(
        data.decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
    )
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion", "pluginId", "supportedVersion", "upstream", "golden"
    }:
        raise ValueError("invalid Telegram contract")
    golden = value["golden"]
    if (
        not isinstance(golden, dict)
        or set(golden) != {"serverSha256"}
        or not isinstance(golden["serverSha256"], str)
        or SHA256.fullmatch(golden["serverSha256"]) is None
    ):
        raise ValueError("invalid Telegram golden")
    # The kit's reviewed server.ts golden may advance on an ordinary update;
    # plugin identity, version, and the pinned upstream source may not.
    del value["golden"]
    return value


def read_regular(path: Path) -> bytes:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
            raise ValueError("unsupported policy file")
        data = os.read(descriptor, MAX_BYTES + 1)
        if len(data) > MAX_BYTES or len(data) != info.st_size:
            raise ValueError("unstable policy file")
        return data
    finally:
        os.close(descriptor)


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        print("usage: preflight-maintenance-plugins KIT HOME", file=sys.stderr)
        return 2
    kit, home = map(Path, arguments)
    try:
        for name in FILES:
            staged = read_regular(kit / "assets/product" / name)
            installed = read_regular(home / ".claude/product" / name)
            if staged != installed:
                raise ValueError("plugin contract changed")
        staged_source = pinned_telegram_source(
            read_regular(kit / "assets/product/telegram-plugin-compat.json")
        )
        installed_source = pinned_telegram_source(
            read_regular(home / ".claude/product/telegram-plugin-compat.json")
        )
        if staged_source != installed_source:
            raise ValueError("Telegram plugin source changed")
    except (OSError, ValueError, UnicodeError):
        print(
            "FATAL: plugin policy/contract migration requires a separate "
            "reviewed procedure; ordinary kit update did not start",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
