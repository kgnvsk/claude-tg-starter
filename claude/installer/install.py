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
import stat
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


class UpdatesFrozenError(ValueError):
    """The owner froze kit updates on this server; refuse before any change."""


def assert_updates_not_frozen(marker=None):
    # box-update.sh and Novsky's assertKitUpdatesAllowed already refuse on this
    # marker before they ever reach this installer; a direct run must too.
    # A symlink (even a dangling one) or any other non-regular marker refuses
    # unopened; a regular one shows its first 2000 bytes.
    marker = Path("/etc/claude-tg-starter") / "updates-frozen" if marker is None else marker
    try:
        regular = stat.S_ISREG(os.lstat(marker).st_mode)
    except (FileNotFoundError, NotADirectoryError):
        return
    except OSError:
        regular = False
    text = ""
    if regular:
        try:
            fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                if stat.S_ISREG(os.fstat(fd).st_mode):
                    text = os.read(fd, 2000).decode("utf-8", "replace")
            finally:
                os.close(fd)
        except OSError:
            text = ""
    raise UpdatesFrozenError("FATAL: оновлення кита на цьому сервері заморожено власником" + (": " + text if text else ""))


# The owner's Codex canary received one verified four-column SQL hotfix on its
# old kit. Accept only those exact bytes from that exact revision; any further
# change remains an owner-managed conflict and stops before installation.
KNOWN_CODEX_STORE_HOTFIX = {
    "revision": "7b2ee757625859758e82dded46f97aede51fd682",
    "baseline": "a07f4f1f5e423b12516319693bb74dcc3debfa2d318f1d6d9aaaa473a289fc9c",
    "hotfix": "5546146ffc1d20d57a1a63e26e7419b9af4eed4503d583ab3ebf78b0c1ebff32",
}


# The 13.09 tmux pilot on the owner's Codex canary replaced the kit's launch with a drop-in,
# and its report leaves reconciling it to kit updates. Only that exact file (its receipt's
# overrideSha) is retired; any other override stops the update before the agent is touched.
RETIRED_TMUX_PILOT = {
    "user": "codex-8865933230", "name": "90-tmux-pilot.conf",
    "sha256": "fa52096303b366f72ff5f6a8db642be86c8cd8c835500a26a48c80cfd769e51a",
}


def service_overrides(user: str) -> list[Path]:
    """Drop-ins on the agent's unit: return the retired pilot, refuse any other one."""
    systemd = Path("/etc/systemd/system")
    pilot = safe_path(systemd, "codex-telegram@" + user + ".service.d/" + RETIRED_TMUX_PILOT["name"])
    retired = []
    for name in ("codex-telegram@" + user + ".service.d", "codex-telegram@.service.d"):
        folder = safe_path(systemd, name)
        for path in sorted(folder.glob("*.conf")) if folder.is_dir() else ():
            if (path != pilot or user != RETIRED_TMUX_PILOT["user"] or path.is_symlink() or not path.is_file()
                    or digest(path.read_bytes()) != RETIRED_TMUX_PILOT["sha256"]):
                raise ValueError("service override is not part of the kit: " + str(path) + "; move it into the kit or remove it, then retry")
            retired.append(path)
    return retired


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


def verify(root: Path, engine: str = "codex") -> dict:
    manifest = json.loads(safe_path(root, "manifest.json").read_text())
    if engine not in ("codex", "claude") or manifest.get("schemaVersion") != 1 or manifest.get("engine") != engine:
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


LOG_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
LOG_FILE_FLAGS = os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK


def runtime_log(home: Path, uid: int, gid: int):
    """The unit appends its output to ~/logs/codex-telegram.log, and systemd creates a missing
    file there as root 0600; the runtime, running as the agent, then loses every event it
    appends. Keep the log the agent's own file, reached only through pinned descriptors."""
    logs = safe_path(home, "logs")
    try:
        logs.mkdir(mode=0o700, exist_ok=True)
        directory = os.open(logs, LOG_DIRECTORY_FLAGS)
        try:
            os.fchown(directory, uid, gid)
            descriptor = os.open("codex-telegram.log", LOG_FILE_FLAGS, 0o600, dir_fd=directory)
        finally:
            os.close(directory)
    except OSError:
        raise ValueError("unsafe runtime log") from None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("unsafe runtime log")
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, 0o600)
    finally:
        os.close(descriptor)


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
    if len(parts) < 4 or parts[0] not in (".agents", ".claude") or parts[1] not in ("skills", "skills.disabled"):
        return relative
    active = safe_path(home, parts[0] + "/skills/" + parts[2])
    disabled = safe_path(home, parts[0] + "/skills.disabled/" + parts[2])
    if active.exists() and disabled.exists():
        raise ValueError("skill is both enabled and disabled: " + parts[2])
    for directory in (active, disabled):
        if directory.exists() and not directory.is_dir():
            raise ValueError("non-directory skill target")
    directory = disabled if disabled.exists() else active
    return (directory.relative_to(home) / Path(*parts[3:])).as_posix()


