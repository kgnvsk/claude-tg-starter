#!/usr/bin/env python3
"""Install a root-owned, per-agent encrypted system-context collector."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shlex
import stat
import subprocess
import time

ROOT = Path("/usr/local/lib/novsky-backup")
POLICIES = Path("/etc/novsky/backup-context")
CRON_DIRECTORY = Path("/etc/cron.d")
BACKUP_DIRECTORY = Path("/var/backups/novsky-backup-context")
SYSTEMD_ROOTS = tuple(map(Path, ("/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system")))
SYSTEMD_RUNTIME = Path("/run/systemd/system")
CODEX_DIRECTORY = Path("/etc/novsky/codex")
CLAUDE_DIRECTORY = Path("/etc/claude-tg-starter")


def _metadata(info, owners, *, directory=False):
    kind = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not kind or info.st_uid not in owners or info.st_mode & 0o022 or not directory and info.st_nlink != 1:
        raise ValueError("unsafe file ownership, type or permissions")


@contextmanager
def _directory(path, owners, *, create=False, uid=0, gid=0):
    """Pin every directory; writes cannot follow an agent's concurrent symlink."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptors, links = [os.open("/", flags)], []
    try:
        _metadata(os.fstat(descriptors[0]), {0}, directory=True)
        for part in path.parts[1:]:
            created = False
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptors[-1])
                    created = True
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=descriptors[-1])
            descriptors.append(child)
            if created:
                os.fchown(child, uid, gid)
            _metadata(os.fstat(child), owners, directory=True)
            links.append((descriptors[-2], part, child))
        def verify():
            for parent, name, child in links:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                pinned = os.fstat(child)
                if (current.st_dev, current.st_ino) != (pinned.st_dev, pinned.st_ino):
                    raise ValueError("installation directory changed")
                _metadata(current, owners, directory=True)
        yield descriptors[-1], verify
        verify()
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _read(path, owners, *, limit=32 * 1024 * 1024):
    with _directory(path.parent, {0, *owners}) as (directory, verify):
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(descriptor, "rb") as stream:
            before = os.fstat(stream.fileno())
            _metadata(before, owners)
            if before.st_size > limit:
                raise ValueError("installation file too large")
            data = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
            if len(data) > limit or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError("installation file changed")
            verify()
            return data


def no_links(path):
    if any(item.is_symlink() for item in (path, *path.parents)):
        raise ValueError("unsafe path")


