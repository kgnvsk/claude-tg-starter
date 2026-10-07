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
# Each agent runs its own collector job from ROOT/<profile> with its policy in
# POLICIES/agents. Until its next install, an agent may still use the shared
# --all job of older kits; maintenance accepts that job only with the last
# shared collector and sanitizer those kits shipped.
LEGACY_SHARED_COLLECTOR_SHA256 = "19411aaa43ae7c21100cfac8da19924724a293fb99f8eded6841a12d7519b705"
LEGACY_SHARED_SANITIZER_SHA256 = "09964c6d58b72da0b4198cc536e9c80052468df09ed756fd348015208db8d04a"
# Every collector and sanitizer a kit release installed (their git history up to
# 26.09.2026). A move before maintenance replaces or retires them, so it admits
# these bytes and the staged kit's own pair, and nothing else.
KIT_COLLECTOR_SHA256 = frozenset({
    "5fe362a2dc964cb9e0c84bca0f348e0738df5f63da58569fae810bd317636f55",
    "19411aaa43ae7c21100cfac8da19924724a293fb99f8eded6841a12d7519b705",
    "1f42de9ec0daaf82080fef29f6b9f3cfca96b9df7772f22b305d8b35ec1441f2",
    "f2f9abc9cb5ccf82ff464beb6a7921f69540815da6a9b513729a8339fe6f8f14",
})
KIT_SANITIZER_SHA256 = frozenset({
    "09964c6d58b72da0b4198cc536e9c80052468df09ed756fd348015208db8d04a",
    "7087f2e7b7a84f658386075a8c8651696ab0159cbd79f68c57787d5c6a9c772a",
    "b743ec0d11e58aa2a933e109d2389200581fea5b5b35742d140566607bd58b0b",
    "419ef2ae2418117c308c25c5817bca6d1f2f92920a7fdcc5672e0b6ac56a441e",
    "dea6440b48f5670f41cb33f055292820a9e7a278a4cf345f3c8ab93e5450b9c3",
    "efc52b142a49f7985d319bc4d90e9fc7425bd86dbca43dc674a1d032421e6c7e",
    "3c1db9d9c13e03e4c29c44c1774b55fcf819e6fbd594f7dc4860a1f4a4accf79",
    "b4066a4e894a5ac90b6fa3b802dbd369392c45145437c7fb095b0b1e28466af3",
    "517a44a65e73f1604cad7436a4fad1b981a81ebbca93bf838d00b29c6264ac4a",
    "a00c3fc8c1aa1d4aed100ab1dfcfa415029eb7538e5a6d49ca4558aec945abf4",
})


class LocalChanges(ValueError):
    """The root backup context holds bytes no kit release wrote."""


class ConfiguredBackup(ValueError):
    """A configured backup still runs on an old kit's schedule."""

# A temporary, explicit maintenance exception for the two owner canaries on
# 38.49.212.20. Fresh installs and ordinary fleet updates always require the
# current shared collector. No customer policy may be added or changed.
LEGACY_CANARY_IDENTITIES = frozenset({
    ("/home/claude-8709793308", "claude-8709793308",
     "claude-telegram@claude-8709793308.service", "claude"),
    ("/home/codex-8865933230", "codex-8865933230",
     "codex-telegram@codex-8865933230.service", "codex"),
})
PINNED_LEGACY_SHARED_CONTEXT = {
    "collector": "1f42de9ec0daaf82080fef29f6b9f3cfca96b9df7772f22b305d8b35ec1441f2",
    "sanitizer": "b743ec0d11e58aa2a933e109d2389200581fea5b5b35742d140566607bd58b0b",
    "cron": "01ada025e7027ee7f6c21b416493e0188a3ed88100f1d10c2bc80a0d4aeac8b0",
    "policies": {
        "042486f3ed904967f169c75e.json": "5d4fd6e03c1163fee1d37b6e8d3c34f3d298b9288b6781a7544aed61dae8639d",
        "0644d29c7bf393dd102d507e.json": "991709c8700cfc7708a0d5b3683b97bb532c91e468ee1f8193bfad8e70fcbbe4",
        "136498cc50b46c58ed0c7452.json": "bd7fa92bd1c5d8da09c81a85cbd3cbb28628748381622c6d73e8af9fe7bfd2e0",
        "3d1c2515996719be2d369315.json": "ca3dd4bea0fa79b1758a4309389967a07c21897853e7a10edcfbf36655c0ecee",
        "a75a2027b89f1a075f8fa68c.json": "043153d3337c56ed7563d1652ecc6a258574c0e8151d2edbd251adb367b87689",
    },
}


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


