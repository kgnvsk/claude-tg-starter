#!/usr/bin/env python3
"""Validate and restore a secret-free agent backup into an allowlisted home."""

from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import pwd
import shutil
import stat
import sys
import tempfile
import zipfile
from datetime import datetime, timezone


ALLOWED_EXACT = {
    Path("CLAUDE.md"),
    Path(".claude/settings.json"),
    Path(".claude/onboarding-state.json"),
    Path(".claude/channels/telegram/access.json"),
    Path(".claude/CLAUDE.premium.md"),
    Path(".claude/product/managed-runtime-baseline.json"),
    Path(".claude/plugins/installed_plugins.json"),
}
ALLOWED_PREFIXES = (
    Path(".claude/memory"),
    Path(".claude/goals"),
    Path(".claude/agents"),
    Path(".claude/skills"),
    Path(".claude/hooks"),
    Path(".local/state/asana-tasks/operations"),
    Path(".local/state/meta-ads/operations"),
    Path(".local/state/hubspot-crm/operations"),
    Path("obsidian-vault"),
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def allowed(relative: Path, managed_paths: set[Path] | None = None) -> bool:
    return relative in ALLOWED_EXACT or any(
        relative == prefix or prefix in relative.parents for prefix in ALLOWED_PREFIXES
    ) or relative in (managed_paths or set())


def safe_relative(name: str, managed_paths: set[Path] | None = None) -> Path:
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts or not name.startswith("home/"):
        raise ValueError(f"unsafe archive path: {name}")
    relative = Path(*pure.parts[1:])
    if not relative.parts or not allowed(relative, managed_paths):
        raise ValueError(f"path is outside restore allowlist: {name}")
    return relative


def load_verified(
    archive_path: Path,
) -> tuple[zipfile.ZipFile, dict, list[dict], set[Path]]:
    archive = zipfile.ZipFile(archive_path)
    names = archive.namelist()
    if len(names) != len(set(names)):
        archive.close()
        raise ValueError("archive contains duplicate paths")
    if "manifest.json" not in names:
        archive.close()
        raise ValueError("manifest.json is missing")
    manifest = json.loads(archive.read("manifest.json"))
    if manifest.get("schemaVersion") != 1 or manifest.get("containsSecrets") is not False:
        archive.close()
        raise ValueError("unsupported or non-secret-free backup")
    entries = manifest.get("files", [])
    declared = {item["path"]: item for item in entries}
    if set(names) - {"manifest.json"} != set(declared):
        archive.close()
        raise ValueError("manifest file list does not match archive")
    managed_paths: set[Path] = set()
    baseline_name = "home/.claude/product/managed-runtime-baseline.json"
    if baseline_name in declared:
        baseline = json.loads(archive.read(baseline_name))
        files = baseline.get("files") if isinstance(baseline, dict) else None
        if not isinstance(files, dict) or len(files) > 512:
            archive.close()
            raise ValueError("managed runtime baseline is invalid")
        for relative in files:
            path = PurePosixPath(relative)
            if (
                not isinstance(relative, str)
                or path.is_absolute()
                or ".." in path.parts
                or len(path.parts) != 2
                or path.parts[0] != "bin"
            ):
                archive.close()
                raise ValueError("managed runtime baseline path is unsafe")
            managed_paths.add(Path(*path.parts))
    for name, item in declared.items():
        safe_relative(name, managed_paths)
        info = archive.getinfo(name)
        mode = info.external_attr >> 16
        if stat.S_ISLNK(mode):
            archive.close()
            raise ValueError(f"symlink entries are forbidden: {name}")
        data = archive.read(name)
        if len(data) != item["size"] or digest(data) != item["sha256"]:
            archive.close()
            raise ValueError(f"checksum mismatch: {name}")
    return archive, manifest, entries, managed_paths


def validate_target(home: Path, relative: Path) -> Path:
    root = home.resolve()
    target = home / relative
    parent = target.parent.resolve()
    if not parent.is_relative_to(root):
        raise ValueError(f"target escapes home: {relative}")
    current = home
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"target parent is a symlink: {current}")
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        return target
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"target is not a regular file: {relative}")
    return target


def dry_run(archive_path: Path, home: Path) -> dict:
    archive, manifest, entries, managed_paths = load_verified(archive_path)
    try:
        paths = []
        for item in entries:
            relative = safe_relative(item["path"], managed_paths)
            target = validate_target(home, relative)
            paths.append(
                {
                    "path": str(target),
                    "action": "replace" if target.exists() else "create",
                    "size": item["size"],
                }
            )
        return {
            "status": "dry-run",
            "createdAt": manifest["createdAt"],
            "files": paths,
        }
    finally:
        archive.close()


def restore(archive_path: Path, home: Path) -> dict:
    archive, manifest, entries, managed_paths = load_verified(archive_path)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safety = Path("/var/backups/claude-tg-starter") / f"restore-{timestamp}"
    safety.mkdir(parents=True, mode=0o700)
    account = pwd.getpwnam("claude")
    restored = 0
    backed_up = 0
    replaced: list[tuple[Path, Path | None]] = []
    try:
        for item in entries:
            relative = safe_relative(item["path"], managed_paths)
            target = validate_target(home, relative)
            backup_target = None
            if target.exists():
                backup_target = safety / relative
                backup_target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, backup_target, follow_symlinks=False)
                backed_up += 1
            target.parent.mkdir(parents=True, exist_ok=True)
            data = archive.read(item["path"])
            fd, temporary = tempfile.mkstemp(prefix=target.name + ".", dir=target.parent)
            try:
                with os.fdopen(fd, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                stored_mode = archive.getinfo(item["path"]).external_attr >> 16
                mode = stored_mode & 0o777
                if relative.parts[:2] == (".claude", "memory"):
                    mode = 0o600
                os.chmod(temporary, mode or 0o600)
                os.chown(temporary, account.pw_uid, account.pw_gid)
                replaced.append((target, backup_target))
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            restored += 1
    except Exception:
        for target, backup_target in reversed(replaced):
            if backup_target is None:
                target.unlink(missing_ok=True)
                continue
            fd, temporary = tempfile.mkstemp(
                prefix=target.name + ".rollback.", dir=target.parent
            )
            os.close(fd)
            try:
                shutil.copy2(backup_target, temporary, follow_symlinks=False)
                os.chown(temporary, account.pw_uid, account.pw_gid)
                os.replace(temporary, target)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
        raise
    finally:
        archive.close()
    return {
        "status": "restored",
        "createdAt": manifest["createdAt"],
        "files": restored,
        "previousFilesSaved": backed_up,
        "safetyCopy": str(safety),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--home", type=Path, default=Path("/home/claude"))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    output = (
        dry_run(args.archive.resolve(), args.home)
        if args.dry_run
        else restore(args.archive.resolve(), args.home)
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, json.JSONDecodeError) as error:
        print(f"restore-agent-backup: {error}", file=sys.stderr)
        raise SystemExit(2)
