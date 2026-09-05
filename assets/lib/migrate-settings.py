#!/usr/bin/env python3
"""Migrate starter-owned Claude settings without overwriting owner customizations."""

from pathlib import Path
import json
import os
import sys
import tempfile


# {H} is the agent home, derived from the settings path at migrate() time: on
# multi-instance boxes each bot lives under its own /home/<user>.
DEPRECATED_COMMANDS = (
    "{H}/bin/vault-index",
    "{H}/bin/cash-thread-capture",
    "{H}/bin/tg-thread-snapshot",
    "{H}/bin/graphify-vault",
    "/opt/claude-graphify/bin/graphify",
)
MANAGED_HOOKS = (
    ("SessionStart", None, "{H}/bin/wiki-hot-inject", 10),
    ("SessionStart", "compact", "{H}/bin/tg-context-inject", 5),
    ("UserPromptSubmit", None, "{H}/bin/tg-context-inject", 5),
    ("PreToolUse", "Bash", "{H}/bin/no-nested-claude-guard", 5),
    ("PreToolUse", "mcp__plugin_telegram_telegram__reply", "{H}/bin/tg-format-enforcer", 5),
    ("PreToolUse", "Bash|Read|Edit|Write|MultiEdit", "{H}/bin/no-secrets-guard", 5),
    ("PreToolUse", "Bash|Edit|Write|MultiEdit", "{H}/bin/memory-budget-guard", 5),
    ("PostToolUse", "Write|Edit|MultiEdit", "jq -r '.tool_input.file_path // .tool_response.filePath // \"\"' | grep -q \"^{H}/obsidian-vault/\" && {H}/bin/vault-sync &", 5),
    ("Stop", None, "{H}/bin/tg-reply-stop-guard", 35),
)

PROTECTED_DENY_RULES = (
    "Read({H}/.claude/channels/telegram/.env)",
    "Read({H}/.claude/.credentials.json)",
    "Read(/etc/claude-tg-starter/**)",
    "Edit({H}/.claude/channels/telegram/.env)",
    "Edit({H}/.claude/.credentials.json)",
    "Edit(/etc/claude-tg-starter/**)",
)
DEPRECATED_DENY_RULES = (
    "Write({H}/.claude/channels/telegram/.env)",
    "Write({H}/.claude/.credentials.json)",
    "Write(/etc/claude-tg-starter/**)",
)
DEPRECATED_MARKETPLACES = ("lazyweb",)
DEPRECATED_PLUGINS = ("lazyweb@lazyweb",)
SKILL_OVERRIDE_STATES = frozenset(
    ("on", "name-only", "user-invocable-only", "off")
)