def context_job(collector, age, policy=None):
    selector = f"--policy {policy}" if policy else "--all"
    return ("# Encrypted system context only; no model calls or bot restarts.\n"
            f"* * * * * root /usr/bin/python3 {collector} {selector} --age-binary {age} >/dev/null 2>&1\n").encode()


def remove(path):
    with _directory(path.parent, {0}) as (directory, verify):
        try:
            os.unlink(path.name, dir_fd=directory)
        except FileNotFoundError:
            pass
        verify()


def shared_policies():
    with _directory(POLICIES, {0}) as (directory, verify):
        names = [name for name in os.listdir(directory) if name.endswith(".json")]
        verify()
    return names


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


def prepare_shared_config(backup):
    # Runtime configs below /etc/novsky/codex are owned by individual agents.
    # They need traversal of the shared parent, but never a directory listing
    # or access to the private backup-context directory and its policies.
    shared = POLICIES.parent
    with _directory(shared, {0}, create=True) as (descriptor, verify):
        info = os.fstat(descriptor)
        mode = stat.S_IMODE(info.st_mode)
        target = mode | 0o111
        if target != mode:
            write(backup / "shared-config-permissions.json", json.dumps({
                "path": str(shared), "mode": mode, "uid": info.st_uid, "gid": info.st_gid,
            }).encode())
            verify()
            os.fchmod(descriptor, target)


def retire_legacy_user_backup_cron(home, user, backup):
    # Older full-backup onboarding added an independent user cron line. The
    # root-provisioned nightly selector now owns that schedule. Keep a private
    # rollback copy before removing only the kit's exact marked command.
    if not (home / ".local/state/agent-full-backup/config.json").is_file():
        return
    command = ["crontab", "-u", user, "-l"]
    current = subprocess.run(command, capture_output=True, timeout=15)
    if current.returncode:
        if b"no crontab" in current.stderr.lower():
            return
        raise ValueError("legacy backup schedule read failed")
    try:
        lines = current.stdout.decode("utf-8").splitlines(keepends=True)
    except UnicodeError as error:
        raise ValueError("legacy backup schedule invalid") from error
    old = str(home / "bin/agent-full-backup")
    home_option = "--home " + shlex.quote(str(home)) + " scheduled"
    kept = [line for line in lines if not (
        old in line and home_option in line
        and re.search(r"# com\.novsky\.agent-backup\.[0-9a-f]{24}\s*$", line)
    )]
    if len(kept) == len(lines):
        return
    write(backup / "legacy-user-crontab", current.stdout)
    latest = subprocess.run(command, capture_output=True, timeout=15)
    if latest.returncode != current.returncode or latest.stdout != current.stdout:
        raise ValueError("legacy backup schedule changed")
    result = subprocess.run(["crontab", "-u", user, "-"], input="".join(kept).encode("utf-8"), capture_output=True, timeout=15)
    if result.returncode:
        raise ValueError("legacy backup schedule removal failed")


