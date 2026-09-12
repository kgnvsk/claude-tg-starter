#!/usr/bin/env python3
"""Apply a verified native kit to a Novsky-owned account. JSON input via stdin.

The install action requires the caller to stop the named unit and create a
backup. Plan and license-preflight run without stopping or changing the agent.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import subprocess
import sys
import tempfile


def license_helper():
    # Installed payloads carry the exact shared helper beside this installer.
    # The source-tree fallback is for repository checks and local kit building.
    path = Path(__file__).resolve().with_name("agent_license.py")
    if not path.is_file():
        path = Path(__file__).resolve().parents[1] / "assets/lib/agent-license.py"
    spec = importlib.util.spec_from_file_location("agent_license", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assert_stopped(unit: str):
    result = subprocess.run(["systemctl", "show", unit, "--property=LoadState,ActiveState,MainPID"],
                            capture_output=True, text=True, timeout=15)
    fields = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    # Missing first-install units can return nonzero. An empty or failed D-Bus
    # query, incomplete state, or a surviving process never proves a safe stop.
    if (fields.get("LoadState") not in ("loaded", "not-found")
            or (result.returncode and fields["LoadState"] != "not-found")
            or fields.get("ActiveState") not in ("inactive", "failed")
            or fields.get("MainPID") != "0"):
        raise ValueError("target agent stop was not confirmed; no runtime update was attempted")


def safe_path(root: Path, relative: str) -> Path:
    rel = PurePosixPath(relative)
    if not relative or rel.is_absolute() or any(p in ("..", ".", "") for p in relative.split("/")):
        raise ValueError("unsafe payload path")
    current = root
    if any(path.is_symlink() for path in (root, *root.parents)):
        raise ValueError("symlink root")
    for part in rel.parts:
        current /= part
        if current.is_symlink():
            raise ValueError("symlink in installation path")
    if any(path.exists() and not path.is_dir() for path in current.parents):
        raise ValueError("non-directory installation parent")
    return current


def verify(root: Path) -> dict:
    manifest = json.loads(safe_path(root, "manifest.json").read_text())
    if manifest.get("schemaVersion") != 1 or manifest.get("engine") != "codex":
        raise ValueError("unsupported kit manifest")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,50}", manifest.get("productId", "")):
        raise ValueError("invalid kit product")
    if not isinstance(manifest.get("sourceRevision"), str) or not re.fullmatch(r"[0-9a-f]{40}", manifest["sourceRevision"]):
        raise ValueError("invalid kit revision")
    for field in ("features", "nativePlugins", "nativeSkills", "nativeAgents"):
        if not isinstance(manifest.get(field), list) or any(not isinstance(value, str) for value in manifest[field]):
            raise ValueError("invalid kit " + field)
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


def target_change(path: Path, data: bytes | str | None = None, mode: int | None = None) -> dict:
    if path.exists() and not path.is_file():
        raise ValueError("non-file installation target")
    if not path.exists():
        action = "create"
    elif data is not None and path.read_bytes() == (data.encode() if isinstance(data, str) else data) and (mode is None or path.stat().st_mode & 0o777 == mode):
        action = "unchanged"
    else:
        action = "update"
    return {"path": str(path), "action": action}


def skill_destination(home: Path, relative: str) -> str:
    """Follow the owner's enabled/disabled directory without activating a skill."""
    parts = PurePosixPath(relative).parts
    if len(parts) < 4 or parts[0] != ".agents" or parts[1] not in ("skills", "skills.disabled"):
        return relative
    active = safe_path(home, ".agents/skills/" + parts[2])
    disabled = safe_path(home, ".agents/skills.disabled/" + parts[2])
    if active.exists() and disabled.exists():
        raise ValueError("skill is both enabled and disabled: " + parts[2])
    for directory in (active, disabled):
        if directory.exists() and not directory.is_dir():
            raise ValueError("non-directory skill target")
    directory = disabled if disabled.exists() else active
    return (directory.relative_to(home) / Path(*parts[3:])).as_posix()


