"""Native configuration import and discovery checks; no model turns."""
from __future__ import annotations
import json
from pathlib import Path
import pwd
import queue
import shlex
import subprocess
import threading
import time


class RPC:
    def __init__(self, binary, cwd, env, user=None):
        command = [str(binary), "app-server", "--strict-config", "--stdio"]
        if user:
            command = ["runuser", "-u", user, "--", "env", "-i", *[k + "=" + v for k, v in env.items()], *command]
        self.process = subprocess.Popen(command, cwd=cwd, env=env if not user else None, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.frames = queue.Queue(maxsize=1000)
        self.saved = []
        self.counter = 0
        threading.Thread(target=self.read, daemon=True).start()
        self.call("initialize", {"clientInfo": {"name": "novsky_kit_setup", "version": "1"}, "capabilities": {"experimentalApi": True}})
        self.write({"method": "initialized"})

    def read(self):
        for line in self.process.stdout:
            try:
                self.frames.put(json.loads(line), timeout=5)
            except (ValueError, queue.Full):
                self.process.terminate()
                return

    def write(self, frame):
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", **frame}) + "\n")
        self.process.stdin.flush()

    def wait(self, predicate, timeout=60):
        for i, item in enumerate(self.saved):
            if predicate(item):
                return self.saved.pop(i)
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                item = self.frames.get(timeout=min(1, max(.01, end - time.monotonic())))
            except queue.Empty:
                if self.process.poll() is not None:
                    raise ValueError("native configuration service exited")
                continue
            if "method" in item and "id" in item:
                self.write({"id": item["id"], "error": {"code": -32601, "message": "Installation does not run model tools or grant approvals"}})
            elif predicate(item):
                return item
            elif len(self.saved) < 1000:
                self.saved.append(item)
        raise ValueError("native configuration check timed out")

    def call(self, method, params=None, timeout=60):
        self.counter += 1
        number = self.counter
        self.write({"id": number, "method": method, **({"params": params} if params is not None else {})})
        frame = self.wait(lambda item: item.get("id") == number, timeout)
        if "error" in frame:
            raise ValueError("native method failed: " + method)
        return frame["result"]

    def close(self):
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def import_plugins(rpc, stage: Path, expected: list[str]):
    if not expected:
        return []
    # This RPC process has HOME=the public migration stage and CODEX_HOME=the
    # target native config. The importer supports home-scoped Claude plugins;
    # it never scans the real owner's Claude configuration.
    # Native detection omits already imported plugins. An upgrade must verify
    # that existing plugins are actually enabled, rather than require a second
    # migration item or assume a downloaded cache means installation succeeded.
    entries = rpc.call('skills/list', {'cwds': [str(stage)], 'forceReload': True})['data']
    existing = {skill['pluginId'] for entry in entries for skill in entry['skills']
                if skill['enabled'] and isinstance(skill.get('pluginId'), str)}
    detection = rpc.call("externalAgentConfig/detect", {"includeHome": True, "cwds": [], "migrationSource": "claude"})
    items = [item for item in detection["items"] if item["itemType"] == "PLUGINS"]
    if not items:
        if set(expected) <= existing: return sorted(expected)
        raise ValueError("selected plugins were not detected")
    imported = rpc.call("externalAgentConfig/import", {"migrationItems": items, "source": "novsky-kit", "migrationSource": "claude"})
    done = rpc.wait(lambda item: item.get("method") == "externalAgentConfig/import/completed" and item.get("params", {}).get("importId") == imported["importId"], timeout=600)["params"]
    successes = set(existing)
    for group in done["itemTypeResults"]:
        if group["failures"]:
            raise ValueError("a selected native plugin failed to import")
        successes.update(item["source"] for item in group["successes"])
    if not set(expected) <= successes:
        raise ValueError("native plugin import inventory mismatch")
    return sorted(successes)


def check_discovery(rpc, home, manifest):
    workspace = home / "obsidian-vault"
    entries = rpc.call("skills/list", {"cwds": [str(workspace)], "forceReload": True})["data"]
    skills = [skill for entry in entries for skill in entry["skills"] if skill["enabled"]]
    found = {Path(skill["path"]).parent.name for skill in skills}
    if set(manifest["nativeSkills"]) - found:
        raise ValueError("native skill discovery missed: " + ", ".join(sorted(set(manifest["nativeSkills"]) - found)))
    contract = json.loads((home / ".local/share/novsky-kit/plugin-contract.json").read_text())["plugins"]
    for plugin, specification in contract.items():
        actual = {Path(skill["path"]).parent.name for skill in skills if skill.get("pluginId") == plugin or plugin.split("@")[0] in Path(skill["path"]).parts}
        # Compare actual enabled native skills, not files in a downloaded cache.
        missing = set(specification["requiredSkills"]) - actual
        if missing:
            raise ValueError("native plugin skills missing: " + plugin + ": " + ", ".join(sorted(missing)))
    profiles = rpc.call("permissionProfile/list", {"cwd": str(workspace)})
    if "novsky-agent" not in json.dumps(profiles):
        raise ValueError("native permissions profile was not loaded")
    return {"skills": len(manifest["nativeSkills"]), "pluginSkills": sum(bool(skill.get("pluginId")) for skill in skills), "plugins": sorted(contract), "nativeAgents": manifest["nativeAgents"]}


def verify_starter_foundation(home, user, env):
    from dependencies import execute
    # The fixed host helper reads the private channel configuration itself.
    # Never put an API key in argv, model context or returned diagnostics.
    execute([str(home / "bin/memory-index"), "index", "--vault-only", "--embed-budget", "400"],
            user=user, env=env, label="Starter memory index", timeout=120)
    probe = '''import json, pathlib, shutil, sqlite3
import numpy
home = pathlib.Path.home()
database = home / '.codex/memory/index.sqlite3'
with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as db:
    healthy = db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    notes, vectors = db.execute("SELECT count(*), coalesce(sum(CASE WHEN length(e.vector)=2048 THEN 1 ELSE 0 END), 0) FROM documents d LEFT JOIN embeddings e ON e.doc_id=d.doc_id AND e.model=? WHERE d.source='vault'", ('text-embedding-3-small',)).fetchone()
vault = (home / 'obsidian-vault/OWNER.md').is_file()
memory = all((home / '.codex/memory' / name).is_file() for name in ('USER.md', 'MEMORY.md'))
voice = all(shutil.which(name) for name in ('curl', 'jq', 'ffmpeg')) and (home / 'bin/transcribe').is_file()
print(json.dumps({'vault': vault, 'memory': memory and healthy, 'notes': notes, 'vectors': vectors, 'voiceConfigured': bool(voice)}))
'''
    result = json.loads(execute(["python3", "-c", probe], user=user, env=env, label="Starter foundation check"))
    if not all(result.get(name) for name in ("vault", "memory", "vectors", "voiceConfigured")) or result.get("notes") != result.get("vectors"):
        raise ValueError("Novsky Starter memory or voice is not ready; check the OpenAI API key and API balance, then retry")
    return result


def configure(home, user, manifest, env, data):
    from install import atomic
    account = pwd.getpwnam(user)
    channel = home / ".codex/channels/telegram"
    access_path = channel / "access.json"
    if access_path.exists():
        access = json.loads(access_path.read_text())
        if set(map(str, access.get("admins", []))) != {str(data["ownerChatId"])}:
            raise ValueError("existing memory owner differs from installation owner")
    else:
        atomic(access_path, json.dumps({"admins": [str(data["ownerChatId"])], "allowFrom": [str(data["ownerChatId"])]}), account.pw_uid, account.pw_gid)
    env_path = channel / ".env"
    existing = env_path.read_text() if env_path.exists() else ""
    # Preserve existing integrations; only update fields explicitly supplied by
    # Novsky. Semantic memory needs its own explicit setup choice.
    updates = {"AGENT_NAME": data.get("agentName", "Novsky"), "OWNER_CHAT_ID": str(data["ownerChatId"]), "TZ": data.get("timezone", "UTC")}
    if data.get("botToken"):
        updates["TELEGRAM_BOT_TOKEN"] = data["botToken"]
    if data.get("openaiApiKey"):
        updates["OPENAI_API_KEY"] = data["openaiApiKey"]
    if data.get("semanticMemory") is not None:
        updates["MEMORY_EMBEDDINGS_OPENAI"] = "enabled" if data["semanticMemory"] else "disabled"
    elif "MEMORY_EMBEDDINGS_OPENAI=" not in existing:
        updates["MEMORY_EMBEDDINGS_OPENAI"] = "disabled"
    lines = [line for line in existing.splitlines() if line.removeprefix("export ").split("=", 1)[0] not in updates]
    lines.extend(key + "=" + shlex.quote(value) for key, value in updates.items())
    atomic(env_path, "\n".join(lines) + "\n", account.pw_uid, account.pw_gid, 0o400)
    binary = home / ".local/lib/novsky-runtime/node_modules/.bin/codex"
    stage = home / ".local/share/novsky-kit/migration"
    rpc = RPC(binary, home / "obsidian-vault", {**env, "HOME": str(stage)}, user)
    try:
        import_plugins(rpc, stage, manifest["nativePlugins"])
    finally:
        rpc.close()
    # Plugin imports write user configuration. A fresh app-server consumes the
    # native configuration exactly as the final Telegram service will.
    rpc = RPC(binary, home / "obsidian-vault", env, user)
    try:
        return check_discovery(rpc, home, manifest)
    finally:
        rpc.close()