def load_managed_plugin_policy(path: Path) -> tuple[set[str], set[str], set[str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("managed plugin policy must be an object")
    enabled = data.get("enabled")
    managed = data.get("managed")
    # Absent in policies written before the distinction existed, where every
    # shipped plugin was treated as mandatory.
    required = data.get("required", enabled)
    for name, values in (
        ("enabled", enabled),
        ("managed", managed),
        ("required", required),
    ):
        if (
            not isinstance(values, list)
            or any(not isinstance(value, str) or not value for value in values)
        ):
            raise ValueError(
                f"managed plugin policy {name} must be a list of strings"
            )
    if not set(enabled).issubset(set(managed)):
        raise ValueError("enabled plugins must be a subset of managed plugins")
    if not set(required).issubset(set(enabled)):
        raise ValueError("required plugins must be a subset of enabled plugins")
    return set(enabled), set(managed), set(required)


def hook_command(hook: object) -> str:
    if not isinstance(hook, dict):
        return ""
    return str(hook.get("command", ""))


def skill_overrides(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or any(
        not isinstance(name, str)
        or not name
        or not isinstance(state, str)
        or state not in SKILL_OVERRIDE_STATES
        for name, state in (value.items() if isinstance(value, dict) else ())
    ):
        raise ValueError(
            "skillOverrides must map skill names to valid visibility states"
        )
    return value


def migrate(
    path: Path,
    managed_template: Path | None = None,
    managed_plugins_path: Path | None = None,
) -> None:
    original = path.stat()
    # <home>/.claude/settings.json → <home>
    home = str(path.resolve().parent.parent)
    # Deprecated entries are matched against BOTH the derived home and the
    # historical /home/claude literal, so legacy hooks are still cleaned up on
    # settings files that moved to another instance home.
    deprecated_commands = tuple(dict.fromkeys(
        [v.format(H=home) for v in DEPRECATED_COMMANDS]
        + [v.format(H="/home/claude") for v in DEPRECATED_COMMANDS]
    ))
    managed_hooks = tuple(
        (event, matcher, command.format(H=home), timeout)
        for event, matcher, command, timeout in MANAGED_HOOKS
    )
    protected_deny_rules = tuple(v.format(H=home) for v in PROTECTED_DENY_RULES)
    deprecated_deny_rules = tuple(dict.fromkeys(
        [v.format(H=home) for v in DEPRECATED_DENY_RULES]
        + [v.format(H="/home/claude") for v in DEPRECATED_DENY_RULES]
    ))
    data = json.loads(path.read_text(encoding="utf-8"))

    # Lazyweb is a standalone skill pack, not a Claude plugin marketplace. Older
    # templates registered its Git repository as a marketplace, which made every
    # plugin install report a fatal error because marketplace.json does not exist.
    marketplaces = data.get("extraKnownMarketplaces", {})
    if isinstance(marketplaces, dict):
        for name in DEPRECATED_MARKETPLACES:
            marketplaces.pop(name, None)
    enabled_plugins = data.get("enabledPlugins", {})
    if isinstance(enabled_plugins, dict):
        for plugin in DEPRECATED_PLUGINS:
            enabled_plugins.pop(plugin, None)

    hooks = data.setdefault("hooks", {})

    for event, entries in list(hooks.items()):
        if not isinstance(entries, list):
            continue
        kept_entries = []
        for entry in entries:
            if not isinstance(entry, dict):
                kept_entries.append(entry)
                continue
            actions = entry.get("hooks")
            if not isinstance(actions, list):
                kept_entries.append(entry)
                continue
            kept_actions = [
                action
                for action in actions
                if not any(old in hook_command(action) for old in deprecated_commands)
            ]
            if kept_actions:
                entry["hooks"] = kept_actions
                kept_entries.append(entry)
        hooks[event] = kept_entries

    for event, matcher, command, timeout in managed_hooks:
        entries = hooks.setdefault(event, [])
        already_present = any(
            command == hook_command(action)
            for entry in entries
            if isinstance(entry, dict)
            for action in entry.get("hooks", [])
            if isinstance(entry.get("hooks"), list)
        )
        if already_present and event == "Stop":
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                for action in entry.get("hooks", []):
                    if (
                        isinstance(action, dict)
                        and command == hook_command(action)
                        and action.get("timeout") == 5
                    ):
                        action["timeout"] = timeout
        elif not already_present:
            entry = {
                "hooks": [
                    {
                        "type": "command",
                        "command": command,
                        "timeout": timeout,
                    }
                ]
            }
            if matcher:
                entry["matcher"] = matcher
            entries.append(entry)

    template = None
    if managed_template is not None:
        # The kit template carries {{AGENT_HOME}} placeholders; substitute the
        # actual home before merging managed rules into live settings.
        template = json.loads(
            managed_template.read_text(encoding="utf-8").replace("{{AGENT_HOME}}", home)
        )

        marketplaces = data.setdefault("extraKnownMarketplaces", {})
        managed_marketplaces = template.get("extraKnownMarketplaces", {})
        if isinstance(marketplaces, dict) and isinstance(managed_marketplaces, dict):
            # Kit-owned marketplace definitions are refreshed, while owner-added
            # marketplaces remain untouched.
            marketplaces.update(managed_marketplaces)

        enabled_plugins = data.setdefault("enabledPlugins", {})
        managed_plugins = template.get("enabledPlugins", {})
        if isinstance(enabled_plugins, dict) and isinstance(managed_plugins, dict):
            if managed_plugins_path is None:
                # Legacy source-tree updates preserve an owner's explicit false.
                for plugin, enabled in managed_plugins.items():
                    enabled_plugins.setdefault(plugin, enabled)
            else:
                selected, managed, required = load_managed_plugin_policy(
                    managed_plugins_path
                )
                if selected != set(managed_plugins):
                    raise ValueError(
                        "managed plugin policy does not match settings template"
                    )
                for plugin in managed - selected:
                    enabled_plugins.pop(plugin, None)
                for plugin in selected:
                    if plugin in required:
                        enabled_plugins[plugin] = managed_plugins[plugin]
                    else:
                        # An owner who switched a plugin off meant it. Rewriting
                        # that on every update made the choice unavailable: it
                        # came back each time, and the check then refused to
                        # update at all while it was off.
                        enabled_plugins.setdefault(plugin, managed_plugins[plugin])

                active_marketplaces = {
                    plugin.rsplit("@", maxsplit=1)[1]
                    for plugin in enabled_plugins
                    if "@" in plugin
                }
                managed_marketplaces = {
                    plugin.rsplit("@", maxsplit=1)[1]
                    for plugin in managed
                    if "@" in plugin
                }
                for marketplace in managed_marketplaces - active_marketplaces:
                    marketplaces.pop(marketplace, None)

        if "model" not in data and "model" in template:
            data["model"] = template["model"]
        if "skillListingBudgetFraction" in template:
            # The kit default keeps the complete active skill catalog visible.
            # Preserve an owner's explicit budget choice.
            data.setdefault(
                "skillListingBudgetFraction",
                template["skillListingBudgetFraction"],
            )
        if "skillListingMaxDescChars" in template:
            # One description in the listing stays short: vendored skills
            # bring paragraphs, and the listing is paid for on every turn.
            data.setdefault(
                "skillListingMaxDescChars",
                template["skillListingMaxDescChars"],
            )
        if "skillOverrides" in template:
            managed_skill_overrides = skill_overrides(template["skillOverrides"])
            live_skill_overrides = data.get("skillOverrides")
            if live_skill_overrides is None:
                live_skill_overrides = {}
                data["skillOverrides"] = live_skill_overrides
            live_skill_overrides = skill_overrides(live_skill_overrides)
            for name, state in managed_skill_overrides.items():
                live_skill_overrides.setdefault(name, state)

    permissions = data.setdefault("permissions", {})
    allowed = permissions.setdefault("allow", [])
    if isinstance(allowed, list):
        allowed[:] = [value for value in allowed if value != "Bash(google-chrome:*)"]
        if template is not None:
            managed_allowed = template.get("permissions", {}).get("allow", [])
            if isinstance(managed_allowed, list):
                for rule in managed_allowed:
                    if rule not in allowed:
                        allowed.append(rule)
    denied = permissions.setdefault("deny", [])
    if isinstance(denied, list):
        denied[:] = [rule for rule in denied if rule not in deprecated_deny_rules]
        for rule in protected_deny_rules:
            if rule not in denied:
                denied.append(rule)

    # Bound MCP tool calls so a hung/unresponsive MCP server can't freeze a whole
    # turn forever (stdio idle default is 30 min — that's how a turn hung silently).
    env = data.setdefault("env", {})
    if isinstance(env, dict):
        env.setdefault("MCP_TOOL_TIMEOUT", "180000")            # 3 min hard cap / call
        env.setdefault("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "120000")  # 2 min no-progress

    rendered = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, original.st_mode & 0o777)
        if hasattr(os, "chown"):
            os.chown(temporary, original.st_uid, original.st_gid)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3, 4):
        raise SystemExit(
            "Usage: migrate-settings.py <settings.json> "
            "[managed-template.json] [managed-plugins.json]"
        )
    migrate(
        Path(sys.argv[1]),
        Path(sys.argv[2]) if len(sys.argv) >= 3 else None,
        Path(sys.argv[3]) if len(sys.argv) == 4 else None,
    )