def plan_reconcile(root: Path, home: Path, manifest: dict, previous: dict, render: dict | None = None) -> dict:
    """Read every managed target and ownership conflict without creating files."""
    writes, baseline, targets, acknowledged_hotfixes = [], {}, [], []
    previous_files = {}
    for relative, sha in previous.get("files", {}).items():
        destination = skill_destination(home, relative)
        if destination in previous_files:
            raise ValueError("duplicate managed skill baseline")
        previous_files[destination] = sha
    preserve = {"workspace/AGENTS.md", "workspace/OWNER.md", "home/.codex/memory/USER.md", "home/.codex/memory/MEMORY.md", "home/.codex/onboarding-state.json"}
    if manifest.get("engine") == "claude":
        preserve |= {"workspace/CLAUDE.md", "home/.claude/memory/USER.md", "home/.claude/memory/MEMORY.md"}
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
        elif render and relative.startswith(("home/.claude/skills/", "home/.agents/skills/")) and relative.split("/")[3] in manifest.get("firstPartySkills", ()):
            # First-party skills carry the same placeholders the server renders.
            for name, value in render.items():
                data = data.replace(("{{" + name + "}}").encode(), str(value).encode())
            if b"{{" in data and re.search(rb"\{\{[A-Z_]+\}\}", data):
                raise ValueError("unrendered skill template: " + relative)
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
                known = KNOWN_CODEX_STORE_HOTFIX
                if not (relative == "resources/modules/telegram-corporate/store.ts"
                        and previous.get("revision") == known["revision"]
                        and previous_files.get(destination) == known["baseline"]
                        and digest(existing) == known["hotfix"]
                        and b"codex_session_id" not in data):
                    raise ValueError("locally modified managed file: " + destination)
                acknowledged_hotfixes.append({"path": str(path), "installedSha256": known["hotfix"]})
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
    return {"writes": writes, "removals": removals, "files": baseline,
            "targets": targets, "acknowledgedHotfixes": acknowledged_hotfixes}


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
        # The whole home is writable; the narrower rules keep credentials, the access list,
        # the kit and its runtime, and the memory core out of reach.
        str(home): "write",
        str(home / ".codex/auth.json"): "deny",
        str(home / ".codex/config.toml"): "read",
        str(home / ".codex/agents"): "read",
        str(home / ".agents"): "read",
        str(home / "obsidian-vault/.codex"): "read",
        str(home / ".codex/channels/telegram/access.json"): "read",
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
        str(home / ".ssh"): "read",
        "/etc/novsky/codex/" + user + ".json": "deny",
    }
    # Owner's rule (23.09.2026): the agent and its helpers never stop on an approval prompt
    # and work with the network.
    text = 'approval_policy = "never"\ndefault_permissions = "novsky-agent"\n\n[permissions.novsky-agent]\nextends = ":workspace"\ndescription = "Workspace tools with network, private credentials and controlled core memory."\n\n[permissions.novsky-agent.filesystem]\n'
    text += "\n".join(json.dumps(path) + " = " + json.dumps(value) for path, value in rules.items())
    text += '\n\n[permissions.novsky-agent.network]\nenabled = true\n'
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


