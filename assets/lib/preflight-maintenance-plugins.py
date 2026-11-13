#!/usr/bin/env python3
"""Refuse an in-place kit update if its managed plugin contract would change.

One change is allowed: an installed pair an earlier kit shipped (assets/product/plugin-policy-history.json) moving to
the staged pair only by switching plugins off. Its ids are printed for update.sh, which then removes them in the
window (Yuriy, 08.10.2026: a 14.08 install still carried example-skills, which the kit dropped on 15.08)."""

from __future__ import annotations

import os
from pathlib import Path
import hashlib
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


def parse(data: bytes) -> dict[str, object]:
    value = json.loads(
        data.decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=reject_constant,
    )
    if not isinstance(value, dict):
        raise ValueError("invalid plugin policy file")
    return value


def canonical(value: object) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def plugin_ids(value: object) -> set[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("invalid plugin list")
    return set(value)


def switched_off(kit: Path, installed: dict[str, bytes], staged: dict[str, bytes]) -> list[str]:
    """The plugins a reviewed earlier pair loses on the way to the staged one; anything else is refused."""
    product = parse(read_regular(kit / "assets/product/runtime.json")).get("productId")
    history = parse(read_regular(kit / "assets/product/plugin-policy-history.json"))
    old_policy, old_contract = parse(installed[FILES[0]]), parse(installed[FILES[1]])
    new_policy, new_contract = parse(staged[FILES[0]]), parse(staged[FILES[1]])
    known = history.get(product) if isinstance(product, str) else None
    if not isinstance(known, list) or not any(
        isinstance(pair, dict)
        and pair.get("policy") == canonical(old_policy)
        and pair.get("contract") == canonical(old_contract)
        for pair in known
    ):
        raise ValueError("installed plugin policy is not a kit release")
    old_enabled, new_enabled = plugin_ids(old_policy.get("enabled")), plugin_ids(new_policy.get("enabled"))
    old_plugins, new_plugins = old_contract.get("plugins"), new_contract.get("plugins")
    if not isinstance(old_plugins, dict) or not isinstance(new_plugins, dict):
        raise ValueError("invalid plugin contract")
    dropped = old_enabled - new_enabled
    # Nothing to install and no source changed: every kept plugin keeps its contract, and a dropped one stays
    # managed, so the window removes it as stale instead of leaving a foreign plugin behind.
    if (not new_enabled <= old_enabled or not dropped
            or set(new_plugins) != new_enabled
            or any(new_plugins[plugin] != old_plugins.get(plugin) for plugin in new_enabled)
            or not dropped <= plugin_ids(new_policy.get("managed"))):
        raise ValueError("plugin policy change is more than switching plugins off")
    return sorted(dropped)


def main(arguments: list[str]) -> int:
    if len(arguments) != 2:
        print("usage: preflight-maintenance-plugins KIT HOME", file=sys.stderr)
        return 2
    kit, home = map(Path, arguments)
    try:
        staged = {name: read_regular(kit / "assets/product" / name) for name in FILES}
        installed = {name: read_regular(home / ".claude/product" / name) for name in FILES}
        dropped = [] if staged == installed else switched_off(kit, installed, staged)
        staged_source = pinned_telegram_source(
            read_regular(kit / "assets/product/telegram-plugin-compat.json")
        )
        installed_source = pinned_telegram_source(
            read_regular(home / ".claude/product/telegram-plugin-compat.json")
        )
        if staged_source != installed_source:
            raise ValueError("Telegram plugin source changed")
    except (OSError, ValueError, UnicodeError, KeyError, TypeError):
        print(
            "FATAL: plugin policy/contract migration requires a separate "
            "reviewed procedure; ordinary kit update did not start",
            file=sys.stderr,
        )
        return 2
    if dropped:
        print(" ".join(dropped))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
