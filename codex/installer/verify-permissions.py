#!/usr/bin/env python3
"""Exercise native command permissions using only an isolated public fixture."""
import argparse
import json
import os
from pathlib import Path
import tempfile
from install import native_config
from setup import RPC


def verify_permissions(binary: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="novsky-policy-") as temporary:
        home = Path(temporary).resolve()
        workspace = home / "obsidian-vault"
        (workspace / ".codex").mkdir(parents=True)
        (home / ".codex/memory").mkdir(parents=True)
        (home / ".codex/channels/telegram").mkdir(parents=True)
        for relative in ("bin", ".agents", ".codex/agents", ".local/bin", ".npm-global", ".local/lib", ".local/state/novsky-codex", ".local/share/novsky-kit", ".venvs", ".config"):
            (home / relative).mkdir(parents=True, exist_ok=True)
        auth = home / ".codex/auth.json"
        private = home / ".codex/channels/telegram/.env"
        core = home / ".codex/memory/USER.md"
        for path in (auth, private, core):
            path.write_text("public-synthetic-fixture")
        auth.write_text('{}\n')
        (workspace / ".codex/config.toml").write_text(native_config(home, "codex-fixture", None))
        (home / ".codex/config.toml").write_text('model="offline-fixture"\nmodel_provider="offline_fixture"\n[model_providers.offline_fixture]\nname="Public offline fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[projects.' + json.dumps(str(workspace)) + ']\ntrust_level="trusted"\n')
        env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "XDG_CONFIG_HOME": str(home / ".config"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "C.UTF-8"}
        rpc = RPC(binary, workspace, env)
        def command(arguments):
            return rpc.call("command/exec", {"command": arguments, "cwd": str(workspace), "permissionProfile": "novsky-agent", "timeoutMs": 15000, "outputBytesCap": 1000})
        try:
            results = {}
            for name, path in (("auth_read_denied", auth), ("env_read_denied", private)):
                result = command(["/bin/cat", str(path)])
                results[name] = result["exitCode"] != 0 and "public-synthetic-fixture" not in result["stdout"]
            core_result = command(["/bin/cat", str(core)])
            results["core_read_allowed"] = core_result["stdout"] == "public-synthetic-fixture"
            results["core_write_denied"] = command(["/usr/bin/python3", "-c", "from pathlib import Path;import sys;Path(sys.argv[1]).write_text('changed')", str(core)])["exitCode"] != 0
            write_result = command(["/usr/bin/python3", "-c", "from pathlib import Path;Path('public-note.md').write_text('fixture')"])
            results["workspace_write_allowed"] = write_result["exitCode"] == 0
            results["core_unchanged"] = core.read_text() == "public-synthetic-fixture"
        finally:
            rpc.close()
        if not all(results.values()):
            raise ValueError("Native permission fixture failed: " + ", ".join(name for name, passed in results.items() if not passed) + "; synthetic command diagnostics: " + (core_result["stderr"] + write_result["stderr"])[:1600])
        return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify_permissions(args.codex)))