def write(path, data, uid=0, gid=0, mode=0o600):
    with _directory(path.parent, {0, uid}, create=True, uid=uid, gid=gid) as (directory, verify):
        try:
            _metadata(os.stat(path.name, dir_fd=directory, follow_symlinks=False), {uid})
        except FileNotFoundError:
            pass
        name = ".install-" + secrets.token_hex(16)
        descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fchown(stream.fileno(), uid, gid)
                os.fsync(stream.fileno())
            verify()
            os.replace(name, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        finally:
            try:
                os.unlink(name, dir_fd=directory)
            except FileNotFoundError:
                pass


def module(path):
    _read(path, {0})
    loader = importlib.machinery.SourceFileLoader("backup_bootstrap", str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    result = importlib.util.module_from_spec(spec)
    loader.exec_module(result)
    return result


def prepare_state(home, uid, gid, backup):
    """Harden only this agent's three state ancestors, preserving root parents."""
    with _directory(home, {0, uid}) as (home_fd, verify_home):
        descriptors, entries = [], []
        parent = home_fd
        try:
            path = home
            for name in (".local", "state", "agent-full-backup"):
                path /= name
                created = False
                try:
                    os.mkdir(name, 0o700, dir_fd=parent)
                    created = True
                except FileExistsError:
                    pass
                descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                descriptors.append(descriptor)
                if created:
                    os.fchown(descriptor, uid, gid)
                info = os.fstat(descriptor)
                final = name == "agent-full-backup"
                if not stat.S_ISDIR(info.st_mode) or info.st_uid not in ({uid} if final else {0, uid}):
                    raise ValueError("agent state ownership mismatch")
                if info.st_uid != uid and info.st_mode & 0o022:
                    raise ValueError("unsafe root state directory")
                mode = stat.S_IMODE(info.st_mode)
                target_mode = 0o700 if final else mode & ~0o022
                if mode != target_mode and any(name.startswith("system.posix_acl_") for name in os.listxattr(descriptor)):
                    raise ValueError("state directory ACL requires explicit repair")
                entries.append((parent, name, descriptor, info, str(path), target_mode, created))
                parent = descriptor

            def verify():
                verify_home()
                for parent, name, descriptor, before, _, _, _ in entries:
                    current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    pinned = os.fstat(descriptor)
                    if (not stat.S_ISDIR(current.st_mode)
                            or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino)
                            or (pinned.st_uid, pinned.st_gid) != (before.st_uid, before.st_gid)):
                        raise ValueError("agent state directory changed")

            verify()
            metadata = [{"path": path, "uid": info.st_uid, "gid": info.st_gid,
                         "mode": stat.S_IMODE(info.st_mode), "device": info.st_dev, "inode": info.st_ino}
                        for _, _, _, info, path, target, created in entries
                        if not created and stat.S_IMODE(info.st_mode) != target]
            if metadata:
                write(backup / "state-directory-metadata.json",
                      (json.dumps({"schemaVersion": 1, "directories": metadata}, sort_keys=True) + "\n").encode())
            for _, _, descriptor, before, _, target, _ in entries:
                verify()
                if stat.S_IMODE(before.st_mode) != target:
                    os.fchmod(descriptor, target)
            verify()
        finally:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


def canonical_service_path(path):
    legacy_root, canonical_root = SYSTEMD_ROOTS[2], SYSTEMD_ROOTS[1]
    if path.is_relative_to(legacy_root) and legacy_root.parents[1].is_symlink():
        # Debian's /lib alias is the only permitted system-source alias.
        for ancestor in (path, *path.parents):
            if ancestor != legacy_root.parents[1] and ancestor.is_symlink():
                raise ValueError("unsafe service source link")
        canonical = path.resolve()
        if canonical != canonical_root / path.relative_to(legacy_root):
            raise ValueError("unsafe vendor service alias")
        path = canonical
    no_links(path)
    return path


def offline_service_files(unit, template):
    # Image/container installs have unit files before a systemd manager exists.
    # A booted manager's missing metadata must not hide a different loaded unit.
    if SYSTEMD_RUNTIME.exists():
        raise ValueError("cannot read agent service definition")
    names = list(dict.fromkeys((unit, template)))
    fragment = next((root / name for name in names for root in SYSTEMD_ROOTS
                     if (root / name).exists() or (root / name).is_symlink()), None)
    if fragment is None:
        raise ValueError("agent service definition missing")
    files = [str(fragment)]
    # The collector's scope permits only this unit and its template. Fail closed
    # if generic overrides would require sources outside that declared scope.
    stem = unit.split("@", 1)[0].removesuffix(".service")
    generic = {"service.d", *(stem[:index + 1] + ".service.d"
                              for index, char in enumerate(stem) if char == "-")}
    for root in SYSTEMD_ROOTS:
        for name in generic:
            directory = canonical_service_path(root / name)
            if directory.exists() and any(directory.glob("*.conf")):
                raise ValueError("unsupported service context path")
        for name in names:
            directory = canonical_service_path(root / (name + ".d"))
            if directory.exists():
                with _directory(directory, {0}):
                    files.extend(str(path) for path in sorted(directory.glob("*.conf")))
    return files


def required_files(home, unit, engine):
    template = re.sub(r"@[^.]+\.service$", "@.service", unit) if "@" in unit else unit
    allowed_names = {unit, template}
    try:
        result = subprocess.run(["systemctl", "show", unit, "--property=FragmentPath,DropInPaths"],
                                capture_output=True, text=True, timeout=15)
        fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line) if result.returncode == 0 else {}
    except (OSError, subprocess.TimeoutExpired):
        fields = {}
    names = ([fields["FragmentPath"], *fields.get("DropInPaths", "").split()]
             if fields.get("FragmentPath") else offline_service_files(unit, template))
    files = []
    for name in names:
        path = Path(name)
        if not name or not path.is_absolute():
            continue
        path = canonical_service_path(path)
        if not path.is_file():
            raise ValueError("required service context missing")
        allowed = any(path == root / name for root in SYSTEMD_ROOTS for name in allowed_names)
        allowed = allowed or any(path.parent.name == name + ".d" and path.parent.parent in SYSTEMD_ROOTS
                                and re.fullmatch(r"[A-Za-z0-9_.-]+\.conf", path.name) for name in allowed_names)
        if not allowed:
            raise ValueError("unsupported service context path")
        _read(path, {0})
        files.append(str(path))
    if not files:
        raise ValueError("agent service definition missing")
    if engine == "codex":
        config = CODEX_DIRECTORY / (home.name + ".json")
        if not config.is_file():
            raise ValueError("native agent configuration missing")
        for path in sorted(config.parent.glob(home.name + ".*")):
            no_links(path)
            if path.is_file():
                files.append(str(path))
    else:
        filename = "agent.env" if home.name == "claude" else "agent-" + home.name + ".env"
        path = CLAUDE_DIRECTORY / filename
        if path.is_file():
            no_links(path)
            files.append(str(path))
    return sorted(set(files))


