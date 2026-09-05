#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class PolicyError(ValueError):
    pass


def load_policy(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise PolicyError(f"cannot read managed skill policy: {error}") from error
    if not isinstance(data, dict):
        raise PolicyError("managed skill policy must be an object")
    if set(data) != {"schemaVersion", "selected", "managed"}:
        raise PolicyError("managed skill policy has unexpected keys")
    if (
        isinstance(data["schemaVersion"], bool)
        or data["schemaVersion"] != 1
    ):
        raise PolicyError("managed skill policy schemaVersion must equal 1")
    for field in ("selected", "managed"):
        values = data[field]
        if (
            not isinstance(values, list)
            or len(values) != len(set(values))
            or any(
                not isinstance(value, str)
                or not SKILL_NAME.fullmatch(value)
                for value in values
            )
        ):
            raise PolicyError(
                f"managed skill policy {field} must contain unique skill names"
            )
    if not set(data["selected"]).issubset(set(data["managed"])):
        raise PolicyError("selected skills must be a subset of managed skills")
    return data


def write_policy(path: Path, policy: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                policy,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def remove_managed_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def reconcile(skills_root: Path, policy_path: Path, state_path: Path) -> None:
    policy = load_policy(policy_path)
    previous_managed: set[str] = set()
    if state_path.exists():
        previous = load_policy(state_path)
        previous_managed = set(previous["managed"])

    selected = set(policy["selected"])
    managed = set(policy["managed"]) | previous_managed
    for name in sorted(managed - selected):
        remove_managed_path(skills_root / name)
    write_policy(state_path, policy)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        print(
            "usage: reconcile-managed-skills.py "
            "SKILLS_DIR POLICY_JSON STATE_JSON",
            file=sys.stderr,
        )
        return 2
    try:
        reconcile(Path(args[0]), Path(args[1]), Path(args[2]))
    except PolicyError as error:
        print(f"managed skill policy error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
