#!/usr/bin/env python3
"""Sanitize and encrypt exact system files from an installed root-owned policy.

Installer contract (no agent-controlled source paths):
  /etc/novsky/backup-context/<profile-id>.json, root-owned, not group/other
  writable, no symlinks/hardlinks, with these fields:
  {"schemaVersion": 1, "agentHome": "/home/claude", "uid": 1000, "gid": 1000,
   "unit": "claude-telegram.service", "requiredFiles": [
     "/etc/systemd/system/claude-telegram.service",
     "/etc/claude-tg-starter/agent.env"]}

schemaVersion is optional and defaults to 1. A required unit fragment must be
the exact unit or its matching @.service template, beneath /etc/systemd/system,
/usr/lib/systemd/system or a real /lib/systemd/system. Canonicalize /lib through
root-trusted paths at installation when it is a symlink. Only these units/drop-ins,
this home's /etc/novsky/codex/<home-name>.* files, matching Claude agent.env,
and /etc/cron.d/novsky-agent-full-backup-<sha256(agentHome)[:24]> are accepted.
Missing required files fail the capture; installers must list every required
file explicitly. uid=0 is supported only for a home already owned by root.

Install this script, agent-backup-sanitize and age outside all agent homes, with root-owned ancestry
and no group/other writes. Bootstrap age from a digest-pinned official release;
this helper never downloads or executes an agent-home binary. Root cron may run
--all. A profile without a prepared public recipient is skipped.

Output is only ciphertext plus a secret-free receipt, both atomic 0600 files
owned by the configured agent under its .local/state/agent-full-backup/context:
  system-context.tar.gz.age, system-context.json
Consumers must match receipt recipient/installationId/freshness and SHA-256 to
the ciphertext. The pair fails closed during replacement/crash; it is not a
two-file transaction. The encrypted tar contains sanitized system/etc/...,
system/reconnect-inventory.json and a final manifest.json (agent-system-context/v1).
Secrets are removed before encryption; opaque credential stores are excluded.
Both manifest and receipt declare privacyPolicy=no-secrets-v1. No plaintext
system content is written in agent home.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import errno
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import types

POLICY_DIRECTORY = Path("/etc/novsky/backup-context")
SYSTEMD_DIRECTORY = Path("/etc/systemd/system")
SYSTEMD_VENDOR_DIRECTORIES = (Path("/usr/lib/systemd/system"), Path("/lib/systemd/system"))
CODEX_DIRECTORY = Path("/etc/novsky/codex")
CLAUDE_DIRECTORY = Path("/etc/claude-tg-starter")
CRON_DIRECTORY = Path("/etc/cron.d")
SANITIZER = Path("/usr/local/lib/novsky-backup/agent-backup-sanitize")
PRIVACY_POLICY = "no-secrets-v1"
PROFILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
UNIT = re.compile(r"^[A-Za-z0-9_.:-]+(?:@[A-Za-z0-9_.:-]*)?\.service$")
RECIPIENT = re.compile(r"^age1[023456789acdefghjklmnpqrstuvwxyz]{58}$")
INSTALLATION = re.compile(r"^[a-z0-9][a-z0-9_-]{7,79}$")
SOURCE_LIMIT = 32 * 1024 * 1024
TOTAL_LIMIT = 128 * 1024 * 1024
IO_SIZE = 1024 * 1024
ARCHIVE_NAME = "system-context.tar.gz.age"
RECEIPT_NAME = "system-context.json"
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class ContextError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _normal_path(value, code):
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ContextError(code)
    path = Path(value)
    if not path.is_absolute() or str(path) != value or ".." in path.parts or path == Path("/"):
        raise ContextError(code)
    return path


def _root_metadata(info, *, directory=False):
    valid_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if (not valid_type or info.st_uid != 0 or info.st_mode & 0o022
            or not directory and info.st_nlink != 1):
        raise ContextError("root-path-unsafe" if directory else "root-file-unsafe")


def _agent_directory_metadata(info, owners, *, private=False):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in owners
            or info.st_mode & (0o077 if private else 0o022)):
        raise ContextError("agent-path-unsafe")


class _Directories:
    """Keep directory descriptors pinned; never follow path components on writes."""
    def __init__(self):
        self.fds = [os.open("/", DIRECTORY_FLAGS)]
        self.links = []
        _root_metadata(os.fstat(self.fds[0]), directory=True)

    @property
    def fd(self):
        return self.fds[-1]

    def push(self, name, *, owners=None, gid=None, create=False, private=False):
        created = False
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=self.fd)
                created = True
            except FileExistsError:
                pass
        try:
            descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=self.fd)
        except FileNotFoundError:
            raise
        except OSError:
            raise ContextError("root-path-unsafe" if owners is None else "agent-path-unsafe") from None
        try:
            info = os.fstat(descriptor)
            if created:
                if not stat.S_ISDIR(info.st_mode) or info.st_uid not in {0, *owners}:
                    raise ContextError("agent-path-unsafe")
                os.fchown(descriptor, next(iter(owners)), gid)
                info = os.fstat(descriptor)
            if owners is None:
                _root_metadata(info, directory=True)
            else:
                _agent_directory_metadata(info, owners, private=private)
        except Exception:
            os.close(descriptor)
            raise
        self.links.append((self.fd, name, descriptor, owners, private))
        self.fds.append(descriptor)
        return self

    def walk(self, path, *, owners=None):
        for part in path.parts[1:]:
            self.push(part, owners=owners)
        return self

    def verify(self):
        for parent, name, descriptor, owners, private in self.links:
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                pinned = os.fstat(descriptor)
            except OSError:
                raise ContextError("output-parent-changed") from None
            if (not stat.S_ISDIR(current.st_mode)
                    or (current.st_dev, current.st_ino) != (pinned.st_dev, pinned.st_ino)):
                raise ContextError("output-parent-changed")
            if owners is None:
                _root_metadata(pinned, directory=True)
            else:
                _agent_directory_metadata(pinned, owners, private=private)

    def close(self):
        for descriptor in reversed(self.fds):
            os.close(descriptor)
        self.fds.clear()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _read_small(directory, name, *, uid=None):
    code = "root-file-unsafe" if uid is None else "agent-config-unsafe"
    try:
        descriptor = os.open(name, READ_FLAGS, dir_fd=directory)
    except FileNotFoundError:
        raise
    except OSError:
        raise ContextError(code) from None
    with os.fdopen(descriptor, "rb") as stream:
        initial = os.fstat(stream.fileno())
        if uid is None:
            _root_metadata(initial)
        elif (not stat.S_ISREG(initial.st_mode) or initial.st_uid != uid
              or initial.st_nlink != 1 or initial.st_mode & 0o077):
            raise ContextError(code)
        if initial.st_size > 128 * 1024:
            raise ContextError(code)
        data = stream.read(128 * 1024 + 1)
        if len(data) > 128 * 1024 or _fingerprint(initial) != _fingerprint(os.fstat(stream.fileno())):
            raise ContextError(code)
        return data


def _source_archive_name(path, home, unit):
    units = {unit}
    if "@" in unit:
        units.add(unit.split("@", 1)[0] + "@.service")
    for directory in (SYSTEMD_DIRECTORY, *SYSTEMD_VENDOR_DIRECTORIES):
        if not path.is_relative_to(directory):
            continue
        relative = path.relative_to(directory)
        prefix = "system/etc/systemd/system/" if directory == SYSTEMD_DIRECTORY else "system/" + str(directory).lstrip("/") + "/"
        parts = relative.parts
        if len(parts) == 1 and parts[0] in units:
            return prefix + str(relative)
        if (len(parts) == 2 and parts[0] in {name + ".d" for name in units}
                and re.fullmatch(r"[A-Za-z0-9_.-]+\.conf", parts[1])):
            return prefix + str(relative)
    if (path.parent == CODEX_DIRECTORY and path.name.startswith(home.name + ".")
            and re.fullmatch(r"[A-Za-z0-9_.-]+", path.name)):
        return "system/etc/novsky/codex/" + path.name
    env_name = "agent.env" if home.name == "claude" else "agent-" + home.name + ".env"
    if path.parent == CLAUDE_DIRECTORY and path.name == env_name:
        return "system/etc/claude-tg-starter/" + path.name
    cron_name = "novsky-agent-full-backup-" + hashlib.sha256(str(home).encode()).hexdigest()[:24]
    if path.parent == CRON_DIRECTORY and path.name == cron_name:
        return "system/etc/cron.d/" + path.name
    raise ContextError("source-not-allowed")


def load_policy(policy_path):
    path = _normal_path(str(policy_path), "policy-path-invalid")
    if path.parent != POLICY_DIRECTORY or path.suffix != ".json" or not PROFILE.fullmatch(path.stem):
        raise ContextError("policy-path-invalid")
    with _Directories() as directory:
        directory.walk(path.parent)
        raw = _read_small(directory.fd, path.name)
        directory.verify()
    try:
        policy = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ContextError("policy-invalid") from None
    fields = {"schemaVersion", "agentHome", "uid", "gid", "unit", "requiredFiles"}
    if not isinstance(policy, dict) or set(policy) - fields or policy.get("schemaVersion", 1) != 1:
        raise ContextError("policy-invalid")
    home = _normal_path(policy.get("agentHome"), "policy-invalid")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", home.name):
        raise ContextError("policy-invalid")
    for field in ("uid", "gid"):
        value = policy.get(field)
        if type(value) is not int or not 0 <= value < 2 ** 31:
            raise ContextError("policy-invalid")
    unit = policy.get("unit")
    required = policy.get("requiredFiles")
    if (not isinstance(unit, str) or len(unit) > 180 or not UNIT.fullmatch(unit)
            or not isinstance(required, list) or not 1 <= len(required) <= 128
            or any(not isinstance(item, str) for item in required) or len(set(required)) != len(required)):
        raise ContextError("policy-invalid")
    names = {}
    units = {unit}
    if "@" in unit:
        units.add(unit.split("@", 1)[0] + "@.service")
    fragments = {directory / name for directory in (SYSTEMD_DIRECTORY, *SYSTEMD_VENDOR_DIRECTORIES) for name in units}
    for value in required:
        source = _normal_path(value, "source-not-allowed")
        names[value] = _source_archive_name(source, home, unit)
    if not fragments.intersection(Path(item) for item in required):
        raise ContextError("unit-fragment-required")
    return {**policy, "profileId": path.stem, "policySha256": hashlib.sha256(raw).hexdigest(), "sourceNames": names}


def _validate_age(age_binary, home):
    path = _normal_path(str(age_binary), "age-binary-unsafe")
    if path.is_relative_to(home):
        raise ContextError("age-binary-unsafe")
    try:
        with _Directories() as directory:
            directory.walk(path.parent)
            descriptor = os.open(path.name, READ_FLAGS, dir_fd=directory.fd)
            try:
                info = os.fstat(descriptor)
                _root_metadata(info)
                if not info.st_mode & 0o100:
                    raise ContextError("age-binary-unsafe")
                directory.verify()
            finally:
                os.close(descriptor)
    except (OSError, ContextError):
        raise ContextError("age-binary-unsafe") from None
    return path


def _source_stream(path, uid):
    try:
        with _Directories() as directory:
            directory.walk(path.parent)
            descriptor = os.open(path.name, READ_FLAGS, dir_fd=directory.fd)
            try:
                info = os.fstat(descriptor)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid not in {0, uid}
                        or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > SOURCE_LIMIT):
                    raise ContextError("source-unsafe")
                directory.verify()
                return os.fdopen(descriptor, "rb"), info
            except Exception:
                os.close(descriptor)
                raise
    except FileNotFoundError:
        raise ContextError("source-unavailable") from None
    except OSError as error:
        raise ContextError("source-unsafe" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "source-unavailable") from None
    except ContextError as error:
        if error.code.startswith("root-"):
            raise ContextError("source-unsafe") from None
        raise


def _load_sanitizer(home):
    """Execute only bytes read through pinned root-owned directory descriptors."""
    path = _normal_path(str(SANITIZER), "sanitizer-unsafe")
    if path.is_relative_to(home):
        raise ContextError("sanitizer-unsafe")
    try:
        with _Directories() as directory:
            directory.walk(path.parent)
            raw = _read_small(directory.fd, path.name)
            directory.verify()
        module = types.ModuleType("agent_backup_context_sanitize")
        module.__file__ = str(path)
        exec(compile(raw, str(path), "exec"), module.__dict__)
        if (module.POLICY != PRIVACY_POLICY or not callable(module.secret_literals)
                or not callable(module.sanitize_bytes)):
            raise ValueError("unsupported sanitizer")
        return module
    except Exception:
        raise ContextError("sanitizer-unsafe") from None


def _sanitize_sources(sources, sanitizer, policy):
    raw_sources, known = [], set()
    for source, stream, info in sources:
        raw = stream.read(SOURCE_LIMIT + 1)
        if len(raw) != info.st_size or _fingerprint(info) != _fingerprint(os.fstat(stream.fileno())):
            raise ContextError("source-changed")
        raw_sources.append((source, raw, info))
        known.update(sanitizer.secret_literals(raw, path=policy["sourceNames"][str(source)]))
    sanitized, reconnect, excluded = [], {}, []
    redactions = 0
    for source, raw, info in raw_sources:
        result = sanitizer.sanitize_bytes(raw, path=policy["sourceNames"][str(source)], known_secrets=known)
        redactions += result["redactions"]
        for item in result["reconnect"]:
            reconnect[json.dumps(item, sort_keys=True)] = item
        clean = result["data"]
        if clean is None:
            excluded.append({"path": policy["sourceNames"][str(source)], "reason": result["reason"]})
        elif isinstance(clean, bytes):
            sanitized.append((source, clean, info))
        else:
            raise ContextError("sanitization-failed")
    inventory = {"schemaVersion": 1, "privacyPolicy": PRIVACY_POLICY,
                 "integrations": [reconnect[key] for key in sorted(reconnect)]}
    return sanitized, inventory, {"redactions": redactions, "excluded": excluded}


def _safe_output(directory, name, uid):
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or info.st_uid != uid or info.st_mode & 0o077):
        raise ContextError("output-unsafe")


def _new_output(directory):
    for _ in range(5):
        name = ".context-" + secrets.token_hex(16)
        try:
            descriptor = os.open(name, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            return name, descriptor
        except FileExistsError:
            pass
    raise ContextError("output-unavailable")


def _verify_output_identity(directory, name, expected, *, renamed=False):
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except OSError:
        raise ContextError("output-changed") from None
    fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_mode", "st_uid", "st_gid")
    if not renamed:
        fields += ("st_ctime_ns",)
    if (not stat.S_ISREG(current.st_mode) or current.st_nlink != 1 or expected.st_nlink != 1
            or any(getattr(current, field) != getattr(expected, field) for field in fields)):
        raise ContextError("output-changed")


def _add_bundle(archive, sources, policy, recipient, installation, inventory, sanitization):
    created = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    entries = {}
    for source, clean, source_info in sources:
        name = policy["sourceNames"][str(source)]
        parents = list(Path(name).parents)[:-1]
        for parent in reversed(parents):
            relative = str(parent)
            if relative in entries:
                continue
            info = tarfile.TarInfo(relative)
            info.type, info.mode = tarfile.DIRTYPE, 0o700
            archive.addfile(info)
            entries[relative] = {"type": "directory", "mode": 0o700, "size": 0, "mtimeNs": 0}
        info = tarfile.TarInfo(name)
        info.size, info.mode = len(clean), stat.S_IMODE(source_info.st_mode) & 0o777
        info.mtime = source_info.st_mtime_ns / 1_000_000_000
        archive.addfile(info, io.BytesIO(clean))
        entries[name] = {"type": "file", "mode": info.mode, "size": info.size,
                         "mtimeNs": source_info.st_mtime_ns, "sha256": hashlib.sha256(clean).hexdigest()}
    if "system" not in entries:
        info = tarfile.TarInfo("system")
        info.type, info.mode = tarfile.DIRTYPE, 0o700
        archive.addfile(info)
        entries[info.name] = {"type": "directory", "mode": info.mode, "size": 0, "mtimeNs": 0}
    inventory_raw = (json.dumps(inventory, sort_keys=True) + "\n").encode()
    info = tarfile.TarInfo("system/reconnect-inventory.json")
    info.size, info.mode = len(inventory_raw), 0o600
    archive.addfile(info, io.BytesIO(inventory_raw))
    entries[info.name] = {"type": "file", "mode": info.mode, "size": info.size,
                          "mtimeNs": 0, "sha256": hashlib.sha256(inventory_raw).hexdigest()}
    manifest = {"format": "agent-system-context/v1", "createdAt": created, "entries": entries,
                "profileId": policy["profileId"], "installationId": installation, "recipient": recipient,
                "unit": policy["unit"], "sourceHome": policy["agentHome"],
                "privacyPolicy": PRIVACY_POLICY, "secretSanitization": sanitization,
                "reconnectInventory": "system/reconnect-inventory.json"}
    raw = (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode()
    info = tarfile.TarInfo("manifest.json")
    info.size, info.mode = len(raw), 0o600
    archive.addfile(info, io.BytesIO(raw))
    return created


def _capture(policy, age_binary):
    home = Path(policy["agentHome"])
    uid, gid = policy["uid"], policy["gid"]
    age = _validate_age(age_binary, home)
    with _Directories() as directory:
        try:
            directory.walk(home, owners={0, uid})
            if os.fstat(directory.fd).st_uid != uid:
                raise ContextError("agent-path-unsafe")
            for name in (".local", "state", "agent-full-backup"):
                directory.push(name, owners={uid} if name == "agent-full-backup" else {0, uid},
                               private=name == "agent-full-backup")
            config = json.loads(_read_small(directory.fd, "config.json", uid=uid))
        except FileNotFoundError:
            return {"status": "not-prepared", "profileId": policy["profileId"]}
        except (ValueError, UnicodeError):
            raise ContextError("agent-config-invalid") from None
        if not isinstance(config, dict):
            raise ContextError("agent-config-invalid")
        recipient, installation = config.get("recipient"), config.get("installationId")
        if not isinstance(recipient, str) or not RECIPIENT.fullmatch(recipient):
            raise ContextError("recipient-invalid")
        if not isinstance(installation, str) or not INSTALLATION.fullmatch(installation):
            raise ContextError("installation-invalid")
        sanitizer = _load_sanitizer(home)
        directory.push("context", owners={uid}, gid=gid, create=True, private=True)
        for name in (ARCHIVE_NAME, RECEIPT_NAME):
            _safe_output(directory.fd, name, uid)
        sources, temporary = [], []
        process = None
        try:
            total = 0
            for value in sorted(policy["requiredFiles"]):
                source = Path(value)
                stream, info = _source_stream(source, uid)
                sources.append((source, stream, info))
                total += info.st_size
                if total > TOTAL_LIMIT:
                    raise ContextError("sources-too-large")
            sanitized, inventory, sanitization = _sanitize_sources(sources, sanitizer, policy)
            name, descriptor = _new_output(directory.fd)
            temporary.append(name)
            with os.fdopen(descriptor, "w+b") as encrypted:
                process = subprocess.Popen([str(age), "-r", recipient], stdin=subprocess.PIPE,
                                           stdout=encrypted, stderr=subprocess.DEVNULL, cwd="/",
                                           env={"PATH": "/usr/bin:/bin", "HOME": "/", "LANG": "C"})
                try:
                    with tarfile.open(fileobj=process.stdin, mode="w|gz", format=tarfile.PAX_FORMAT) as archive:
                        created = _add_bundle(archive, sanitized, policy, recipient, installation, inventory, sanitization)
                finally:
                    process.stdin.close()
                if process.wait(timeout=60):
                    raise ContextError("encryption-failed")
                encrypted.flush()
                os.fsync(encrypted.fileno())
                encrypted.seek(0)
                digest = hashlib.sha256()
                size = 0
                for block in iter(lambda: encrypted.read(IO_SIZE), b""):
                    digest.update(block)
                    size += len(block)
                if size < 100:
                    raise ContextError("encryption-failed")
                os.fchown(encrypted.fileno(), uid, gid)
                os.fchmod(encrypted.fileno(), 0o600)
                encrypted_info = os.fstat(encrypted.fileno())
            receipt = {"schemaVersion": 1, "format": "agent-system-context-receipt/v1",
                       "profileId": policy["profileId"], "installationId": installation, "recipient": recipient,
                       "createdAt": created, "sha256": digest.hexdigest(), "size": size, "files": len(sanitized),
                       "policySha256": policy["policySha256"], "privacyPolicy": PRIVACY_POLICY,
                       "redactions": sanitization["redactions"], "excludedFiles": len(sanitization["excluded"])}
            receipt_name, receipt_descriptor = _new_output(directory.fd)
            temporary.append(receipt_name)
            with os.fdopen(receipt_descriptor, "wb") as output:
                output.write((json.dumps(receipt, sort_keys=True) + "\n").encode())
                output.flush()
                os.fsync(output.fileno())
                os.fchown(output.fileno(), uid, gid)
                os.fchmod(output.fileno(), 0o600)
                receipt_info = os.fstat(output.fileno())
            directory.verify()
            for _, stream, source_info in sources:
                if _fingerprint(source_info) != _fingerprint(os.fstat(stream.fileno())):
                    raise ContextError("source-changed")
            _verify_output_identity(directory.fd, name, encrypted_info)
            _verify_output_identity(directory.fd, receipt_name, receipt_info)
            for target in (ARCHIVE_NAME, RECEIPT_NAME):
                _safe_output(directory.fd, target, uid)
            os.replace(name, ARCHIVE_NAME, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
            os.replace(receipt_name, RECEIPT_NAME, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
            os.fsync(directory.fd)
            directory.verify()
            _verify_output_identity(directory.fd, ARCHIVE_NAME, encrypted_info, renamed=True)
            _verify_output_identity(directory.fd, RECEIPT_NAME, receipt_info, renamed=True)
            return {"status": "captured", **receipt}
        except (OSError, ValueError, subprocess.TimeoutExpired, tarfile.TarError):
            raise ContextError("context-capture-failed") from None
        finally:
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            for _, stream, _ in sources:
                stream.close()
            for name in temporary:
                try:
                    os.unlink(name, dir_fd=directory.fd)
                except OSError:
                    pass


def capture_policy(policy_path: Path, *, age_binary: Path):
    if os.geteuid() != 0:
        raise ContextError("root-required")
    policy = load_policy(policy_path)
    # Serialize root refreshes separately from agent-controlled backup locks.
    with _Directories() as directory:
        directory.walk(POLICY_DIRECTORY)
        descriptor = os.open(policy["profileId"] + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                             0o600, dir_fd=directory.fd)
        try:
            _root_metadata(os.fstat(descriptor))
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {"status": "busy", "profileId": policy["profileId"]}
            directory.verify()
            return _capture(policy, age_binary)
        finally:
            os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--policy", type=Path, help="Exact installed /etc/novsky/backup-context/<profile>.json")
    group.add_argument("--all", action="store_true", help="Capture all installed policies for root cron")
    parser.add_argument("--age-binary", type=Path, required=True, help="Root-owned age from a digest-pinned official release")
    args = parser.parse_args()
    try:
        if os.geteuid() != 0:
            raise ContextError("root-required")
        paths = [args.policy]
        if args.all:
            with _Directories() as directory:
                directory.walk(POLICY_DIRECTORY)
                paths = [POLICY_DIRECTORY / name for name in sorted(os.listdir(directory.fd)) if name.endswith(".json")]
                directory.verify()
        results = []
        for path in paths:
            try:
                results.append({"ok": True, **capture_policy(path, age_binary=args.age_binary)})
            except Exception as error:
                results.append({"ok": False, "error": error.code if isinstance(error, ContextError) else "context-capture-failed"})
        success = all(item["ok"] for item in results)
        print(json.dumps({"ok": success, "profiles": results} if args.all else results[0]))
        return 0 if success else 1
    except Exception as error:
        print(json.dumps({"ok": False, "error": error.code if isinstance(error, ContextError) else "context-capture-failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