REVIEWED_DEPENDENCY_BASE = "7b2ee757625859758e82dded46f97aede51fd682"
# The corporate export's move from 0.153.3 to 0.156.0 (batch 1, 28.09.2026) has
# no native profile/database smoke on copied state yet, so it is not a reviewed
# transition: a box on the old recipe is refused for individual review (batch 1
# review, 29.09). Add it back here only with that smoke, the live canary and the
# corporate role checks. Any later recipe or package version change needs a new review.
REVIEWED_DEPENDENCY_DELTA = {
    "installer/dependencies.py": (
        "1baf48535fd53745ce61ba59f7d520d159b5d5fb4f09484c580bcb56b07d75e3",
        "a3012c77990bf6d4156f73ed840f07ef120a5d561e11fe7b0f5db0d7300b478d"),
}
# Security review 03.10: only execute() and its environment allowlist changed;
# package versions, installation commands and probes are byte-for-byte unchanged.
# This exact forward transition needs no dependency reinstall. Unknown recipes,
# downgrades and corporate/CLI recipe changes still require their own review.
REVIEWED_DEPENDENCY_ENVIRONMENT_DELTA = {
    "installer/dependencies.py": (
        "4c7bad77e178bb4a8d042e0c27165658fac0eff234911a61ab5cadb1a3385e28",
        "a3012c77990bf6d4156f73ed840f07ef120a5d561e11fe7b0f5db0d7300b478d"),
}
DEPENDENCY_RECIPE_FILES = (
    "installer/dependencies.py", "installer/corporate.py", "installer/install-node.py",
)


def dependency_version_contract(installed: dict, target: dict, previous_revision: str):
    """A path-only feature inventory cannot prove dependency version parity."""
    before, after = installed.get("files"), target.get("files")
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise ValueError("maintenance dependency versions cannot be verified")
    for path in DEPENDENCY_RECIPE_FILES:
        old, new = before.get(path), after.get(path)
        if not all(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in (old, new)):
            raise ValueError("maintenance dependency recipe missing")
        if old != new and not (
                REVIEWED_DEPENDENCY_ENVIRONMENT_DELTA.get(path) == (old, new) or
                previous_revision == REVIEWED_DEPENDENCY_BASE
                and REVIEWED_DEPENDENCY_DELTA.get(path) == (old, new)):
            raise ValueError("maintenance dependency recipe changed; review this agent separately")

    def package_inputs(files):
        return {path: value for path, value in files.items()
                if path.startswith("resources/") and (
                    PurePosixPath(path).name in {"package.json", "package-lock.json", "pnpm-lock.yaml",
                                                "yarn.lock", "pyproject.toml", "poetry.lock",
                                                "Pipfile.lock", "requirements.txt"}
                    or "/requirements/" in path and path.endswith(".txt"))}

    if package_inputs(before) != package_inputs(after):
        raise ValueError("maintenance dependency package inputs changed; review this agent separately")


def maintenance_contract(previous: dict, target: dict) -> dict:
    """Do not replay dependency installers against a changed product profile."""
    path = previous.get("payload")
    if not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError("maintenance requires the installed kit")
    try:
        installed = verify(Path(path))
    except (OSError, ValueError) as error:
        raise ValueError("maintenance installed kit cannot be verified") from error
    if (not isinstance(installed.get("dependencies"), dict) or
            not isinstance(target.get("dependencies"), dict) or
            installed["productId"] != previous.get("productId") or
            installed["sourceRevision"] != previous.get("revision") or
            installed["productId"] != target["productId"] or
            installed["features"] != target["features"] or
            installed["nativePlugins"] != target["nativePlugins"] or
            installed.get("dependencies") != target.get("dependencies")):
        raise ValueError("maintenance dependency profile changed; review this agent separately")
    dependency_version_contract(installed, target, previous["revision"])
    return installed


def required_codex_cli(root: Path) -> str:
    """The Codex CLI this payload's runtime was proven on (runtime/SOURCE.json)."""
    try:
        version = json.loads(safe_path(root, "runtime/SOURCE.json").read_text()).get("codexCliVersion")
    except (OSError, ValueError, AttributeError) as error:
        raise ValueError("runtime Codex CLI pin is unreadable") from error
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("runtime Codex CLI pin is unreadable")
    return version


CODEX_CLI_VERSION_OUTPUT = re.compile(r"\bcodex-cli (\d+\.\d+\.\d+)\b")


