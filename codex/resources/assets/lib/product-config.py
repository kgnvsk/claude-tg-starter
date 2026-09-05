#!/usr/bin/env python3
"""Read the generated product runtime contract from shell installers."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


LIST_KEYS = {
    "firstPartySkills",
    "externalSkills",
    "features",
    "requiredChecks",
    "optionalChecks",
}
SCALAR_KEYS = {"productId", "displayName", "updateOrigin"}


def load_runtime(path: Path) -> dict[str, object]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("runtime root must be an object")

    for key in LIST_KEYS:
        value = data.get(key)
        if not isinstance(value, list) or any(
            not isinstance(item, str) or not item for item in value
        ):
            raise ValueError(f"{key} must be a list of non-empty strings")
    for key in SCALAR_KEYS:
        value = data.get(key)
        if not isinstance(value, str) or not value:
            raise ValueError(f"{key} must be a non-empty string")
    return data


def parser() -> argparse.ArgumentParser:
    default = Path(__file__).resolve().parents[1] / "product/runtime.json"
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--file", type=Path, default=default)
    subcommands = result.add_subparsers(dest="command", required=True)

    get = subcommands.add_parser("get")
    get.add_argument("key", choices=sorted(SCALAR_KEYS))

    has_feature = subcommands.add_parser("has-feature")
    has_feature.add_argument("name")

    list_values = subcommands.add_parser("list")
    list_values.add_argument("key", choices=sorted(LIST_KEYS))
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        runtime = load_runtime(args.file)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"product-config: {error}", file=sys.stderr)
        return 2

    if args.command == "get":
        print(runtime[args.key])
        return 0
    if args.command == "has-feature":
        return 0 if args.name in runtime["features"] else 1
    if args.command == "list":
        values = runtime[args.key]
        if values:
            print("\n".join(values))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
