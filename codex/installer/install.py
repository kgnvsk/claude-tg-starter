#!/usr/bin/env python3
"""Apply a verified native kit to a Novsky-owned account. JSON input via stdin.

The Novsky account/runtime bootstrap stops the named unit and creates a backup
before calling this installer. The kit is activated only after setup succeeds.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import subprocess
import sys
import tempfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    rel = PurePosixPath(relative)
    if not relative or rel.is_absolute() or any(p in ("..", ".", "") for p in relative.split("/")):
        raise ValueError("unsafe payload path")
    current = root
    if root.is_symlink():
        raise ValueError("symlink root")
    for part in rel.parts:
        current /= part
        if current.is_symlink():
            raise ValueError("symlink in installation path")
    return current


def verify(root: Path) -> dict:
    manifest = json.loads(safe_path(root, "manifest.json").read_text())
    if manifest.get("schemaVersion") != 1 or manifest.get("engine") != "codex":
        raise ValueError("unsupported kit manifest")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,50}", manifest.get("productId", "")):
        raise ValueError("invalid kit product")
    expected = manifest["files"]
    actual = set()
    for file in root.rglob("*"):
        if file.is_symlink():
            raise ValueError("symlink in payload")
        if file.is_file() and file != root / "manifest.json":
            actual.add(file.relative_to(root).as_posix())
    if actual != set(expected):
        raise ValueError("payload inventory mismatch")
    for relative, sha in expected.items():
        if digest(safe_path(root, relative).read_bytes()) != sha:
            raise ValueError("payload digest mismatch: " + relative)
    return manifest


def atomic(path: Path, data: bytes | str, uid: int, gid: int, mode: int = 0o600):
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise ValueError("symlink in installation path")
    missing, directory = [], path.parent
    while not directory.exists():
        missing.append(directory)
        directory = directory.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
        os.chown(directory, uid, gid)
    descriptor, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(data.encode() if isinstance(data, str) else data)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(name, mode)
        os.chown(name, uid, gid)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def reconcile(root: Path, home: Path, manifest: dict, previous: dict, uid: int, gid: int) -> dict:
    """Preflight the entire managed tree before writing; preserve owner notes."""
    writes, baseline = [], {}
    preserve = {"workspace/AGENTS.md", "workspace/OWNER.md", "home/.codex/memory/USER.md", "home/.codex/memory/MEMORY.md", "home/.codex/onboarding-state.json"}
    preserved_destinations = set()
    for relative in manifest["files"]:
        if relative.startswith("home/"):
            destination = relative[5:]
        elif relative.startswith("workspace/"):
            destination = "obsidian-vault/" + relative[10:]
        else:
            destination = ".local/share/novsky-kit/" + relative
        path = safe_path(home, destination)
        if relative in preserve:
            preserved_destinations.add(destination)
        data = safe_path(root, relative).read_bytes()
        # Render only executable placeholders with validated, fixed values.
        if relative.startswith("home/bin/"):
            data = data.replace(b"{{AGENT_HOME}}", str(home).encode())
            data = data.replace(b"{{AGENT_NAME}}", b"Novsky")
            data = data.replace(b"{{OWNER_CHAT_ID}}", str(previous["ownerChatId"]).encode())
            data = data.replace(b"{{TIMEZONE}}", previous["timezone"].encode())
            data = data.replace(b"{{CALENDAR_EMAIL}}", b"primary")
            if b"{{" in data and re.search(rb"\{\{[A-Z_]+\}\}", data):
                raise ValueError("unrendered executable: " + relative)
        if path.exists():
            if not path.is_file():
                raise ValueError("non-file installation target")
            existing = path.read_bytes()
            if relative == "workspace/AGENTS.md":
                # Keep existing owner instructions and append one managed pointer.
                if b"NOVSKY.md" not in existing:
                    data = existing.rstrip() + b"\n\nRead NOVSKY.md and ROLE.md for the installed Novsky runtime and role.\n"
                else:
                    continue
            elif relative in preserve:
                continue
            elif digest(existing) not in (digest(data), previous.get("files", {}).get(destination)):
                raise ValueError("locally modified managed file: " + destination)
        if relative not in preserve:
            baseline[destination] = digest(data)
        mode = 0o755 if relative.startswith("home/bin/") or root.joinpath(relative).stat().st_mode & 0o111 else 0o600
        writes.append((path, data, mode))
    # A narrower kit removes only unchanged files owned by the former revision.
    removals = []
    for relative, sha in previous.get("files", {}).items():
        if relative in baseline or relative in preserved_destinations or relative in {"obsidian-vault/AGENTS.md", "obsidian-vault/OWNER.md"}:
            continue
        path = safe_path(home, relative)
        if path.is_file():
            if digest(path.read_bytes()) != sha:
                raise ValueError("modified file from previous kit: " + relative)
            removals.append(path)
    for path, data, mode in writes:
        atomic(path, data, uid, gid, mode)
    for path in removals:
        path.unlink()
    return baseline


def native_config(home: Path, user: str, browser: dict | None, integrations: Path | None = None) -> str:
    rules = {
        str(home / ".codex/auth.json"): "deny",
        str(home / ".codex/config.toml"): "read",
        str(home / ".codex/agents"): "read",
        str(home / ".agents"): "read",
        str(home / "obsidian-vault/.codex"): "read",
        str(home / ".codex/channels/telegram/.env"): "deny",
        str(home / ".codex/memory"): "read",
        str(home / ".codex/channels/telegram/messages.db"): "deny",
        str(home / ".codex/channels/telegram/messages.db-wal"): "deny",
        str(home / ".codex/channels/telegram/messages.db-shm"): "deny",
        str(home / ".local/state/novsky-codex"): "deny",
        str(home / "bin"): "read",
        str(home / ".local/lib"): "read",
        str(home / ".local/bin"): "read",
        str(home / ".npm-global"): "read",
        str(home / ".local/share/novsky-kit"): "read",
        str(home / ".venvs"): "read",
        str(home / ".config"): "deny",
        str(home / ".curlrc"): "deny",
        "/etc/novsky/codex/" + user + ".json": "deny",
    }
    text = 'approval_policy = "on-request"\ndefault_permissions = "novsky-agent"\n\n[permissions.novsky-agent]\nextends = ":workspace"\ndescription = "Workspace tools, private credentials and controlled core memory."\n\n[permissions.novsky-agent.filesystem]\n'
    text += "\n".join(json.dumps(path) + " = " + json.dumps(value) for path, value in rules.items())
    text += '\n\n[permissions.novsky-agent.network]\nenabled = false\n'
    if browser:
        text += '\n[mcp_servers.browser]\ncommand = ' + json.dumps(browser["command"]) + '\nargs = ' + json.dumps(browser["args"]) + '\nstartup_timeout_sec = 60\ntool_timeout_sec = 180\n'
    if integrations:
        text += '\n[mcp_servers.novsky_integrations]\ncommand = "/usr/bin/python3"\nargs = ' + json.dumps([str(home / ".local/share/novsky-kit/installer/integrations.py"), "--inventory", str(integrations)]) + '\nstartup_timeout_sec = 30\ntool_timeout_sec = 900\n'
    return text


def integration_inventory(home: Path, user: str, manifest: dict) -> dict:
    from integrations import SUPPORTED_PROGRAMS
    programs = {}
    for name in sorted(SUPPORTED_PROGRAMS):
        if "home/bin/" + name in manifest["files"]:
            path = safe_path(home, "bin/" + name)
            programs[name] = {"path": str(path), "sha256": digest(path.read_bytes())}
    return {"schema_version": 1, "owner": user, "home": str(home), "workspace": str(home / "obsidian-vault"), "programs": programs}


def starter_configuration(manifest: dict, data: dict, previous: dict) -> dict:
    # A completed installation keeps its owner's choices during an upgrade.
    # New Starter installations include voice and semantic memory as their base.
    if manifest["productId"] != "starter" or previous.get("revision"):
        return data
    key = data.get("openaiApiKey")
    if not isinstance(key, str) or not key.strip():
        raise ValueError("Novsky Starter needs an OpenAI API key for voice and semantic memory")
    if data.get("semanticMemory") is False:
        raise ValueError("Novsky Starter includes semantic memory; enable it before installation")
    return {**data, "semanticMemory": True}


def main():
    data = json.load(sys.stdin)
    user = data["user"]
    if os.geteuid() != 0 or not re.fullmatch(r"codex-[a-z0-9][a-z0-9-]{0,23}", user):
        raise ValueError("a Novsky Codex account is required")
    home = Path("/home") / user
    config_dir = Path("/etc/novsky/codex")
    marker = safe_path(config_dir, user + ".installed.json")
    account = pwd.getpwnam(user)
    if account.pw_uid < 1000 or account.pw_dir != str(home) or json.loads(marker.read_text()).get("user") != user:
        raise ValueError("account is not owned by Novsky")
    if subprocess.run(["systemctl", "is-active", "--quiet", "codex-telegram@" + user + ".service"]).returncode == 0:
        raise ValueError("stop and back up the target agent before installation")
    root = Path(data["payload"])
    manifest = verify(root)
    if manifest["productId"] != data["productId"]:
        raise ValueError("selected product does not match payload")
    state_path = safe_path(config_dir, user + ".managed.json")
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    fresh_starter = manifest["productId"] == "starter" and not previous.get("revision")
    data = starter_configuration(manifest, data, previous)
    owner = str(data["ownerChatId"])
    if not re.fullmatch(r"[1-9][0-9]{0,18}", owner):
        raise ValueError("invalid owner identity")
    timezone = data.get("timezone", "UTC")
    if not re.fullmatch(r"[A-Za-z0-9_+\-/]{1,80}", timezone):
        raise ValueError("invalid timezone")
    previous.update(ownerChatId=owner, timezone=timezone)
    files = reconcile(root, home, manifest, previous, account.pw_uid, account.pw_gid)
    atomic(home / ".local/share/novsky-kit/manifest.json", json.dumps(manifest), account.pw_uid, account.pw_gid)
    # Root-owned baseline is persisted before dependency work so an interrupted
    # first install can retry the same managed files without mistaking them for edits.
    atomic(state_path, json.dumps({**previous, "productId": manifest["productId"], "files": files}), 0, 0)
    safe_env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "NOVSKY_WORKSPACE": str(home / "obsidian-vault"), "PATH": f"{home}/bin:{home}/.local/lib/novsky-node/bin:{home}/.local/lib/novsky-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    from dependencies import install_dependencies
    browser = install_dependencies(root, home, user, manifest, safe_env)
    # Linux bwrap needs directory rule ancestors to exist. In particular a
    # Starter without Python feature venvs must still have the protected root.
    from dependencies import directory
    for relative in ("bin", ".agents", ".codex/agents", "obsidian-vault/.codex", ".local/lib", ".local/bin", ".npm-global", ".local/state/novsky-codex", ".local/share/novsky-kit", ".venvs", ".config"):
        directory(safe_path(home, relative), user)
    inventory_path = safe_path(config_dir, user + ".integrations.json")
    inventory = integration_inventory(home, user, manifest)
    atomic(inventory_path, json.dumps(inventory), 0, account.pw_gid, 0o440)
    project_config = home / "obsidian-vault/.codex/config.toml"
    config_text = native_config(home, user, browser, inventory_path)
    old_config_sha = previous.get("configSha")
    if project_config.exists() and digest(project_config.read_bytes()) not in (digest(config_text.encode()), old_config_sha):
        raise ValueError("local project configuration needs reconciliation")
    atomic(project_config, config_text, account.pw_uid, account.pw_gid)
    atomic(state_path, json.dumps({**previous, "productId": manifest["productId"], "files": files,
                                  "configSha": digest(config_text.encode()), "state": "installing"}), 0, 0)
    from setup import configure
    result = configure(home, user, manifest, safe_env, data)
    if fresh_starter:
        from setup import verify_starter_foundation
        result["foundation"] = verify_starter_foundation(home, user, safe_env)
    config_path = safe_path(config_dir, user + ".json")
    config = json.loads(config_path.read_text())
    config["kit"] = {"home": str(home)}
    from corporate import export_corporate
    corporate = export_corporate(root, home, user, manifest, safe_env)
    if corporate:
        config["corporate"] = corporate
    else:
        config.pop("corporate", None)
    atomic(config_path, json.dumps(config), account.pw_uid, account.pw_gid, 0o400)
    atomic(state_path, json.dumps({"productId": manifest["productId"], "revision": manifest["sourceRevision"], "payload": str(root), "files": files, "configSha": digest(config_text.encode()), "capabilities": result, "state": "ready"}), 0, 0)
    print(json.dumps({"ok": True, "productId": manifest["productId"], "capabilities": result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No raw command output or credential-bearing subprocess exceptions.
        print("Native kit setup failed: " + str(error) if isinstance(error, ValueError) else "Native kit setup failed; inspect the named setup stage.", file=sys.stderr)
        sys.exit(1)