def agent_python(value, uid):
    """Validate a selected user runtime without ever executing it as root."""
    if (not isinstance(value, str) or len(value) > 4096
            or any(c in value for c in '\r\n\x00%')):
        raise ValueError('invalid backup Python path')
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or not re.fullmatch(r'python3(?:\.\d+)?', path.name):
        raise ValueError('invalid backup Python path')
    no_links(path)
    with _directory(path.parent, {0, uid}) as (parent, verify):
        info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        _metadata(info, {0, uid})
        if not info.st_mode & 0o111:
            raise ValueError('backup Python is not executable')
        verify()
    return str(path)


def install(home, user, unit, engine, *, source_dir=None, python_binary=None):
    if os.geteuid() != 0 or not re.fullmatch(r"[a-zA-Z0-9@_.-]+\.service", unit):
        raise ValueError("root and an exact agent unit are required")
    account = pwd.getpwnam(user)
    home = Path(home).absolute()
    if ".." in home.parts:
        raise ValueError("unsafe agent home")
    no_links(home)
    if home != Path(account.pw_dir) and Path(account.pw_dir) not in home.parents:
        raise ValueError("agent home does not belong to account")
    if not home.is_dir() or home.stat().st_uid != account.pw_uid:
        raise ValueError("agent home ownership mismatch")
    if python_binary is not None:
        python_binary = agent_python(python_binary, account.pw_uid)
    files = required_files(home, unit, engine)
    profile = hashlib.sha256(str(home).encode()).hexdigest()[:24]
    agent_cron = CRON_DIRECTORY / ("novsky-agent-full-backup-" + profile)
    files.append(str(agent_cron))
    source = Path(source_dir) if source_dir else Path(__file__).resolve().parent
    collector = source / "agent-backup-context.py"
    bootstrap = source.parent / "bin/agent-full-backup"
    if not bootstrap.is_file():
        bootstrap = source / "agent-full-backup"
    sanitizer = bootstrap.with_name("agent-backup-sanitize")
    for path in (collector, bootstrap, sanitizer):
        no_links(path)
        if not path.is_file():
            raise ValueError("verified backup runtime missing")
        _read(path, {0})
    policy = {"schemaVersion": 1, "agentHome": str(home), "uid": account.pw_uid,
              "gid": account.pw_gid, "unit": unit, "requiredFiles": files}
    target = POLICIES / (profile + ".json")
    state = home / ".local/state/agent-full-backup"
    config_path = state / "context.json"
    for path in (ROOT, POLICIES, state):
        no_links(path)
    no_links(config_path)
    cron = CRON_DIRECTORY / "novsky-backup-context"
    # Back up every existing file this installer owns before making a change.
    backup = BACKUP_DIRECTORY / (str(int(time.time())) + "-" + profile + "-" + secrets.token_hex(4))
    no_links(backup)
    for path in (ROOT, ROOT / "tools", POLICIES, backup):
        with _directory(path, {0}, create=True):
            pass
    for path in (ROOT / "tools/age", ROOT / "tools/age-keygen"):
        if path.exists() or path.is_symlink():
            _read(path, {0})
    prepare_state(home, account.pw_uid, account.pw_gid, backup)
    context = json.loads(_read(config_path, {account.pw_uid}, limit=128 * 1024)) if config_path.is_file() else {}
    if not isinstance(context, dict):
        raise ValueError("backup context configuration invalid")
    selected_python = python_binary if python_binary is not None else context.get('pythonExecutable')
    if selected_python is not None:
        context['pythonExecutable'] = agent_python(selected_python, account.pw_uid)
    context.update(systemContextRequired=True, systemContextProfileId=profile,
                   sharedAccount=home != Path(account.pw_dir), engine=engine, unit=unit,
                   scheduleProvisioned=True)
    for path in (ROOT / collector.name, ROOT / sanitizer.name, target, cron, agent_cron, config_path):
        no_links(path)
        if path.exists():
            if not path.is_file():
                raise ValueError("existing backup path is not a file")
            saved = backup / str(path).lstrip("/")
            write(saved, _read(path, {account.pw_uid} if path == config_path else {0}))
    # Bootstrap is from the same verified installer payload, never the live agent's bin.
    age, _ = module(bootstrap).age_tools(ROOT)
    for path in (ROOT / "tools", Path(age), Path(age).with_name("age-keygen")):
        no_links(path)
        os.chown(path, 0, 0)
        os.chmod(path, 0o700)
    write(ROOT / collector.name, _read(collector, {0}), mode=0o700)
    write(ROOT / sanitizer.name, _read(sanitizer, {0}), mode=0o700)
    command = f"* * * * * root /usr/bin/python3 {ROOT}/agent-backup-context.py --all --age-binary {age} >/dev/null 2>&1\n"
    write(cron, ("# Encrypted system context only; no model calls or bot restarts.\n" + command).encode(), mode=0o644)
    scheduled = shlex.join([selected_python or "/usr/bin/python3", str(home / "bin/agent-full-backup"), "--home", str(home), "scheduled"])
    minute = int(profile[:4], 16) % 60
    write(agent_cron, (f"# Full encrypted backup for one agent; enabled only after owner setup.\n{minute} * * * * {user} {scheduled} >>{shlex.quote(str(state / 'scheduled.log'))} 2>&1\n").encode(), mode=0o644)
    write(target, (json.dumps(policy, sort_keys=True) + "\n").encode())
    write(config_path, (json.dumps(context, sort_keys=True) + "\n").encode(), account.pw_uid, account.pw_gid)
    return {"profileId": profile, "policy": str(target), "contextRequired": True, "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--engine", choices=("claude", "codex"), required=True)
    parser.add_argument("--python-binary", help="Existing Python used only by the agent's backup job")
    args = parser.parse_args()
    try:
        result = install(args.home, args.user, args.unit, args.engine, python_binary=args.python_binary)
        print(json.dumps({"ok": True, **result}))
    except Exception:
        print(json.dumps({"ok": False, "error": "backup-context-install-failed"}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
