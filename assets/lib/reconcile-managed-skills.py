#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
AGENT_FILE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\.md$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
PLACEHOLDERS = (
    "AGENT_NAME", "OWNER_NAME", "OWNER_TG_USERNAME", "OWNER_CHAT_ID",
    "BOT_USERNAME", "TIMEZONE", "CALENDAR_EMAIL", "DEPLOY_DATE",
    "AGENT_HOME", "AGENT_SERVICE", "AGENT_USER",
)
# One snapshot per skill keeps the baseline small and treats added owner files
# as edits too. A changed skill is never partially overlaid with kit files.
Snapshot = dict[str, tuple[str, int, bytes]]


class PolicyError(ValueError):
    pass


def check_path(path: Path) -> None:
    """Do not read/write through symlinked roots, parents, or metadata files."""
    absolute = path.absolute()
    for part in (*reversed(absolute.parents), absolute):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode):
            raise PolicyError(f"символічне посилання у шляху навичок: {part}")
        if part != absolute and not stat.S_ISDIR(info.st_mode):
            raise PolicyError(f"батьківський шлях навичок не є каталогом: {part}")
        if part == absolute and not stat.S_ISDIR(info.st_mode) and (
            not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
        ):
            raise PolicyError(f"небезпечний тип файла навичок: {part}")


def load_policy(path: Path) -> dict[str, object]:
    check_path(path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise PolicyError(f"cannot read managed skill policy: {error}") from error
    if not isinstance(data, dict):
        raise PolicyError("managed skill policy must be an object")
    if set(data) - {"preservedAbsent"} != {"schemaVersion", "selected", "managed"}:
        raise PolicyError("managed skill policy has unexpected keys")
    if (
        isinstance(data["schemaVersion"], bool)
        or data["schemaVersion"] != 1
    ):
        raise PolicyError("managed skill policy schemaVersion must equal 1")
    for field in ("selected", "managed", "preservedAbsent"):
        values = data.get(field, [])
        if (
            not isinstance(values, list)
            or any(
                not isinstance(value, str)
                or not SKILL_NAME.fullmatch(value)
                for value in values
            )
            or len(values) != len(set(values))
        ):
            raise PolicyError(
                f"managed skill policy {field} must contain unique skill names"
            )
    if not set(data["selected"]).issubset(set(data["managed"])):
        raise PolicyError("selected skills must be a subset of managed skills")
    if not set(data.get("preservedAbsent", [])).issubset(set(data["selected"])):
        raise PolicyError("preserved absent skills must be selected skills")
    return data


def write_policy(path: Path, policy: dict[str, object]) -> None:
    check_path(path)
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


def load_baseline(path: Path, *, agent_files: bool = False) -> dict[str, str]:
    check_path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise PolicyError("не вдалося прочитати контрольні суми навичок") from error
    if (
        not isinstance(data, dict)
        or set(data) != {"schemaVersion", "entries"}
        or type(data["schemaVersion"]) is not int
        or data["schemaVersion"] != 1
        or not isinstance(data["entries"], dict)
        or any(
            not (
                (name in {"README.md", "roles"} or AGENT_FILE.fullmatch(name))
                if agent_files else (name == "manifest.json" or SKILL_NAME.fullmatch(name))
            )
            or not isinstance(digest, str)
            or not SHA256.fullmatch(digest)
            for name, digest in data["entries"].items()
        )
    ):
        raise PolicyError("некоректні контрольні суми навичок")
    return data["entries"]


def snapshot(path: Path, *, render: bool = False) -> Snapshot | None:
    check_path(path)
    if not path.exists():
        return None
    result: Snapshot = {}

    def visit(item: Path, relative: str) -> None:
        info = item.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISDIR(info.st_mode):
            result[relative] = ("directory", mode, b"")
            for child in sorted(item.iterdir()):
                visit(child, f"{relative}/{child.name}" if relative else child.name)
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            with os.fdopen(os.open(item, flags), "rb") as handle:
                payload = handle.read()
            if render and re.search(rb"\{\{[A-Z_]+\}\}", payload):
                for name in PLACEHOLDERS:
                    payload = payload.replace(
                        ("{{" + name + "}}").encode(), os.environ.get(name, "").encode()
                    )
                if re.search(rb"\{\{[A-Z_]+\}\}", payload):
                    raise PolicyError(f"незаповнений шаблон навички: {item}")
            result[relative] = ("file", mode, payload)
        else:
            raise PolicyError(f"символічне посилання або небезпечний файл навички: {item}")

    visit(path, "")
    return result


def checksum(value: Snapshot | None) -> str | None:
    if value is None:
        return None
    entries = [
        [name, kind, mode, hashlib.sha256(payload).hexdigest()]
        for name, (kind, mode, payload) in sorted(value.items())
    ]
    return hashlib.sha256(json.dumps(entries, ensure_ascii=True).encode()).hexdigest()


def install_snapshot(path: Path, value: Snapshot | None) -> None:
    """Stage complete content before replacing a verified, unchanged skill."""
    check_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".managed-skill-", dir=path.parent) as temporary:
        stage = Path(temporary) / "next"
        if value is not None:
            for relative, (kind, mode, payload) in value.items():
                target = stage / relative if relative else stage
                if kind == "directory":
                    target.mkdir()
                else:
                    target.write_bytes(payload)
                target.chmod(mode)
        check_path(path)
        previous = Path(temporary) / "previous"
        if path.exists():
            path.rename(previous)
        try:
            if value is not None:
                stage.rename(path)
        except OSError:
            if previous.exists():
                previous.rename(path)
            raise


