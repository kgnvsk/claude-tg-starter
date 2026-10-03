#!/usr/bin/env python3
"""Validate and atomically retain authenticated operators' SSH ban exemptions.

The root caller holds the host lifecycle lock. Addresses are exemptions from
kit-managed throttling, never identities or substitutes for SSH authentication.
"""
from __future__ import annotations

import argparse
import configparser
import ipaddress
import json
import os
from pathlib import Path
import stat
import sys
import tempfile


def trusted_read(path: Path, *, private: bool, limit: int) -> str | None:
    for ancestor in (path.parent, *path.parent.parents):
        if ancestor.is_symlink():
            raise ValueError("unsafe path")
    # A missing product directory must not be created below an untrusted
    # existing directory either (for example after a damaged migration).
    parent_path = next(ancestor for ancestor in (path.parent, *path.parent.parents) if ancestor.exists())
    parent = parent_path.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        raise ValueError("unsafe parent")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(descriptor, "r", encoding="utf-8") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                or info.st_mode & (0o077 if private else 0o022) or info.st_size > limit):
            raise ValueError("unsafe file")
        value = stream.read(limit + 1)
        if len(value) > limit:
            raise ValueError("oversized state")
        return value


def address(value: str, *, current: bool = False) -> str:
    if not isinstance(value, str) or not value or len(value) > 64 or "%" in value:
        raise ValueError("invalid address")
    if current or "/" not in value:
        parsed = ipaddress.ip_address(value)
    else:
        parsed = ipaddress.ip_network(value, strict=False)
        if parsed.prefixlen == 0:
            raise ValueError("wildcard network")
        if parsed.prefixlen == parsed.max_prefixlen:
            parsed = parsed.network_address
    if parsed.is_unspecified or parsed.is_multicast:
        raise ValueError("invalid source")
    return str(parsed)


def prepare(registry: Path, jail: Path, current: str) -> tuple[list[str], dict | None]:
    raw = trusted_read(registry, private=True, limit=16384)
    saved = json.loads(raw) if raw is not None else None
    if raw is not None and (not isinstance(saved, dict) or type(saved.get("schemaVersion")) is not int
            or saved["schemaVersion"] != 1
            or not isinstance(saved.get("addresses"), list) or len(saved["addresses"]) > 128):
        raise ValueError("invalid registry")
    values = [address(value) for value in saved["addresses"]] if saved is not None else []
    existing = trusted_read(jail, private=False, limit=65536)
    if existing is not None:
        config = configparser.ConfigParser(interpolation=None)
        config.read_string(existing)
        if config.has_section("sshd"):
            values += [address(value) for value in config.get("sshd", "ignoreip", fallback="").replace(",", " ").split()]
    if current:
        values.append(address(current, current=True))
    # The generated jail already exempts loopback; do not add redundant UFW rules.
    values = sorted({value for value in values if not ipaddress.ip_network(value, strict=False).is_loopback})
    if len(values) > 128:
        raise ValueError("too many addresses")
    return values, saved


def save(registry: Path, values: list[str], previous: dict | None) -> None:
    data = {"schemaVersion": 1, "addresses": values}
    if data == previous:
        return
    registry.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Recheck path/owner before replacing under the root caller's host lock.
    trusted_read(registry, private=True, limit=16384)
    descriptor, temporary = tempfile.mkstemp(prefix=".operator-ips-", dir=registry.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, registry)
        directory = os.open(registry.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", type=Path, required=True)
    parser.add_argument("--jail", type=Path, required=True)
    parser.add_argument("--current", default="")
    parser.add_argument("--write", action="store_true")
    options = parser.parse_args()
    try:
        values, previous = prepare(options.registry, options.jail, options.current)
        if options.write:
            save(options.registry, values, previous)
        print("\n".join(values))
    except (OSError, ValueError, UnicodeError, configparser.Error):
        print("FATAL: operator IP allowlist is invalid or unsafe; no network changes applied", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
