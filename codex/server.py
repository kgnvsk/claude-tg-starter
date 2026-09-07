#!/usr/bin/env python3
"""Install a self-contained Codex kit on Ubuntu. Secrets arrive on stdin only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import urllib.request
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
CONFIG_DIR = Path("/etc/novsky/codex")
CODEX_VERSION = "0.153.3"
BUN_VERSION = "1.3.9"


def validate_config(value):
    if not isinstance(value, dict):
        raise ValueError("configuration must be a JSON object")
    result = {}
    patterns = {
        "botToken": r"[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,100}",
        "ownerChatId": r"[1-9][0-9]{0,15}",
        "agentName": r"[^\x00-\x1f\x7f]{1,100}",
        "ownerName": r"[^\x00-\x1f\x7f]{1,100}",
        "timezone": r"[A-Za-z0-9_+/-]{1,80}",
        "openaiApiKey": r"sk-[A-Za-z0-9_-]{10,509}",
    }
    for key, pattern in patterns.items():
        text = value.get(key, {"agentName": "Codex", "ownerName": "Owner", "timezone": "UTC"}.get(key))
        if not isinstance(text, str) or not re.fullmatch(pattern, text):
            raise ValueError("invalid or missing " + key)
        result[key] = text
    if int(result["ownerChatId"]) > 9007199254740991:
        raise ValueError("invalid ownerChatId")
    try:
        ZoneInfo(result["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("invalid timezone") from None
    if "model" in value:
        if not isinstance(value["model"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", value["model"]):
            raise ValueError("invalid model")
        result["model"] = value["model"]
    result["user"] = "codex-" + result["botToken"].split(":", 1)[0]
    return result


def verify_payload(root=ROOT):
    # Reuse the same inventory and digest checks as installation in Novsky.
    spec = importlib.util.spec_from_file_location("kit_installer", root / "installer/install.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.verify(root)


def run(command, *, input=None, timeout=120, check=True):
    result = subprocess.run(command, input=input, capture_output=True, text=True,
                            timeout=timeout, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LANG": "C.UTF-8", "DEBIAN_FRONTEND": "noninteractive"})
    if check and result.returncode:
        # Third-party errors can contain URLs with credentials. Do not forward them.
        raise RuntimeError("command failed (exit " + str(result.returncode) + "); retry the reported stage after checking the server")
    return result


def progress(stage):
    print(json.dumps({"stage": stage}), file=sys.stderr, flush=True)


def no_symlinks(path):
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("symlink in installation path")


def owned_account(user, *, required=True):
    import pwd
    if not re.fullmatch(r"codex-[a-z0-9][a-z0-9-]{0,23}", user):
        raise ValueError("invalid agent user")
    home = Path("/home") / user
    marker = CONFIG_DIR / (user + ".installed.json")
    config = CONFIG_DIR / (user + ".json")
    unit = Path("/etc/systemd/system") / ("codex-telegram@" + user + ".service")
    for path in (home, marker, config, unit):
        no_symlinks(path)
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        if required or any(p.exists() for p in (home, marker, config, unit)):
            raise ValueError("agent account is missing or an unowned installation already exists") from None
        return None
    if (account.pw_uid < 1000 or account.pw_dir != str(home) or not marker.is_file()
            or marker.stat().st_uid != 0 or marker.stat().st_mode & 0o022
            or json.loads(marker.read_text()) != {"engine": "codex", "user": user}):
        raise ValueError("existing account is not owned by Novsky Codex")
    return account


def preflight_config(config):
    owned_account(config["user"], required=False)
    for path in CONFIG_DIR.glob("*.json"):
        no_symlinks(path)
        # Marker, inventory and managed-state files contain no bot token.
        existing = json.loads(path.read_text())
        if not isinstance(existing, dict) or "botToken" not in existing:
            continue
        same_bot = str(existing["botToken"]).split(":", 1)[0] == config["botToken"].split(":", 1)[0]
        if same_bot and path.name != config["user"] + ".json":
            raise ValueError("this Telegram bot is already assigned to another agent")
        if path.name == config["user"] + ".json" and (
                existing.get("botToken") != config["botToken"] or str(existing.get("ownerChatId")) != config["ownerChatId"]):
            raise ValueError("existing agent identity differs; installation cannot replace its owner or bot")


def telegram(token, method):
    try:
        with urllib.request.urlopen("https://api.telegram.org/bot" + token + "/" + method, timeout=30) as response:
            data = json.loads(response.read(1_000_000))
        if data.get("ok") is not True:
            raise ValueError()
        return data["result"]
    except Exception:
        raise RuntimeError("Telegram preflight failed; check the bot token and server network") from None


def check_telegram(config):
    identity = telegram(config["botToken"], "getMe")
    if str(identity.get("id")) != config["botToken"].split(":", 1)[0]:
        raise ValueError("Telegram bot identity mismatch")
    if telegram(config["botToken"], "getWebhookInfo").get("url"):
        raise ValueError("Telegram bot has a webhook; choose an unused bot or explicitly migrate it first")


def require_server():
    if platform.system() != "Linux" or os.geteuid() != 0:
        raise ValueError("this command requires root on Ubuntu 22.04 or 24.04; verify works locally")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if release.get("ID", "").strip('"') != "ubuntu" or release.get("VERSION_ID", "").strip('"') not in ("22.04", "24.04"):
        raise ValueError("supported servers: Ubuntu 22.04 and 24.04")
    if platform.machine() not in ("x86_64", "aarch64") or not Path("/run/systemd/system").is_dir():
        raise ValueError("x86_64 or arm64 server with systemd is required")


@contextmanager
def agent_lock(user):
    import fcntl
    path = Path("/run/lock") / ("novsky-install-" + user + ".lock")
    no_symlinks(path)
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if info.st_uid != 0 or info.st_mode & 0o077:
            raise ValueError("unsafe installation lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("another installation or login is already running for this agent") from None
        yield
    finally:
        os.close(fd)


def as_user(user, command):
    home = "/home/" + user
    return ["runuser", "-u", user, "--", "env", "-i", "HOME=" + home,
            "CODEX_HOME=" + home + "/.codex", "LANG=C.UTF-8",
            "PATH=" + home + "/.local/lib/novsky-node/bin:" + home + "/.local/lib/novsky-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", *command]


def install(config, root=ROOT):
    manifest = verify_payload(root)
    preflight_config(config)
    check_telegram(config)
    user = config["user"]
    home = Path("/home") / user
    with agent_lock(user):
        preflight_config(config)
        state = CONFIG_DIR / (user + ".managed.json")
        no_symlinks(state)
        previous = json.loads(state.read_text()) if state.exists() else {}
        if not isinstance(previous, dict) or not isinstance(previous.get("files", {}), dict):
            raise ValueError("invalid existing managed state")
        maintenance = bool(previous.get("revision"))
        native = {**config, "payload": str(root), "productId": manifest["productId"],
                  "maintenance": maintenance, **({} if maintenance else {"semanticMemory": True})}
        if (CONFIG_DIR / (user + ".json")).is_file():
            progress("checking-existing-installation")
            run(["python3", str(root / "installer/install.py")],
                input=json.dumps({**native, "action": "plan"}), timeout=120)
        progress("server-packages")
        run(["apt-get", "-o", "DPkg::Lock::Timeout=120", "update", "-qq"], timeout=600)
        run(["apt-get", "-o", "DPkg::Lock::Timeout=120", "install", "-y", "-qq", "ca-certificates", "python3", "xz-utils"], timeout=600)
        progress("backup-and-agent-account")
        runtime = {key: value for key, value in config.items() if key not in ("user", "timezone")}
        runtime.update(workspace=str(home / "obsidian-vault"), stateDir=str(home / ".local/state/novsky-codex"),
                       logDir=str(home / "logs"), codexBin=str(home / ".local/lib/novsky-runtime/node_modules/.bin/codex"))
        bootstrap = run(["python3", str(root / "server-bootstrap.py")], input=json.dumps({
            "user": user, "config": runtime, "runtime": {"main.ts": (root / "runtime/main.js").read_text()}, "kit": {},
        }), timeout=600)
        backup = json.loads(bootstrap.stdout)["backup"]
        # Print the recovery location before network-dependent setup starts.
        print(json.dumps({"backup": backup, "user": user}), file=sys.stderr, flush=True)
        progress("agent-local-node-codex-bun")
        run(as_user(user, ["python3", "-"]), input=(root / "installer/install-node.py").read_text(), timeout=600)
        run(as_user(user, ["npm", "install", "--prefix", str(home / ".local/lib/novsky-runtime"),
                           "--no-audit", "--no-fund", "@openai/codex@" + CODEX_VERSION, "bun@" + BUN_VERSION]), timeout=900)
        progress("memory-skills-tools-and-permissions")
        # The canonical installer owns dependency setup, preservation of local
        # edits, native discovery and all three equal-capability worker sessions.
        result = run(["python3", str(root / "installer/install.py")], input=json.dumps(native), timeout=2700)
        report = json.loads(result.stdout)
        return {"ok": True, "state": "installed-awaiting-login", "user": user, "backup": backup,
                "revision": manifest["sourceRevision"], "productId": manifest["productId"],
                "capabilities": report["capabilities"], "next": ["login", "start", "verify-reply"]}


def timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError, OverflowError):
        return 0


def ready(health, *, pid, since=0, now=None):
    now = time.time() if now is None else now
    written = timestamp(health.get("timestamp"))
    return bool(pid and health.get("pid") == pid and max(since, now - 60) <= written <= now + 5
                and health.get("service_active") is True and health.get("codex_authenticated") is True
                and health.get("gateway", {}).get("poller") == "ok")


def status(user, *, since=0):
    owned_account(user)
    unit = "codex-telegram@" + user + ".service"
    result = run(["systemctl", "show", unit, "--property=ActiveState,MainPID,ExecMainStatus"], check=False)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    path = Path("/home") / user / "logs/health-state.json"
    no_symlinks(path)
    try:
        health = json.loads(path.read_text())
        if not isinstance(health, dict):
            health = {}
    except (OSError, ValueError):
        health = {}
    pid = int(fields.get("MainPID", "0"))
    connected = fields.get("ActiveState") == "active" and ready(health, pid=pid, since=since)
    # Only a fixed public status projection, never log tails/configuration.
    return {"ok": bool(connected), "user": user, "service": fields.get("ActiveState", "unknown"),
            "exitCode": fields.get("ExecMainStatus"), "telegramReady": bool(connected),
            "lastReplyAt": health.get("last_reply_at"), "checkedAt": health.get("timestamp")}


def login(user):
    owned_account(user)
    with agent_lock(user):
        if run(as_user(user, ["codex", "login", "status"]), check=False).returncode == 0:
            return {"ok": True, "state": "already-authenticated", "user": user}
        # Interactive official device auth; no credential copying or saved login log.
        result = subprocess.run(as_user(user, ["codex", "login", "--device-auth"]), timeout=1200)
        if result.returncode or run(as_user(user, ["codex", "login", "status"]), check=False).returncode:
            raise ValueError("Codex sign-in was not completed")
        return {"ok": True, "state": "authenticated", "user": user}


def start(user):
    owned_account(user)
    with agent_lock(user):
        state = CONFIG_DIR / (user + ".managed.json")
        no_symlinks(state)
        if json.loads(state.read_text()).get("state") != "ready":
            raise ValueError("kit setup is incomplete; finish install before starting the bot")
        if run(as_user(user, ["codex", "login", "status"]), check=False).returncode:
            raise ValueError("run login first using the recipient's own ChatGPT account")
        since = time.time()
        progress("waiting-for-fresh-telegram-health")
        run(["systemctl", "enable", "--now", "codex-telegram@" + user + ".service"])
        for _ in range(70):
            report = status(user, since=since)
            if report["ok"]:
                return {**report, "realReplyVerified": False, "next": "send text, voice and file in Telegram; use verify-reply"}
            if report["exitCode"] == "78" and report["service"] != "active":
                raise ValueError("Telegram rejected this poller (conflicting bot process, token or webhook); it was not restarted in a loop")
            time.sleep(2)
        raise ValueError("no fresh authenticated Telegram poll within 140 seconds; inspect status before retrying")


def verify_reply(user, timeout):
    owned_account(user)
    since = time.time()
    baseline = status(user).get("lastReplyAt")
    progress("send-a-new-message-in-telegram-now")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        report = status(user)
        replied = report.get("lastReplyAt")
        if report["ok"] and replied != baseline and timestamp(replied) >= since:
            return {**report, "realReplyVerified": True}
        time.sleep(2)
    raise ValueError("no new Telegram reply was confirmed; installation is not yet accepted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("verify", "install", "login", "start", "status", "verify-reply"))
    parser.add_argument("--user")
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()
    if args.command == "verify":
        manifest = verify_payload()
        report = {"ok": True, "productId": manifest["productId"], "revision": manifest["sourceRevision"], "files": len(manifest["files"])}
    else:
        require_server()
        if args.command == "install":
            data = sys.stdin.read(32769)
            if len(data) > 32768:
                raise ValueError("configuration is too large")
            try:
                config = validate_config(json.loads(data))
            except json.JSONDecodeError:
                raise ValueError("invalid configuration JSON") from None
            report = install(config)
        else:
            if not args.user or not 10 <= args.timeout <= 900:
                raise ValueError("--user is required; --timeout must be between 10 and 900 seconds")
            report = {"login": login, "start": start, "status": status,
                      "verify-reply": lambda user: verify_reply(user, args.timeout)}[args.command](args.user)
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, RuntimeError) as error:
        print("Standalone installation: " + str(error), file=sys.stderr)
        sys.exit(1)
    except (Exception, KeyboardInterrupt):
        print("Standalone installation interrupted or failed; no credentials are included in this report.", file=sys.stderr)
        sys.exit(1)