def _check_current(home, user, unit, engine, *, source_dir=None, python_binary=None,
                   allow_maintenance_hold=False, allow_pinned_legacy_shared_context=False):
    """Read-only proof that maintenance need not touch root backup context."""
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
    files = required_files(home, unit, engine)
    profile = hashlib.sha256(str(home).encode()).hexdigest()[:24]
    agent_cron = CRON_DIRECTORY / ("novsky-agent-full-backup-" + profile)
    if allow_maintenance_hold:
        names = ["zz-maintenance-hold.conf"]
        if engine == "claude" and unit == "claude-telegram.service":
            names.append("zy-novsky-transaction.conf")
        expected = f"[Unit]\nConditionPathExists=!{home}/logs/restart-hold.until\n".encode()
        for name in names:
            hold = Path("/etc/systemd/system") / (unit + ".d") / name
            if str(hold) in files:
                if (_read(hold, {0}) != expected
                        or stat.S_IMODE(hold.stat(follow_symlinks=False).st_mode) != 0o644):
                    raise ValueError("unexpected maintenance hold")
                files.remove(str(hold))
    files.append(str(agent_cron))
    source = Path(source_dir) if source_dir else Path(__file__).resolve().parent
    collector = source / "agent-backup-context.py"
    bootstrap = source.parent / "bin/agent-full-backup"
    if not bootstrap.is_file():
        bootstrap = source / "agent-full-backup"
    sanitizer = bootstrap.with_name("agent-backup-sanitize")
    for path in (collector, bootstrap, sanitizer):
        no_links(path)
        _read(path, {0})
    state = home / ".local/state/agent-full-backup"
    config_path = state / "context.json"
    own = ROOT / profile
    legacy = POLICIES / (profile + ".json")
    no_links(legacy)
    shared = legacy.exists() or legacy.is_symlink()
    directories = [(ROOT, {0}, 0, 0o700), (ROOT / "tools", {0}, 0, 0o700), (POLICIES, {0}, 0, 0o700),
                   (state, {0, account.pw_uid}, account.pw_uid, 0o700)]
    if not shared:
        directories += [(own, {0}, 0, 0o700), (POLICIES / "agents", {0}, 0, 0o700)]
    for directory, owners, uid, mode in directories:
        no_links(directory)
        with _directory(directory, owners) as (descriptor, verify):
            info = os.fstat(descriptor)
            if uid == 0:
                _metadata(info, {0}, directory=True)
            elif info.st_uid != uid:
                raise ValueError("backup context directory changed")
            if stat.S_IMODE(info.st_mode) != mode:
                raise ValueError("backup context directory changed")
            verify()
    with _directory(POLICIES.parent, {0}) as (descriptor, verify):
        if stat.S_IMODE(os.fstat(descriptor).st_mode) & 0o111 != 0o111:
            raise ValueError("backup context parent is not traversable")
        verify()

    def exact(path, expected, owners, mode):
        no_links(path)
        current = _read(path, owners)
        info = path.stat(follow_symlinks=False)
        if current != expected or stat.S_IMODE(info.st_mode) != mode:
            raise ValueError("backup context file changed")

    context_bytes = _read(config_path, {account.pw_uid}, limit=128 * 1024)
    context = json.loads(context_bytes)
    if not isinstance(context, dict):
        raise ValueError("backup context configuration invalid")
    selected_python = context.get("pythonExecutable")
    if selected_python is not None:
        selected_python = agent_python(selected_python, account.pw_uid)
    if python_binary is not None and agent_python(python_binary, account.pw_uid) != selected_python:
        raise ValueError("backup Python selection changed")
    managed = dict(systemContextRequired=True, systemContextProfileId=profile,
                   sharedAccount=home != Path(account.pw_dir), engine=engine, unit=unit,
                   scheduleProvisioned=True)
    if any(context.get(key) != value for key, value in managed.items()):
        raise ValueError("backup context configuration changed")
    exact(config_path, context_bytes, {account.pw_uid}, 0o600)
    policy = {"schemaVersion": 1, "agentHome": str(home), "uid": account.pw_uid,
              "gid": account.pw_gid, "unit": unit, "requiredFiles": files}
    policy_bytes = (json.dumps(policy, sort_keys=True) + "\n").encode()
    active = legacy if shared else POLICIES / "agents" / (profile + ".json")
    exact(active, policy_bytes, {0}, 0o600)
    if not shared:
        if allow_pinned_legacy_shared_context:
            raise ValueError("legacy shared backup context is canary-only")
        exact(own / collector.name, _read(collector, {0}), {0}, 0o700)
        exact(own / sanitizer.name, _read(sanitizer, {0}), {0}, 0o700)
        exact(CRON_DIRECTORY / ("novsky-backup-context-" + profile),
              context_job(own / collector.name, ROOT / "tools/age", active), {0}, 0o644)
    elif allow_pinned_legacy_shared_context:
        if (str(home), user, unit, engine) not in LEGACY_CANARY_IDENTITIES:
            raise ValueError("legacy shared backup context is canary-only")
        secret_store = home / ".config/novsky/secrets.json"
        no_links(secret_store)
        if secret_store.exists() or secret_store.is_symlink():
            raise ValueError("legacy shared backup context cannot inspect saved credentials")
        expected = PINNED_LEGACY_SHARED_CONTEXT
        for path, digest, mode in (
            (ROOT / collector.name, expected["collector"], 0o700),
            (ROOT / sanitizer.name, expected["sanitizer"], 0o700),
            (CRON_DIRECTORY / "novsky-backup-context", expected["cron"], 0o644),
        ):
            no_links(path)
            contents = _read(path, {0})
            if hashlib.sha256(contents).hexdigest() != digest or stat.S_IMODE(path.stat().st_mode) != mode:
                raise ValueError("pinned legacy shared backup context changed")
        with _directory(POLICIES, {0}) as (directory, verify):
            names = {name for name in os.listdir(directory) if name.endswith(".json")}
            if names != set(expected["policies"]):
                raise ValueError("legacy shared backup policy set changed")
            verify()
        for name, digest in expected["policies"].items():
            path = POLICIES / name
            contents = _read(path, {0})
            if hashlib.sha256(contents).hexdigest() != digest or stat.S_IMODE(path.stat().st_mode) != 0o600:
                raise ValueError("legacy shared backup policy changed")
    else:
        for path, digest in ((ROOT / collector.name, LEGACY_SHARED_COLLECTOR_SHA256),
                             (ROOT / sanitizer.name, LEGACY_SHARED_SANITIZER_SHA256)):
            no_links(path)
            if (hashlib.sha256(_read(path, {0})).hexdigest() != digest
                    or stat.S_IMODE(path.stat(follow_symlinks=False).st_mode) != 0o700):
                raise ValueError("shared backup context changed")
    for name in ("age", "age-keygen"):
        binary = ROOT / "tools" / name
        no_links(binary)
        data = _read(binary, {0})
        if not data or stat.S_IMODE(binary.stat(follow_symlinks=False).st_mode) != 0o700:
            raise ValueError("backup age tool changed")
    if shared:
        exact(CRON_DIRECTORY / "novsky-backup-context",
              context_job(ROOT / collector.name, ROOT / "tools/age"), {0}, 0o644)
    scheduled = shlex.join([selected_python or "/usr/bin/python3",
                            str(home / "bin/agent-nightly-github-backup"), "--home", str(home)])
    exact(agent_cron,
          (f"# Local hourly check; one configured GitHub backup at 22:00 Europe/Lisbon.\n"
           f"0 * * * * {user} {scheduled} >>{shlex.quote(str(state / 'scheduled.log'))} 2>&1\n").encode(),
          {0}, 0o644)
    # The fresh installer removes only its own legacy backup job. An ordinary
    # update cannot silently leave a second schedule or edit the owner's table.
    if (state / "config.json").is_file():
        current = subprocess.run(["crontab", "-u", user, "-l"], capture_output=True, timeout=15)
        if current.returncode and b"no crontab" not in current.stderr.lower():
            raise ValueError("legacy backup schedule read failed")
        old = str(home / "bin/agent-full-backup")
        home_option = "--home " + shlex.quote(str(home)) + " scheduled"
        if any(old in line and home_option in line
               and re.search(r"# com\.novsky\.agent-backup\.[0-9a-f]{24}\s*$", line)
               for line in current.stdout.decode("utf-8").splitlines()):
            raise ValueError("legacy backup schedule requires migration")
    return {"profileId": profile, "policy": str(active), "contextRequired": True}