def reconcile(
    skills_root: Path,
    policy_path: Path,
    state_path: Path,
    source_root: Path | None = None,
    baseline_path: Path | None = None,
    *,
    check: bool = False,
    external_root: Path | None = None,
) -> dict[str, object]:
    policy = load_policy(policy_path)
    baseline_path = baseline_path or state_path.with_name("managed-skills-baseline.json")
    baseline = load_baseline(baseline_path)
    disabled_root = skills_root.with_name(skills_root.name + ".disabled")
    check_path(state_path)
    previous_managed: set[str] = set()
    if state_path.exists():
        previous = load_policy(state_path)
        previous_managed = set(previous["managed"])

    selected = set(policy["selected"])
    if source_root is None:
        # The original three-argument API only reconciles skill names; its
        # absence of a source directory does not retire the installed manifest.
        selected.add("manifest.json")
    targets: dict[str, Snapshot] = {}
    if source_root is not None:
        check_path(source_root)
        if not source_root.is_dir():
            raise PolicyError("каталог вихідних навичок відсутній")
        for name in sorted(selected | {"manifest.json"}):
            value = snapshot(source_root / name, render=True)
            if value is not None:
                targets[name] = value
    if external_root is not None:
        if source_root is None:
            raise PolicyError("--external-source потребує --source")
        check_path(external_root)
        if external_root.exists() and not external_root.is_dir():
            raise PolicyError("каталог зовнішніх навичок не є каталогом")
        for name in sorted(selected):
            # External skills contain their own example/template markers. Only
            # first-party sources use this installer's profile substitutions.
            value = snapshot(external_root / name)
            if value is not None:
                if name in targets:
                    raise PolicyError(f"навичка оголошена у двох джерелах: {name}")
                targets[name] = value
            if name not in targets or targets[name].get("SKILL.md", (None,))[0] != "file":
                raise PolicyError(f"оголошена навичка відсутня в комплекті: {name}")

    managed = set(policy["managed"]) | previous_managed | set(baseline)
    result, next_baseline = reconcile_entries(
        skills_root, targets, (managed - selected) | set(targets), baseline,
        disabled_root=disabled_root, check=check,
    )
    if not check:
        if source_root is not None or baseline_path.exists():
            write_policy(baseline_path, {"schemaVersion": 1, "entries": next_baseline})
        # Record only this reconciliation's accepted absence, so the final
        # doctor still catches files lost after installation or reconciliation.
        policy.pop("preservedAbsent", None)
        absent = sorted(name for name, action in result["actions"].items()
                        if action == "preserve-absence" and name in selected)
        if absent:
            policy["preservedAbsent"] = absent
        write_policy(state_path, policy)
    return result