def installed_codex_cli(home: Path, user: str) -> str | None:
    """The version the agent's own launcher reports, run as the agent (never as root): the executable
    the service starts, not the package metadata beside it (batch 1 review, round 2)."""
    binary = home / ".local/lib/novsky-runtime/node_modules/.bin/codex"
    env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "LANG": "C.UTF-8",
           "PATH": f"{home}/.local/lib/novsky-node/bin:{home}/.local/lib/novsky-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin"}
    command = [str(binary), "--version"]
    as_root = os.geteuid() == 0
    if as_root:
        command = ["runuser", "-u", user, "--", "env", "-i", *[key + "=" + value for key, value in env.items()], *command]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=30, cwd=str(home),
                                env=None if as_root else env)
    except (OSError, subprocess.SubprocessError):
        return None
    match = CODEX_CLI_VERSION_OUTPUT.search(result.stdout or "") if result.returncode == 0 else None
    return match.group(1) if match else None


def assert_codex_cli_matches(root: Path, home: Path, user: str):
    """Batch 1 (Codex review P1): the runtime was proven on one CLI only. Actual maintenance, and
    the license preflight before the agent is stopped, refuse while the agent runs another one;
    the read-only plan stays usable. The server setup installs the pinned CLI before maintenance."""
    required, installed = required_codex_cli(root), installed_codex_cli(home, user)
    if installed != required:
        raise ValueError(f"Codex CLI {installed or 'not found'} is not {required}, the version this runtime needs: "
                         f"install Codex CLI {required} for this agent first (the release's server setup does it), "
                         "then run maintenance again")


def check_existing_dependencies(home: Path, user: str, manifest: dict):
    from dependencies import check_existing_dependencies as check
    check(home, user, manifest)


def preflight_maintenance(root: Path, home: Path, user: str, manifest: dict, previous: dict, *,
                          allow_pinned_legacy_shared_context: bool = False):
    """Read only, while the old agent can still be restarted without a swap."""
    if allow_pinned_legacy_shared_context and user != "codex-8865933230":
        raise ValueError("pinned legacy backup context is owner canary-only")
    maintenance_contract(previous, manifest)
    check_existing_dependencies(home, user, manifest)
    command = ["python3", str(root / "installer/install-backup-context.py"),
               "--check-current", "--allow-maintenance-hold", "--home", str(home),
               "--user", user, "--unit", "codex-telegram@" + user + ".service",
               "--engine", "codex"]
    if allow_pinned_legacy_shared_context:
        command.append("--allow-pinned-legacy-shared-context")
    result = subprocess.run(command, capture_output=True, timeout=180)
    try:
        checked = json.loads(result.stdout)
    except (TypeError, ValueError):
        checked = None
    if result.returncode or not isinstance(checked, dict) or checked.get("ok") is not True:
        raise ValueError("backup context requires reviewed migration before maintenance")


