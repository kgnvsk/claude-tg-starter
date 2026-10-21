#!/usr/bin/python3 -I
"""A root-owned, one-agent cloud -> local Bot API migration operator.

No agent-owned code is imported or sourced by root. HTTP errors deliberately
omit the request URL (it contains a bot token). An attempted cloud logOut is a
durable point of no automatic return, even when its response is lost.
"""
import argparse
import base64
import contextlib
import fcntl
import getpass
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import socket
import stat
import subprocess
import sys
import time
import uuid


TRUSTED_UID = 0
CLOUD_BASE = "https://api.telegram.org"
LOCAL_BASE = "http://127.0.0.1:8081"
CONFIG = Path("/etc/novsky-local-bot-api/config.json")
UNIT = "novsky-telegram-bot-api.service"
TERMINAL = ("aborted-before-logout", "local-running-needs-chat-test")


class Refusal(Exception):
    """A safe, secret-free message suitable for the terminal."""


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextlib.contextmanager
def parent_fd(path, trusted=False):
    """Anchor file operations to real directories, never follow symlink parents."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise Refusal("an absolute, direct path is required")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            if trusted:
                info = os.fstat(fd)
                if info.st_uid not in (0, TRUSTED_UID) or info.st_mode & 0o022:
                    raise Refusal("operator directory must be root-owned and not writable by others")
        yield fd, path.name
    finally:
        os.close(fd)


def read_file(path, absent=False, trusted=False, metadata_only=False):
    try:
        with parent_fd(path, trusted=trusted) as (folder, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (not metadata_only and info.st_size > 16 * 1024 * 1024):
                raise Refusal("unsafe or oversized configuration file")
            if trusted and (info.st_uid != TRUSTED_UID or info.st_mode & 0o022):
                raise Refusal("operator support must be root-owned and not writable by others")
            return b"" if metadata_only else stream.read(), info
    except FileNotFoundError:
        if absent:
            return None, None
        raise Refusal("required file is missing") from None


def cas_file(path, expected, replacement, uid=None, gid=None, mode=0o600):
    """Replace only the exact preimage; anchored rename, fsync, restrictive mode.

    As with the kit's receipts operator, the lifecycle/operator locks serialize
    cooperating writers; the second comparison also refuses intervening edits.
    """
    with parent_fd(path) as (folder, name):
        def current():
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
            except FileNotFoundError:
                return None
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise Refusal("unsafe file; no replacement made")
                return stream.read(16 * 1024 * 1024 + 1)
        if current() != expected:
            raise Refusal("configuration changed; preserving the newer customer state")
        if replacement is None:
            if expected is not None:
                os.unlink(name, dir_fd=folder)
                os.fsync(folder)
            return
        temporary = "." + name + "." + uuid.uuid4().hex
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=folder)
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), mode)
                if uid is not None:
                    os.fchown(stream.fileno(), uid, gid)
                stream.write(replacement)
                stream.flush()
                os.fsync(stream.fileno())
            if current() != expected:
                raise Refusal("configuration changed; preserving the newer customer state")
            os.replace(temporary, name, src_dir_fd=folder, dst_dir_fd=folder)
            os.fsync(folder)
        finally:
            try:
                os.unlink(temporary, dir_fd=folder)
            except FileNotFoundError:
                pass


def packed(data):
    return None if data is None else base64.b64encode(data).decode("ascii")


def unpacked(data):
    return None if data is None else base64.b64decode(data, validate=True)


def env_value(data, key):
    values = []
    for line in data.decode("utf-8").splitlines():
        match = re.fullmatch(r"\s*(?:export\s+)?" + re.escape(key) + r"\s*=\s*(.*?)\s*", line)
        if match:
            value = match[1]
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values.append(value)
    if len(values) > 1:
        raise Refusal("duplicate environment key; fix the configuration before activation")
    return values[0] if values else ""


def endpoint_env(data, root):
    keys = ("TELEGRAM_API_BASE", "TELEGRAM_LOCAL_FILE_ROOT")
    lines = [line for line in data.decode("utf-8").splitlines(keepends=True)
             if not any(re.match(r"\s*(?:export\s+)?" + key + r"\s*=", line) for key in keys)]
    value = "".join(lines)
    if value and not value.endswith("\n"):
        value += "\n"
    return (value + "TELEGRAM_API_BASE=" + LOCAL_BASE + "\nTELEGRAM_LOCAL_FILE_ROOT=" + root + "\n").encode()


def api_unit(config):
    return f"""[Unit]