def reconcile_entries(
    root: Path,
    targets: dict[str, Snapshot],
    managed: set[str],
    baseline: dict[str, str],
    *,
    disabled_root: Path | None = None,
    check: bool = False,
) -> tuple[dict[str, object], dict[str, str]]:
    """One checksum planner/applicator for skill trees and subagent files."""
    for directory in (root, disabled_root):
        if directory is None:
            continue
        check_path(directory)
        if directory.exists() and not directory.is_dir():
            raise PolicyError(f"корінь керованих файлів не є каталогом: {directory}")
    if disabled_root is not None and disabled_root.exists():
        # The later default-off step also visits custom skills. Refuse an
        # ambiguous pair now so it cannot replace the owner's disabled copy.
        for entry in disabled_root.iterdir():
            if not entry.name.startswith(".") and entry.is_dir() and (root / entry.name).is_dir():
                raise PolicyError(f"конфлікт навички {entry.name}: одночасно ввімкнена й вимкнена копії")
    actions: dict[str, str] = {}
    changes: dict[str, tuple[Path, str | None, Snapshot | None]] = {}
    next_baseline = dict(baseline)
    for name in sorted(managed | set(targets)):
        active = root / name
        disabled = disabled_root / name if disabled_root is not None else None
        check_path(active)
        if disabled is not None:
            check_path(disabled)
        if disabled is not None and active.exists() and disabled.exists():
            raise PolicyError(f"конфлікт навички {name}: одночасно ввімкнена й вимкнена копії")
        destination = disabled if disabled is not None and disabled.exists() else active
        live = checksum(snapshot(destination))
        target = targets.get(name)
        desired = checksum(target)
        previous = baseline.get(name)
        if live == desired:
            action = "same"
        elif target is None:
            action = "remove" if previous is not None and live == previous else "preserve-retired"
        elif previous is None:
            action = "install" if live is None else "conflict"
        elif live == previous:
            action = "update"
        elif desired == previous:
            action = "preserve-absence" if live is None else "preserve"
        else:
            action = "conflict"
        actions[name] = action
        if action in {"install", "update", "remove"}:
            changes[name] = destination, live, target
        if action in {"same", "install", "update", "remove"}:
            if desired is None:
                next_baseline.pop(name, None)
            else:
                next_baseline[name] = desired

    conflicts = [name for name, action in actions.items() if action == "conflict"]
    if conflicts:
        raise PolicyError("конфлікт навичок або субагентів; файли збережено, копіювання не почалось: " + ", ".join(conflicts))
    result: dict[str, object] = {"actions": actions}
    if check:
        return result, next_baseline
    # Recheck the complete mutation set before its first write. Staging protects
    # each replacement; this is not a transaction over the rest of install-core.
    for destination, live, _ in changes.values():
        if checksum(snapshot(destination)) != live:
            raise PolicyError(f"навичка змінилася після перевірки: {destination.name}")
    for destination, _, target in changes.values():
        install_snapshot(destination, target)
    for name, action in actions.items():
        if action.startswith("preserve"):
            print(f"керовані файли збережено без змін: {name} ({action})", file=sys.stderr)
    return result, next_baseline