def plan_reconcile(root: Path, home: Path, manifest: dict, previous: dict) -> dict:
    """Read every managed target and ownership conflict without creating files."""
    writes, baseline, targets = [], {}, []
    previous_files = {}
    for relative, sha in previous.get("files", {}).items():
        destination = skill_destination(home, relative)
        if destination in previous_files:
            raise ValueError("duplicate managed skill baseline")
        previous_files[destination] = sha
    preserve = {"workspace/AGENTS.md", "workspace/OWNER.md", "home/.codex/memory/USER.md", "home/.codex/memory/MEMORY.md", "home/.codex/onboarding-state.json"}
    preserved_destinations = set()
    for relative in manifest["files"]:
        if relative.startswith("home/"):
            destination = relative[5:]
        elif relative.startswith("workspace/"):
            destination = "obsidian-vault/" + relative[10:]
        else:
            destination = ".local/share/novsky-kit/" + relative
        destination = skill_destination(home, destination)
        path = safe_path(home, destination)
        if relative in preserve:
            preserved_destinations.add(destination)
        data = safe_path(root, relative).read_bytes()
        mode = 0o755 if relative.startswith("home/bin/") or root.joinpath(relative).stat().st_mode & 0o111 else 0o600
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
                    targets.append({"path": str(path), "action": "preserve"})
                    continue
            elif relative in preserve:
                targets.append({"path": str(path), "action": "preserve"})
                continue
            elif digest(existing) not in (digest(data), previous_files.get(destination)):
                raise ValueError("locally modified managed file: " + destination)
        if relative not in preserve:
            baseline[destination] = digest(data)
        change = target_change(path, data, mode)
        targets.append(change)
        writes.append((path, data, mode))
    # A narrower kit removes only unchanged files owned by the former revision.
    removals = []
    for relative, sha in previous_files.items():
        if relative in baseline or relative in preserved_destinations or relative in {"obsidian-vault/AGENTS.md", "obsidian-vault/OWNER.md"}:
            continue
        path = safe_path(home, relative)
        if path.exists() and not path.is_file():
            raise ValueError("non-file installation target")
        if path.is_file():
            if digest(path.read_bytes()) != sha:
                raise ValueError("modified file from previous kit: " + relative)
            removals.append(path)
            targets.append({"path": str(path), "action": "remove"})
    return {"writes": writes, "removals": removals, "files": baseline, "targets": targets}


def apply_reconcile(plan: dict, uid: int, gid: int) -> dict:
    for path, data, mode in plan["writes"]:
        atomic(path, data, uid, gid, mode)
    for path in plan["removals"]:
        path.unlink()
    return plan["files"]


def reconcile(root: Path, home: Path, manifest: dict, previous: dict, uid: int, gid: int) -> dict:
    return apply_reconcile(plan_reconcile(root, home, manifest, previous), uid, gid)


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