Description=Private local Telegram Bot API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={config['user']}
Group={config['gid']}
EnvironmentFile={config['config_dir']}/app.env
WorkingDirectory={config['data_dir']}
ExecStart={config['binary']} --local --http-ip-address=127.0.0.1 --http-port=8081 --dir={config['data_dir']} --temp-dir={config['data_dir']}/tmp --verbosity=0
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths={config['data_dir']}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
"""


def is_poller_process(process, target):
    args = (process / "cmdline").read_bytes().split(b"\0")
    if not args or os.path.basename(os.fsdecode(args[0])) != "bun":
        return False
    cwd = None
    for raw in args[1:]:
        if not raw or raw.startswith(b"-"):
            continue
        candidate = os.fsdecode(raw)
        if not os.path.isabs(candidate):
            if cwd is None:
                cwd = os.readlink(process / "cwd")
            candidate = os.path.join(cwd, candidate)
        if os.path.normpath(candidate) == target:
            return True
    return False


class System:
    def __init__(self, config):
        self.c = config

    def command(self, args, data=None, allowed=(0,)):
        try:
            result = subprocess.run(args, input=data, capture_output=True, timeout=60,
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "HOME": "/root"})
        except (OSError, subprocess.TimeoutExpired):
            raise Refusal("a system command failed or timed out; run status") from None
        if result.returncode not in allowed:
            raise Refusal("a system command refused the operation; run status")
        return result

    def active(self, unit):
        result = self.command(["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", unit])
        value = result.stdout.strip()
        if value not in (b"active", b"inactive", b"failed"):
            raise Refusal("service state is changing or unreadable; retry later")
        return value == b"active"

    def action(self, action, unit=None):
        self.command(["/usr/bin/systemctl", action] + ([unit] if unit else []))
        if action in ("start", "stop") and self.active(unit) != (action == "start"):
            raise Refusal("service did not reach the requested state; run status")

    def get_cron(self):
        result = self.command(["/usr/bin/crontab", "-u", self.c["user"], "-l"], allowed=(0, 1))
        if result.returncode:
            if b"no crontab" not in result.stderr.lower():
                raise Refusal("the agent schedule is unreadable")
            return None
        return result.stdout

    def set_cron(self, content):
        command = ["/usr/bin/crontab", "-u", self.c["user"]]
        if content is None:
            if self.get_cron() is not None:
                self.command(command + ["-r"])
        else:
            self.command(command + ["-"], content)
        if self.get_cron() != content:
            raise Refusal("agent schedule readback failed")

    def probe(self, kind, all_processes=False):
        args = {"busy": [self.c["home"], self.c["home"] + "/.claude/channels/telegram/messages.db", self.c["user"]],
                "writers": [self.c["user"], self.c["service"], self.c["home"]]}[kind]
        if all_processes:
            args.append("--all")
        result = self.command(["/usr/sbin/runuser", "-u", self.c["user"], "--", "/usr/bin/python3", "-I",
                               self.c["guard"], kind] + args, allowed=(0, 2, 3))
        if result.returncode:
            raise Refusal("busy or unreadable agent work; let current jobs finish, then retry activate")

    def request(self, base, token, method):
        connection = (http.client.HTTPSConnection("api.telegram.org", timeout=30) if base == CLOUD_BASE
                      else http.client.HTTPConnection("127.0.0.1", 8081, timeout=30))
        try:
            connection.request("POST", "/bot" + token + "/" + method, body=b"")
            response = connection.getresponse()
            data = json.loads(response.read(1024 * 1024))
            if response.status != 200 or data.get("ok") is not True:
                raise Refusal("Bot API request failed; credentials or connectivity need checking")
            return data.get("result")
        except (OSError, http.client.HTTPException, ValueError):
            raise Refusal("Bot API request outcome unknown; retry activate to continue locally") from None
        finally:
            connection.close()

    def listener_ready(self):
        for _ in range(15):
            if not self.active(self.c["api_unit"]):
                raise Refusal("local API did not start; check the installed binary and credentials")
            try:
                with socket.create_connection(("127.0.0.1", 8081), timeout=1):
                    return
            except OSError:
                time.sleep(1)
        raise Refusal("local API did not open its loopback listener")

    def poller_ready(self):
        for _ in range(30):
            matches = 0
            for process in Path("/proc").iterdir():
                if not process.name.isdigit():
                    continue
                try:
                    groups = (process / "cgroup").read_text().splitlines()
                    if not any(line.endswith("/" + self.c["service"]) or "/" + self.c["service"] + "/" in line for line in groups):
                        continue
                    if not is_poller_process(process, self.c["poller"]):
                        continue
                    env = (process / "environ").read_bytes().split(b"\0")
                    if ("TELEGRAM_API_BASE=" + LOCAL_BASE).encode() in env and ("TELEGRAM_LOCAL_FILE_ROOT=" + self.c["data_dir"]).encode() in env:
                        matches += 1
                except (FileNotFoundError, ProcessLookupError):
                    continue
            if matches == 1 and self.active(self.c["service"]):
                return
            if matches > 1:
                raise Refusal("more than one local poller found; retained migration hold")
            time.sleep(2)
        raise Refusal("local poller startup was not verified; retry activate after resolving startup")

    @staticmethod
    def clock():
        return int(time.time())


class Operator:
    def __init__(self, config, system):
        self.c, self.s = config, system
        self.env = Path(config["home"]) / ".claude/channels/telegram/.env"
        self.hold = Path(config["home"]) / "logs/restart-hold.until"
        self.root = Path(config["transaction_dir"])
        self.receipt = self.root / "activation.json"
        self.gate = self.root / "migration-in-progress"
        self.dropins = [Path(config["unit_dir"]) / (unit + ".d/zy-local-bot-api-migration.conf")
                       for unit in [config["service"]] + config["daemons"] + config["timers"]]
        self.link = Path(config["unit_dir"]) / (config["service"] + ".d/50-local-bot-api.conf")

    def save(self, record):
        old, _ = read_file(self.receipt, absent=True)
        cas_file(self.receipt, old, (json.dumps(record, indent=2) + "\n").encode())

    def load(self):
        raw, _ = read_file(self.receipt, absent=True, trusted=True)
        return json.loads(raw) if raw is not None else None

    def prerequisites(self):
        credentials, info = read_file(Path(self.c["config_dir"]) / "app.env", absent=True, trusted=True)
        if credentials is None:
            raise Refusal("application credentials are missing; run sudo novsky-local-bot-api configure")
        if info.st_mode & 0o077:
            raise Refusal("application credentials must have mode 0600")
        if not re.fullmatch(r"[1-9][0-9]{0,9}", env_value(credentials, "TELEGRAM_API_ID")) or not re.fullmatch(r"[0-9a-fA-F]{32}", env_value(credentials, "TELEGRAM_API_HASH")):
            raise Refusal("application credentials are invalid; run configure")
        _, binary_info = read_file(self.c["binary"], trusted=True, metadata_only=True)
        if not binary_info.st_mode & 0o111:
            raise Refusal("the official telegram-bot-api binary is not executable")
        guard, _ = read_file(self.c["guard"], trusted=True)
        if digest(guard) != self.c["guard_sha256"]:
            raise Refusal("the prepared maintenance helper changed; installer review required")
        poller_supported = False
        for entry in self.c["runtime"]:
            source, _ = read_file(entry["path"])
            if digest(source) != entry["sha256"]:
                raise Refusal("prepared runtime changed; installer must refresh the verified runtime inventory")
            if entry["path"] == self.c["poller"]:
                poller_supported = all(key in source for key in (b"TELEGRAM_API_BASE", b"TELEGRAM_LOCAL_FILE_ROOT"))
        if not poller_supported:
            raise Refusal("the selected poller lacks local API and file-root support")
        actual_unit, _ = read_file(Path(self.c["unit_dir"]) / self.c["api_unit"], trusted=True)
        if actual_unit != api_unit(self.c).encode():
            raise Refusal("the local API service changed; installer review required")
        data_info = Path(self.c["data_dir"]).lstat()
        if not stat.S_ISDIR(data_info.st_mode) or data_info.st_uid != self.c["uid"] or data_info.st_mode & 0o077:
            raise Refusal("the local file directory must be private and owned by the agent")
        env, info = read_file(self.env)
        if info.st_uid != self.c["uid"]:
            raise Refusal("the channel environment must be owned by the agent")
        token = env_value(env, "TELEGRAM_BOT_TOKEN")
        if not re.fullmatch(r"[1-9][0-9]*:[A-Za-z0-9_-]+", token):
            raise Refusal("the existing bot token is missing or invalid")
        return env, info, token

    def configure(self, api_id, api_hash):
        if not re.fullmatch(r"[1-9][0-9]{0,9}", api_id) or not re.fullmatch(r"[0-9a-fA-F]{32}", api_hash):
            raise Refusal("invalid API ID or hash format; nothing saved")
        if self.s.active(self.c["api_unit"]):
            record = self.load()
            if not record or record["phase"] != "recovery-local" or self.s.active(self.c["service"]):
                raise Refusal("local API is running; changing its credentials requires an administrator maintenance window")
            if read_file(self.gate)[0] != (record["id"] + "\n").encode():
                raise Refusal("recovery gate changed; retain the current credentials")
            self.s.action("stop", self.c["api_unit"])
        path = Path(self.c["config_dir"]) / "app.env"
        old, _ = read_file(path, absent=True, trusted=True)
        cas_file(path, old, ("TELEGRAM_API_ID=" + api_id + "\nTELEGRAM_API_HASH=" + api_hash + "\n").encode())

    def set_gates(self, record):
        gate_bytes = (record["id"] + "\n").encode()
        current, _ = read_file(self.gate, absent=True)
        if current not in (None, gate_bytes):
            raise Refusal("another migration gate exists")
        cas_file(self.gate, current, gate_bytes)
        for path in self.dropins:
            path.parent.mkdir(mode=0o755, exist_ok=True)
            content = ("[Unit]\nConditionPathExists=!" + str(self.gate) + "\n").encode()
            current, _ = read_file(path, absent=True)
            if current not in (None, content):
                raise Refusal("another service migration condition exists")
            cas_file(path, current, content, mode=0o644)
        self.s.action("daemon-reload")

    def clear_gates(self, record):
        for path in self.dropins:
            content = ("[Unit]\nConditionPathExists=!" + str(self.gate) + "\n").encode()
            current, _ = read_file(path, absent=True)
            if current is not None:
                cas_file(path, content, None)
        current, _ = read_file(self.gate, absent=True)
        if current is not None:
            cas_file(self.gate, (record["id"] + "\n").encode(), None)
        self.s.action("daemon-reload")

    def restore_hold(self, record):
        original = unpacked(record["hold"])
        current, _ = read_file(self.hold, absent=True)
        if current == original:
            return
        cas_file(self.hold, record["new_hold"].encode(), original, self.c["uid"], self.c["gid"])

    def restore_schedule(self, record):
        original = unpacked(record["cron"])
        current = self.s.get_cron()
        if current not in (None, original):
            raise Refusal("agent schedule changed; preserving the newer schedule, migration remains held")
        if current != original:
            self.s.set_cron(original)
        for unit in self.c["daemons"] + self.c["timers"]:
            if record["active"][unit] and not self.s.active(unit):
                self.s.action("start", unit)

    def rollback_before_logout(self, record):
        if self.s.active(self.c["api_unit"]):
            self.s.action("stop", self.c["api_unit"])
        self.clear_gates(record)
        if record["active"][self.c["service"]] and not self.s.active(self.c["service"]):
            self.s.action("start", self.c["service"])
        self.restore_schedule(record)
        self.restore_hold(record)
        record["phase"] = "aborted-before-logout"
        self.save(record)

    @contextlib.contextmanager
    def lifecycle(self):
        path = Path(self.c["home"]) / "logs/transport-lifecycle.lock"
        with parent_fd(path) as (folder, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != self.c["uid"]:
                raise Refusal("unsafe lifecycle lock")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise Refusal("busy lifecycle lock; retry activate later") from None
            yield info
        finally:
            os.close(fd)

    def activate(self):
        env, info, token = self.prerequisites()  # no service/config mutation on missing prerequisites
        record = self.load()
        if record and record["phase"] == "local-running-needs-chat-test":
            if env_value(env, "TELEGRAM_API_BASE") != LOCAL_BASE:
                raise Refusal("completed migration configuration changed; review required")
            self.s.poller_ready()
            return
        if record and not record["logout_started"] and record["phase"] not in TERMINAL:
            self.rollback_before_logout(record)
            record = None
        if not record or record["phase"] in TERMINAL:
            if env_value(env, "TELEGRAM_API_BASE") not in ("", CLOUD_BASE):
                raise Refusal("an existing custom API endpoint requires a separate migration")
            if not self.s.active(self.c["service"]):
                raise Refusal("the cloud bot must be running before first activation")
            if self.s.active(self.c["api_unit"]):
                raise Refusal("the local API already runs outside this migration; review required")
            self.s.probe("busy")
            hold, hold_info = read_file(self.hold, absent=True)
            if hold_info and (hold_info.st_uid != self.c["uid"] or hold_info.st_mode & 0o077):
                raise Refusal("existing restart hold has unexpected ownership or permissions")
            if hold is not None and (not hold.strip().isdigit() or int(hold.strip()) > self.s.clock()):
                raise Refusal("another restart hold exists; leave it in place and retry after maintenance")
            record = {"id": uuid.uuid4().hex, "phase": "preparing", "logout_started": False,
                      "env": packed(env), "env_sha256": digest(env), "env_uid": info.st_uid, "env_gid": info.st_gid,
                      "hold": packed(hold), "new_hold": str(self.s.clock() + 86400) + "\n",
                      "cron": packed(self.s.get_cron()),
                      "active": {unit: self.s.active(unit) for unit in [self.c["service"]] + self.c["daemons"] + self.c["timers"]}}
            self.save(record)
        try:
            if not record["logout_started"]:
                cas_file(self.hold, unpacked(record["hold"]), record["new_hold"].encode(), self.c["uid"], self.c["gid"])
                self.set_gates(record)
                if self.s.get_cron() != unpacked(record["cron"]):
                    raise Refusal("agent schedule changed before suspension")
                self.s.set_cron(None)
                for unit in self.c["timers"] + self.c["daemons"]:
                    if self.s.active(unit):
                        self.s.action("stop", unit)
                self.s.probe("writers")  # existing jobs must drain naturally; never kill an active send
                self.s.action("start", self.c["api_unit"])
                self.s.listener_ready()  # opens no bot session before the cloud logOut
                with self.lifecycle() as locked:
                    self.s.probe("busy")
                    _, current_lock = read_file(Path(self.c["home"]) / "logs/transport-lifecycle.lock", metadata_only=True)
                    if (current_lock.st_dev, current_lock.st_ino) != (locked.st_dev, locked.st_ino):
                        raise Refusal("lifecycle lock changed during the idle check")
                    self.s.action("stop", self.c["service"])
                self.s.probe("writers", all_processes=True)
                if read_file(self.env)[0] != unpacked(record["env"]):
                    raise Refusal("channel environment changed before logout")
                record.update(phase="logout-attempted", logout_started=True, logout_attempted_at=self.s.clock())
                self.save(record)  # fsync BEFORE sending: a lost response must never restart cloud
                if self.s.request(CLOUD_BASE, token, "logOut") is not True:
                    raise Refusal("cloud logout did not return success; continue only through local recovery")
                record["phase"] = "cloud-logged-out"
                record["logout_confirmed"] = True
                self.save(record)
            self.finish_local(record, token)
        except BaseException as error:
            if record["logout_started"]:
                record["phase"] = "recovery-local"
                record["failure"] = str(error) if isinstance(error, Refusal) else "interrupted or system operation failed"
                self.save(record)
                self.set_gates(record)
                for unit in [self.c["service"]] + self.c["timers"] + self.c["daemons"]:
                    if self.s.active(unit):
                        self.s.action("stop", unit)
                current = self.s.get_cron()
                if current == unpacked(record["cron"]):
                    self.s.set_cron(None)
            else:
                self.rollback_before_logout(record)
            raise

    def finish_local(self, record, token):
        before = unpacked(record["env"])
        after = endpoint_env(before, self.c["data_dir"])
        if read_file(self.env)[0] not in (before, after) or token != env_value(before, "TELEGRAM_BOT_TOKEN"):
            raise Refusal("channel environment changed; preserving newer settings and the migration hold")
        self.set_gates(record)
        if self.s.active(self.c["service"]):
            self.s.action("stop", self.c["service"])
        if self.s.get_cron() is not None:
            raise Refusal("agent schedule changed during migration; review it before retrying")
        self.s.probe("writers", all_processes=True)
        if not record.get("logout_confirmed"):
            remaining = record["logout_attempted_at"] + 600 - self.s.clock()
            if remaining > 0:
                raise Refusal("cloud logout outcome is unknown; wait " + str(remaining) + " seconds, then retry activate")
            # A lost request may never have reached Telegram. Do not guess that
            # cloud deregistration happened. Wait out a possible lockout first,
            # then obtain a confirmed logOut while every cloud writer is held.
            record["logout_attempted_at"] = self.s.clock()
            self.save(record)
            if self.s.request(CLOUD_BASE, token, "logOut") is not True:
                raise Refusal("cloud logout did not return success; keep the migration held")
            record.update(phase="cloud-logged-out", logout_confirmed=True)
            self.save(record)
        if not self.s.active(self.c["api_unit"]):
            self.s.action("start", self.c["api_unit"])
        self.s.listener_ready()
        identity = self.s.request(LOCAL_BASE, token, "getMe")
        if not isinstance(identity, dict) or str(identity.get("id")) != token.split(":", 1)[0] or identity.get("is_bot") is not True:
            raise Refusal("local API identity check failed")
        current, _ = read_file(self.env)
        if current != after:
            cas_file(self.env, before, after, record["env_uid"], record["env_gid"])
        dependency = ("[Unit]\nRequires=" + self.c["api_unit"] + "\nAfter=" + self.c["api_unit"] + "\n").encode()
        existing, _ = read_file(self.link, absent=True)
        if existing not in (None, dependency):
            raise Refusal("the bot service dependency changed; preserving it")
        cas_file(self.link, existing, dependency, mode=0o644)
        self.s.action("enable", self.c["api_unit"])
        self.clear_gates(record)
        self.s.action("start", self.c["service"])
        self.s.poller_ready()
        self.restore_schedule(record)
        self.restore_hold(record)
        record["phase"] = "local-running-needs-chat-test"
        record["local_started_at"] = self.s.clock()
        record.pop("failure", None)
        self.save(record)

    def status(self):
        record = self.load()
        credentials, _ = read_file(Path(self.c["config_dir"]) / "app.env", absent=True, trusted=True)
        env, _ = read_file(self.env)
        endpoint = env_value(env, "TELEGRAM_API_BASE")
        return {"phase": record["phase"] if record else "prepared-inactive",
                "credentials_saved": credentials is not None,
                "bot_active": self.s.active(self.c["service"]), "local_api_active": self.s.active(self.c["api_unit"]),
                "endpoint": "local" if endpoint == LOCAL_BASE else "cloud" if endpoint in ("", CLOUD_BASE) else "custom",
                "last_failure": record.get("failure") if record else None,
                "uncertain_logout_retry_after_seconds": max(0, record["logout_attempted_at"] + 600 - self.s.clock())
                    if record and record["logout_started"] and not record.get("logout_confirmed") else None,
                "next": "Send a message and a file larger than 20 MB to the bot; verify its reply."
                        if record and record["phase"] == "local-running-needs-chat-test" else
                        "Run configure, then activate. If busy, let current jobs finish and retry. Recovery continues locally; it never switches back to cloud."}


def private_directory(path, uid=0, gid=0, mode=0o700):
    path = Path(path)
    path.mkdir(mode=mode, parents=False, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (TRUSTED_UID, uid):
        raise Refusal("unsafe prepared directory")
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def prepare(args):
    if CONFIG.exists():
        raise Refusal("already prepared; do not overwrite the existing operator configuration")
    identity = pwd.getpwnam(args.user)
    if identity.pw_uid == 0:
        raise Refusal("a dedicated non-root agent account is required")
    paths = [args.home, args.poller, args.guard_source] + args.runtime
    if any(not re.fullmatch(r"/[A-Za-z0-9_./-]+", path) or ".." in Path(path).parts for path in paths):
        raise Refusal("prepared paths must be absolute and contain no spaces or shell syntax")
    if any(not re.fullmatch(r"[A-Za-z0-9_.@-]+\.service", unit) for unit in [args.service] + args.daemon):
        raise Refusal("invalid prepared service")
    if any(not re.fullmatch(r"[A-Za-z0-9_.@-]+\.timer", unit) for unit in args.timer):
        raise Refusal("invalid prepared timer")
    if args.poller not in args.runtime:
        raise Refusal("the selected --poller must also be listed with --runtime")
    guard, _ = read_file(args.guard_source)
    runtime = [{"path": path, "sha256": digest(read_file(path)[0])} for path in args.runtime]
    poller, _ = read_file(args.poller)
    if not all(key in poller for key in (b"TELEGRAM_API_BASE", b"TELEGRAM_LOCAL_FILE_ROOT")):
        raise Refusal("install and verify the compatible runtime before prepare")
    config = {"user": args.user, "uid": identity.pw_uid, "gid": identity.pw_gid, "home": args.home,
              "service": args.service, "api_unit": UNIT, "daemons": args.daemon, "timers": args.timer,
              "binary": "/usr/local/bin/telegram-bot-api", "guard": "/usr/local/lib/novsky-local-bot-api/guard.py",
              "guard_sha256": digest(guard), "runtime": runtime, "poller": args.poller,
              "config_dir": str(CONFIG.parent), "transaction_dir": "/var/lib/novsky-local-bot-api",
              "data_dir": "/var/lib/novsky-telegram-bot-api", "unit_dir": "/etc/systemd/system"}
    unit_path = Path(config["unit_dir"]) / UNIT
    if read_file(unit_path, absent=True)[0] is not None:
        raise Refusal("a local API service already exists; no installation performed")
    for path in (CONFIG.parent, Path(config["transaction_dir"])):
        private_directory(path)
    private_directory("/usr/local/lib/novsky-local-bot-api", mode=0o755)
    private_directory(config["data_dir"], identity.pw_uid, identity.pw_gid)
    private_directory(Path(config["data_dir"]) / "tmp", identity.pw_uid, identity.pw_gid)
    cas_file(config["guard"], None, guard, mode=0o644)
    source, _ = read_file(Path(__file__).absolute())
    cas_file("/usr/local/sbin/novsky-local-bot-api", None, source, mode=0o755)
    cas_file(unit_path, None, api_unit(config).encode(), mode=0o644)
    cas_file(CONFIG, None, (json.dumps(config, indent=2) + "\n").encode())
    System(config).action("daemon-reload")
    print("Prepared and inactive. Existing cloud bot configuration is unchanged. Next: sudo novsky-local-bot-api configure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    install = sub.add_parser("prepare", help="installer-only: stage an inactive local API")
    install.add_argument("--user", default="claude")
    install.add_argument("--home", default="/home/claude")
    install.add_argument("--service", default="claude-telegram.service")
    install.add_argument("--guard-source", required=True)
    install.add_argument("--runtime", action="append", required=True)
    install.add_argument("--poller", required=True)
    install.add_argument("--daemon", action="append", default=[])
    install.add_argument("--timer", action="append", default=[])
    for command in ("configure", "activate", "status"):
        sub.add_parser(command)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise Refusal("run this operator with sudo")
    os.umask(0o077)
    if args.command == "prepare":
        prepare(args)
        return
    config = json.loads(read_file(CONFIG, trusted=True)[0])
    lock = Path(config["transaction_dir"]) / "operator.lock"
    with parent_fd(lock) as (folder, name):
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=folder)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        operator = Operator(config, System(config))
        if args.command == "configure":
            if not sys.stdin.isatty():
                raise Refusal("configure needs a private interactive terminal; do not pass credentials as arguments")
            api_id = getpass.getpass("Telegram application API ID (hidden): ").strip()
            api_hash = getpass.getpass("Telegram application API hash (hidden): ").strip()
            operator.configure(api_id, api_hash)
            print("Application credentials saved privately. Bot remains on its current endpoint. Next: sudo novsky-local-bot-api activate")
        elif args.command == "activate":
            operator.activate()
            print("Local API and one poller verified. Now send a message and a file larger than 20 MB to the bot and check its reply.")
        else:
            print(json.dumps(operator.status(), indent=2))
    except BlockingIOError:
        raise Refusal("another setup command is running; retry later") from None
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print("Local Bot API: " + str(error), file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, KeyError, KeyboardInterrupt):
        print("Local Bot API: operation stopped. Run sudo novsky-local-bot-api status; retain the private activation receipt.", file=sys.stderr)
        sys.exit(2)