def reconcile_agents(
    agents_root: Path,
    source_root: Path,
    baseline_path: Path,
    active_roles: str,
    *,
    check: bool = False,
) -> dict[str, object]:
    baseline = load_baseline(baseline_path, agent_files=True)
    check_path(agents_root)
    check_path(source_root)
    if not source_root.exists():
        if baseline:
            raise PolicyError("каталог субагентів відсутній у комплекті")
        return {}
    if source_root.exists() and not source_root.is_dir():
        raise PolicyError("каталог субагентів не є каталогом")
    targets: dict[str, Snapshot] = {}
    managed = set(baseline)
    for source in sorted(source_root.glob("*.md")):
        if source.name != "README.md" and not AGENT_FILE.fullmatch(source.name):
            raise PolicyError(f"неприпустиме ім’я субагента: {source.name}")
        value = snapshot(source)
        if value is None or value[""][0] != "file":
            raise PolicyError(f"субагент має бути звичайним файлом: {source.name}")
        targets[source.name] = value
    base_names = set(targets)
    selected_roles = {name.strip() for name in active_roles.split(",") if name.strip()}
    if selected_roles != {"all"} and any(not SKILL_NAME.fullmatch(name) for name in selected_roles):
        raise PolicyError("некоректний список ACTIVE_ROLES")
    roles_root = source_root / "roles"
    check_path(roles_root)
    if roles_root.exists() and not roles_root.is_dir():
        raise PolicyError("каталог ролей не є каталогом")
    active_names: set[str] = set()
    for source in sorted(roles_root.glob("*.md")):
        if not AGENT_FILE.fullmatch(source.name) or source.name in base_names:
            raise PolicyError(f"неприпустиме або повторне ім’я ролі: {source.name}")
        value = snapshot(source)
        if value is None or value[""][0] != "file":
            raise PolicyError(f"роль має бути звичайним файлом: {source.name}")
        managed.add(source.name)
        if selected_roles == {"all"} or source.stem in selected_roles:
            targets[source.name] = value
            active_names.add(source.name)
        elif source.name not in baseline:
            # A legacy role can be removed when its exact shipped bytes and
            # mode still match. Keep edited files regardless of their marker.
            shipped = checksum(value)
            if checksum(snapshot(agents_root / source.name)) == shipped:
                baseline[source.name] = shipped
    # Old installers briefly copied the raw role catalog into the live tree.
    # It is safe to remove only when it still matches this shipped catalog;
    # a marker alone cannot prove that an owner has not edited it.
    raw_roles = agents_root / "roles"
    check_path(raw_roles)
    if raw_roles.exists():
        managed.add("roles")
        shipped = checksum(snapshot(roles_root))
        if shipped is not None and checksum(snapshot(raw_roles)) == shipped:
            baseline.setdefault("roles", shipped)
    result, next_baseline = reconcile_entries(agents_root, targets, managed, baseline, check=check)
    if not check:
        write_policy(baseline_path, {"schemaVersion": 1, "entries": next_baseline})
    result["activeRoles"] = len(active_names)
    result["removedRoles"] = sum(
        action == "remove" and name not in base_names and name.endswith(".md")
        for name, action in result["actions"].items()
    )
    return result


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    agents_mode = bool(argv and argv[0] == "agents")
    parser = argparse.ArgumentParser(description="Обережне оновлення керованих навичок і субагентів")
    if agents_mode:
        parser.add_argument("agents_root", type=Path)
        parser.add_argument("source_root", type=Path)
        parser.add_argument("baseline_path", type=Path)
        parser.add_argument("--active-roles", default="")
        parser.add_argument("--check", action="store_true")
        args = parser.parse_args(argv[1:])
        try:
            result = reconcile_agents(args.agents_root, args.source_root, args.baseline_path,
                                      args.active_roles, check=args.check)
        except (PolicyError, OSError) as error:
            print(f"помилка оновлення субагентів: {error}", file=sys.stderr)
            return 2
        if args.check:
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        elif result:
            print(f"рольові субагенти: активних {result['activeRoles']}, знято {result['removedRoles']}")
        return 0
    parser.add_argument("skills_root", type=Path)
    parser.add_argument("policy_path", type=Path)
    parser.add_argument("state_path", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--external-source", type=Path)
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = reconcile(args.skills_root, args.policy_path, args.state_path,
                           args.source, args.baseline, check=args.check, external_root=args.external_source)
    except (PolicyError, OSError) as error:
        print(f"помилка оновлення керованих навичок: {error}", file=sys.stderr)
        return 2
    if args.check:
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