def integration_inventory(home: Path, user: str, manifest: dict, files: dict | None = None) -> dict:
    from integrations import SUPPORTED_PROGRAMS
    programs = {}
    for name in sorted(SUPPORTED_PROGRAMS):
        if "home/bin/" + name in manifest["files"]:
            path = safe_path(home, "bin/" + name)
            programs[name] = {"path": str(path), "sha256": files["bin/" + name] if files is not None else digest(path.read_bytes())}
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
    action = data.get("action", "install")
    if action not in ("install", "plan", "license-preflight"):
        raise ValueError("unsupported installation action")
    # Read-only actions must not create import caches in the verified payload.
    sys.dont_write_bytecode = True
    user = data["user"]
    if os.geteuid() != 0 or not re.fullmatch(r"codex-[a-z0-9][a-z0-9-]{0,23}", user):
        raise ValueError("a Novsky Codex account is required")
    home = Path("/home") / user
    config_dir = Path("/etc/novsky/codex")
    marker = safe_path(config_dir, user + ".installed.json")
    account = pwd.getpwnam(user)
    if account.pw_uid < 1000 or account.pw_dir != str(home) or json.loads(marker.read_text()).get("user") != user:
        raise ValueError("account is not owned by Novsky")
    if action == "install":
        assert_stopped("codex-telegram@" + user + ".service")
    root = Path(data["payload"])
    manifest = verify(root)
    if manifest["productId"] != data["productId"]:
        raise ValueError("selected product does not match payload")
    state_path = safe_path(config_dir, user + ".managed.json")
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if not isinstance(previous, dict) or not isinstance(previous.get("files", {}), dict):
        raise ValueError("invalid existing managed state")
    config_path = safe_path(config_dir, user + ".json")
    config = json.loads(config_path.read_text())
    if not isinstance(config, dict):
        raise ValueError("invalid existing runtime configuration")
    if action == "license-preflight" or data.get("maintenance") is True:
        # Use the current runtime token for both activation and Telegram
        # configuration; an old setup request must not restore a revoked token.
        data = {**data, "botToken": config.get("botToken")}
    fresh_starter = manifest["productId"] == "starter" and not previous.get("revision")
    data = starter_configuration(manifest, data, previous)
    from setup import configure, plan_configuration
    configuration = plan_configuration(home, data, previous)
    data = configuration["data"]
    previous = {**previous, "ownerChatId": data["ownerChatId"], "timezone": data["timezone"]}
    plan = plan_reconcile(root, home, manifest, previous)
    files = plan["files"]
    manifest_path = safe_path(home, ".local/share/novsky-kit/manifest.json")
    inventory_path = safe_path(config_dir, user + ".integrations.json")
    inventory = integration_inventory(home, user, manifest, files)
    project_config = safe_path(home, "obsidian-vault/.codex/config.toml")
    # The browser launcher's path is fixed by dependencies.install_browser; it
    # does not require package installation to render and validate this config.
    browser = {"command": "/usr/local/bin/novsky-browser-" + user, "args": []} if "browser" in manifest["features"] else None
    config_text = native_config(home, user, browser, inventory_path)
    target_change(project_config, config_text)
    if project_config.exists() and digest(project_config.read_bytes()) not in (digest(config_text.encode()), previous.get("configSha")):
        raise ValueError("local project configuration needs reconciliation")
    directories = ("bin", ".agents", ".codex/agents", "obsidian-vault/.codex", ".local/lib", ".local/bin", ".npm-global", ".local/state/novsky-codex", ".local/share/novsky-kit", ".venvs", ".config")
    for relative in directories:
        path = safe_path(home, relative)
        if path.exists() and not path.is_dir():
            raise ValueError("non-directory installation target")
    generated = [(manifest_path, json.dumps(manifest), 0o600), (inventory_path, json.dumps(inventory), 0o440),
                 (project_config, config_text, 0o600), *configuration["writes"]]
    targets = [*plan["targets"], *(target_change(path, content, mode) for path, content, mode in generated),
               target_change(state_path), target_change(config_path),
               *({"path": str(path), "action": "preserve"} for path in configuration["preserved"])]
    if action == "plan":
        print(json.dumps({"ok": True, "action": "plan", "coverage": "managed-files", "productId": manifest["productId"],
                          "revision": manifest["sourceRevision"],
                          "changes": {name: sum(target["action"] == name for target in targets) for name in ("create", "update", "remove", "preserve", "unchanged")},
                          "targets": sorted(targets, key=lambda target: target["path"]),
                          "compatibility": {"engine": "codex", "previousProductId": previous.get("productId"),
                                            "previousRevision": previous.get("revision"), "ownerAccess": configuration["ownerAccess"],
                                            "projectConfig": "compatible", "requiresStoppedAgent": True}}))
        return
    licensing = None
    if manifest["productId"] != "starter":
        licensing = license_helper()
        key_path = safe_path(config_dir, user + ".license-key")
        key = data.get("licenseKey") or licensing.read_key(key_path)
        licensing.activate(key=key, bot_token=data.get("botToken") or config.get("botToken"),
                           product=manifest["productId"], machine=data.get("machine"))
    if action == "license-preflight":
        print(json.dumps({"ok": True, "action": action, "productId": manifest["productId"],
                          "revision": manifest["sourceRevision"]}))
        return
    if licensing:
        licensing.store_key(key_path, key)
    # Every managed path, config conflict and owner check above is read-only.
    # Dependency installation and native discovery still need runtime checks.
    apply_reconcile(plan, account.pw_uid, account.pw_gid)
    atomic(manifest_path, json.dumps(manifest), account.pw_uid, account.pw_gid)
    # Root-owned baseline is persisted before dependency work so an interrupted
    # first install can retry the same managed files without mistaking them for edits.
    atomic(state_path, json.dumps({**previous, "productId": manifest["productId"], "files": files}), 0, 0)
    safe_env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "NOVSKY_WORKSPACE": str(home / "obsidian-vault"), "PATH": f"{home}/bin:{home}/.local/lib/novsky-node/bin:{home}/.local/lib/novsky-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    from dependencies import install_dependencies
    install_dependencies(root, home, user, manifest, safe_env)
    # Linux bwrap needs directory rule ancestors to exist. In particular a
    # Starter without Python feature venvs must still have the protected root.
    from dependencies import directory
    for relative in directories:
        directory(safe_path(home, relative), user)
    atomic(inventory_path, json.dumps(inventory), 0, account.pw_gid, 0o440)
    atomic(project_config, config_text, account.pw_uid, account.pw_gid)
    atomic(state_path, json.dumps({**previous, "productId": manifest["productId"], "files": files,
                                  "configSha": digest(config_text.encode()), "state": "installing"}), 0, 0)
    result = configure(home, user, manifest, safe_env, data, configuration)
    if fresh_starter:
        from setup import verify_starter_foundation
        result["foundation"] = verify_starter_foundation(home, user, safe_env)
    config["kit"] = {"home": str(home)}
    from corporate import export_corporate
    corporate = export_corporate(root, home, user, manifest, safe_env)
    if corporate:
        config["corporate"] = corporate
    else:
        config.pop("corporate", None)
    atomic(config_path, json.dumps(config), account.pw_uid, account.pw_gid, 0o400)
    collector = subprocess.run(["python3", str(root / "installer/install-backup-context.py"),
                                "--home", str(home), "--user", user,
                                "--unit", "codex-telegram@" + user + ".service", "--engine", "codex"],
                               capture_output=True, timeout=180)
    if collector.returncode:
        raise ValueError("encrypted backup context installation failed")
    atomic(state_path, json.dumps({"productId": manifest["productId"], "revision": manifest["sourceRevision"], "payload": str(root), "files": files, "configSha": digest(config_text.encode()), "capabilities": result, "state": "ready"}), 0, 0)
    print(json.dumps({"ok": True, "productId": manifest["productId"], "capabilities": result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No raw command output or credential-bearing subprocess exceptions.
        print("Native kit setup failed: " + str(error) if isinstance(error, ValueError) else "Native kit setup failed; inspect the named setup stage.", file=sys.stderr)
        sys.exit(1)