def main():
    assert_updates_not_frozen()
    data = json.load(sys.stdin)
    action = data.get("action", "install")
    if action not in ("install", "plan", "license-preflight"):
        raise ValueError("unsupported installation action")
    # Read-only actions must not create import caches in the verified payload.
    sys.dont_write_bytecode = True
    user = data["user"]
    if os.geteuid() != 0 or not re.fullmatch(r"codex-[a-z0-9][a-z0-9-]{0,23}", user):
        raise ValueError("a Novsky Codex account is required")
    allow_pinned_context = data.get("allowPinnedLegacySharedContext", False)
    if not isinstance(allow_pinned_context, bool):
        raise ValueError("invalid pinned legacy backup context setting")
    if allow_pinned_context and (user != "codex-8865933230" or data.get("maintenance") is not True
                                 or action not in ("plan", "install")):
        raise ValueError("pinned legacy backup context is owner canary maintenance-only")
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
    if allow_pinned_context and not previous.get("revision"):
        raise ValueError("pinned legacy backup context requires existing maintenance state")
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
        raise ValueError("local project configuration needs reconciliation: " + str(project_config.relative_to(home)))
    retired = service_overrides(user)
    # The kit was reviewed with one Codex CLI. Novsky and codex/server.py install it after the
    # read-only plan and before this step (census 26.09: 0.153.3 and 0.154.0 ran side by side).
    codex_cli = {"installed": installed_codex_cli(home, user), "required": required_codex_cli(root)}
    directories = ("bin", ".agents", ".codex/agents", "obsidian-vault/.codex", ".local/lib", ".local/bin", ".npm-global", ".local/state/novsky-codex", ".local/share/novsky-kit", ".venvs", ".config")
    for relative in directories:
        path = safe_path(home, relative)
        if path.exists() and not path.is_dir():
            raise ValueError("non-directory installation target")
    generated = [(manifest_path, json.dumps(manifest), 0o600), (inventory_path, json.dumps(inventory), 0o440),
                 (project_config, config_text, 0o600), *configuration["writes"]]
    targets = [*plan["targets"], *(target_change(path, content, mode) for path, content, mode in generated),
               target_change(state_path), target_change(config_path),
               *({"path": str(path), "action": "preserve"} for path in configuration["preserved"]),
               *({"path": str(path), "action": "remove"} for path in retired)]
    if data.get("maintenance") is True and action != "license-preflight":
        preflight_maintenance(root, home, user, manifest, previous,
                              **({"allow_pinned_legacy_shared_context": True} if allow_pinned_context else {}))
    if action == "plan":
        compatibility = {"engine": "codex", "previousProductId": previous.get("productId"),
                         "previousRevision": previous.get("revision"), "ownerAccess": configuration["ownerAccess"],
                         "projectConfig": "compatible", "requiresStoppedAgent": True, "codexCli": codex_cli}
        if data.get("maintenance") is True:
            # Emitted only after the read-only maintenance preflight passes.
            compatibility["maintenanceTransactionSafe"] = True
            compatibility["maintenanceTransactionScope"] = "native-installer"
            compatibility["maintenanceTargetRevision"] = manifest["sourceRevision"]
        print(json.dumps({"ok": True, "action": "plan", "coverage": "managed-files", "productId": manifest["productId"],
                          "revision": manifest["sourceRevision"],
                          "acknowledgedHotfixes": plan["acknowledgedHotfixes"],
                          "changes": {name: sum(target["action"] == name for target in targets) for name in ("create", "update", "remove", "preserve", "unchanged")},
                          "targets": sorted(targets, key=lambda target: target["path"]),
                          "compatibility": compatibility}))
        return
    if action == "install" or data.get("maintenance") is True:
        # Before activation or any change: a new runtime never goes in beside another CLI.
        assert_codex_cli_matches(root, home, user)
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
    # The key has done its one job: a copy an older kit saved goes now, and so do the copies older backup and
    # rollback images of this agent took (owner, 04.10.2026: kept nowhere).
    if licensing:
        key_path.unlink(missing_ok=True)
        licensing.scrub_backups(user)
    # Every managed path, config conflict and owner check above is read-only.
    # Dependency installation and native discovery still need runtime checks.
    runtime_log(home, account.pw_uid, account.pw_gid)
    for path in retired:
        # systemd ignores the renamed file, and the kit's own unit launches the runtime again.
        path.rename(path.with_name(path.name + ".retired"))
    if retired:
        subprocess.run(["systemctl", "daemon-reload"], check=True, capture_output=True, timeout=60)
    apply_reconcile(plan, account.pw_uid, account.pw_gid)
    atomic(manifest_path, json.dumps(manifest), account.pw_uid, account.pw_gid)
    # Root-owned baseline is persisted before dependency work so an interrupted
    # first install can retry the same managed files without mistaking them for edits.
    atomic(state_path, json.dumps({**previous, "productId": manifest["productId"], "files": files}), 0, 0)
    safe_env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "NOVSKY_WORKSPACE": str(home / "obsidian-vault"), "PATH": f"{home}/bin:{home}/.local/lib/novsky-node/bin:{home}/.local/lib/novsky-runtime/node_modules/.bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    if not data.get("maintenance"):
        from dependencies import install_dependencies
        install_dependencies(root, home, user, manifest, safe_env)
    # Linux bwrap needs directory rule ancestors to exist. In particular a
    # Starter without Python feature venvs must still have the protected root.
    from dependencies import directory
    if not data.get("maintenance"):
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
    corporate = export_corporate(root, home, user, manifest, safe_env, maintenance=data.get("maintenance") is True)
    if corporate:
        config["corporate"] = corporate
    else:
        config.pop("corporate", None)
    atomic(config_path, json.dumps(config), account.pw_uid, account.pw_gid, 0o400)
    if not data.get("maintenance"):
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
        sys.exit(3 if isinstance(error, UpdatesFrozenError) else 1)