def check_current(home, user, unit, engine, *, source_dir=None, python_binary=None,
                  allow_maintenance_hold=False, allow_pinned_legacy_shared_context=False):
    try:
        return _check_current(home, user, unit, engine, source_dir=source_dir,
                              python_binary=python_binary,
                              allow_maintenance_hold=allow_maintenance_hold,
                              allow_pinned_legacy_shared_context=allow_pinned_legacy_shared_context)
    except Exception as error:
        raise ValueError("backup context requires reviewed migration before maintenance") from error


def require_kit_origin(home, user, unit, engine, *, source_dir=None):
    """Refuse a move over anything a kit release did not write.

    The read-only check folds an older kit's files and an owner's edit into one
    answer, and the move replaces or retires them, keeping the old bytes only in a
    private backup (Codex, review of #215, 07.10.2026). Absent files and the exact
    files of a kit release move; anything else stops before the first write.
    """
    account = pwd.getpwnam(user)
    home = Path(home).absolute()
    profile = hashlib.sha256(str(home).encode()).hexdigest()[:24]
    source = Path(source_dir) if source_dir else Path(__file__).resolve().parent
    bootstrap = source.parent / "bin/agent-full-backup"
    if not bootstrap.is_file():
        bootstrap = source / "agent-full-backup"
    staged = {name: hashlib.sha256(_read(path, {0})).hexdigest()
              for name, path in (("collector", source / "agent-backup-context.py"),
                                 ("sanitizer", bootstrap.with_name("agent-backup-sanitize")))}

    def current(path, owners=frozenset({0})):
        no_links(path)
        return _read(path, set(owners)) if path.exists() else None

    for directory in (ROOT, ROOT / profile):
        for name, known in (("agent-backup-context.py", KIT_COLLECTOR_SHA256 | {staged["collector"]}),
                            ("agent-backup-sanitize", KIT_SANITIZER_SHA256 | {staged["sanitizer"]})):
            data = current(directory / name)
            if data is not None and hashlib.sha256(data).hexdigest() not in known:
                raise LocalChanges(f"backup context file changed outside the kit: {directory / name}")
    state = home / ".local/state/agent-full-backup"
    # A backup an owner set up on an old kit runs from that kit's line; the scheduler
    # that replaces it arrives only with this update. Moved now, the backup would have
    # no working trigger if the update stops (Codex, review of 2fbec439).
    no_links(state / "config.json")
    if (state / "config.json").exists() and not (home / "bin/agent-nightly-github-backup").is_file():
        raise ConfiguredBackup("a configured backup still runs on its old schedule")
    settings = current(state / "context.json", {account.pw_uid})
    settings = json.loads(settings) if settings is not None else {}
    if not isinstance(settings, dict):
        raise LocalChanges("backup context configuration changed outside the kit")
    pythons = {"/usr/bin/python3"}
    if isinstance(settings.get("pythonExecutable"), str):
        pythons.add(settings["pythonExecutable"])
    log = shlex.quote(str(state / "scheduled.log"))
    minute = int(profile[:4], 16) % 60
    agent_jobs = set()
    for python in pythons:
        full = shlex.join([python, str(home / "bin/agent-full-backup"), "--home", str(home), "scheduled"])
        nightly = shlex.join([python, str(home / "bin/agent-nightly-github-backup"), "--home", str(home)])
        agent_jobs.add((f"# Full encrypted backup for one agent; enabled only after owner setup.\n"
                        f"{minute} * * * * {user} {full} >>{log} 2>&1\n").encode())
        agent_jobs.add((f"# Local hourly check; one configured GitHub backup at 22:00 Europe/Lisbon.\n"
                        f"0 * * * * {user} {nightly} >>{log} 2>&1\n").encode())
    age = ROOT / "tools/age"
    for path, known in (
            (CRON_DIRECTORY / ("novsky-agent-full-backup-" + profile), agent_jobs),
            (CRON_DIRECTORY / "novsky-backup-context", {context_job(ROOT / "agent-backup-context.py", age)}),
            (CRON_DIRECTORY / ("novsky-backup-context-" + profile),
             {context_job(ROOT / profile / "agent-backup-context.py", age, POLICIES / "agents" / (profile + ".json"))})):
        data = current(path)
        if data is not None and data not in known:
            raise LocalChanges(f"backup schedule changed outside the kit: {path}")
    # A move rewrites requiredFiles from the unit as it is now. It may add what the unit
    # has gained; it drops nothing but the exact temporary holds a kit itself wrote in.
    kept = set(required_files(home, unit, engine)) | {str(CRON_DIRECTORY / ("novsky-agent-full-backup-" + profile))}
    kept |= {str(Path("/etc/systemd/system") / (unit + ".d") / name)
             for name in ("zz-maintenance-hold.conf", "zy-novsky-transaction.conf")}
    for path in (POLICIES / (profile + ".json"), POLICIES / "agents" / (profile + ".json")):
        data = current(path)
        if data is None:
            continue
        try:
            policy = json.loads(data)
        except ValueError:
            policy = None
        if (not isinstance(policy, dict)
                or set(policy) != {"schemaVersion", "agentHome", "uid", "gid", "unit", "requiredFiles"}
                or (policy["schemaVersion"], policy["agentHome"], policy["uid"], policy["gid"], policy["unit"])
                != (1, str(home), account.pw_uid, account.pw_gid, unit)
                or not isinstance(policy["requiredFiles"], list)
                or not all(isinstance(name, str) and name in kept for name in policy["requiredFiles"])
                or data != (json.dumps(policy, sort_keys=True) + "\n").encode()):
            raise LocalChanges(f"backup policy changed outside the kit: {path}")


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
    own = ROOT / profile
    target = POLICIES / "agents" / (profile + ".json")
    legacy = POLICIES / (profile + ".json")
    state = home / ".local/state/agent-full-backup"
    config_path = state / "context.json"
    for path in (ROOT, POLICIES, state):
        no_links(path)
    no_links(config_path)
    cron = CRON_DIRECTORY / ("novsky-backup-context-" + profile)
    shared = (ROOT / collector.name, ROOT / sanitizer.name, CRON_DIRECTORY / "novsky-backup-context")
    # Back up every existing file this installer owns before making a change.
    backup = BACKUP_DIRECTORY / (str(int(time.time())) + "-" + profile + "-" + secrets.token_hex(4))
    no_links(backup)
    with _directory(backup, {0}, create=True):
        pass
    prepare_shared_config(backup)
    for path in (ROOT, ROOT / "tools", own, POLICIES, POLICIES / "agents"):
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
    for path in (own / collector.name, own / sanitizer.name, target, legacy, cron, agent_cron, config_path,
                 *shared):
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
    write(own / collector.name, _read(collector, {0}), mode=0o700)
    write(own / sanitizer.name, _read(sanitizer, {0}), mode=0o700)
    # 1. The agent's own job; it waits while the shared job still has its policy.
    write(cron, context_job(own / collector.name, age, target), mode=0o644)
    scheduled = shlex.join([selected_python or "/usr/bin/python3", str(home / "bin/agent-nightly-github-backup"), "--home", str(home)])
    write(agent_cron, (f"# Local hourly check; one configured GitHub backup at 22:00 Europe/Lisbon.\n0 * * * * {user} {scheduled} >>{shlex.quote(str(state / 'scheduled.log'))} 2>&1\n").encode(), mode=0o644)
    retire_legacy_user_backup_cron(home, user, backup)
    # 2. Move the policy out of the shared job's list.
    write(target, (json.dumps(policy, sort_keys=True) + "\n").encode())
    remove(legacy)
    # 3. The last agent to move retires the shared job; tools and locks stay.
    if not shared_policies():
        for path in shared:
            remove(path)
    write(config_path, (json.dumps(context, sort_keys=True) + "\n").encode(), account.pw_uid, account.pw_gid)
    return {"profileId": profile, "policy": str(target), "contextRequired": True, "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--user", required=True)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--engine", choices=("claude", "codex"), required=True)
    parser.add_argument("--python-binary", help="Existing Python used only by the agent's backup job")
    parser.add_argument("--check-current", action="store_true", help="Read-only maintenance compatibility check")
    parser.add_argument("--allow-maintenance-hold", action="store_true", help="Ignore this updater's exact temporary systemd hold")
    parser.add_argument("--allow-pinned-legacy-shared-context", action="store_true",
                        help="Maintenance only for two owner canaries on the exact witnessed legacy host")
    parser.add_argument("--kit-origin-only", action="store_true",
                        help="Move only absent files and the exact files of a kit release; stop on anything else")
    args = parser.parse_args()
    try:
        if args.allow_pinned_legacy_shared_context and not args.check_current:
            raise ValueError("legacy shared context is maintenance-only")
        if args.kit_origin_only:
            if args.check_current:
                raise ValueError("a move is not a check")
            require_kit_origin(args.home, args.user, args.unit, args.engine)
        action = check_current if args.check_current else install
        result = action(args.home, args.user, args.unit, args.engine, python_binary=args.python_binary,
                        **({"allow_maintenance_hold": args.allow_maintenance_hold,
                            "allow_pinned_legacy_shared_context": args.allow_pinned_legacy_shared_context}
                           if args.check_current else {}))
        print(json.dumps({"ok": True, **result}))
    except LocalChanges as error:
        print(json.dumps({"ok": False, "error": "backup-context-local-changes", "detail": str(error)}))
        return 1
    except ConfiguredBackup as error:
        print(json.dumps({"ok": False, "error": "backup-context-configured-backup", "detail": str(error)}))
        return 1
    except Exception:
        error_code = "backup-context-migration-required" if args.check_current else "backup-context-install-failed"
        print(json.dumps({"ok": False, "error": error_code}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
