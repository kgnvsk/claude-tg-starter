#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile


TOOL_NAME = re.compile(r"^[a-z0-9][a-z0-9.-]*$")
MANAGED_BIN_NAMES = frozenset(
    {
        "access-update",
        "agent-backup",
        "agent-github-backup",
        "agent-full-backup",
        "agent-full-snapshot",
        "agent-full-restore",
        "agent-backup-github-store",
        "agent-backup-sanitize",
        "agent-goal",
        "allow-chat",
        "apify-social",
        "asana-tasks",
        "browser-doctor",
        "browser-pdf.mjs",
        "cal-event-time",
        "cash-doctor",
        "cash-fix",
        "cash-healthcheck",
        "cash-morning-calendar",
        "cash-reminder-tick",
        "cash-update",
        "claude-auth-rescue",
        "claude-browser-recover",
        "claude-limit-recovery",
        "claude-login",
        "claude-telegram-bot",
        "codex-image-generate",
        "codex-image-result",
        "findata",
        "gog",
        "group-observation",
        "growth-analytics-doctor",
        "heic-to-jpg",
        "html-to-pdf",
        "hubspot-crm",
        "install-plugins",
        "learning-review",
        "media-dl",
        "meet-bot",
        "memory-budget-guard",
        "memory-doctor",
        "memory-embeddings-config",
        "memory-index",
        "memory-open",
        "memory-search",
        "meta-ads",
        "no-nested-claude-guard",
        "no-secrets-guard",
        "onboarding-reminder",
        "onboarding-status",
        "plugin-doctor",
        "reconcile-telegram-plugin",
        "report-build",
        "report-shell.html",
        "relogin-watch",
        "reminder-task",
        "saved-env-export",
        "scene-split",
        "sec-edgar",
        "set-apify-token",
        "set-asana-token",
        "set-gemini-key",
        "set-hubspot-token",
        "set-meta-ads-config",
        "set-openai-key",
        "set-recall-key",
        "set-sec-identity",
        "set-tg-commands",
        "set-vercel-token",
        "skill-brief",
        "skill-doctor",
        "speak",
        "subagent-result-nudge",
        "sql-readonly",
        "telegram-inbox-prune",
        "tender-watch",
        "tg-context-inject",
        "tg-escape",
        "tg-fallback-outbound",
        "tg-format-enforcer",
        "tg-reply-stop-guard",
        "tg-rich",
        "tg-send",
        "tg-send-file",
        "threads-dl",
        "transcribe",
        "transcribe-telegram",
        "ukargparse.py",
        "update-safety-check",
        "unstick-watch",
        "update-agent-clis",
        "vault-sync",
        "vc",
        "verify-telegram-bot",
        "video-edit",
        "video-ingest",
        "wiki-hot-inject",
        "yt-dl",
    }
)
MANAGED_DEPENDENCY_PATHS = frozenset(
    {
        ".local/bin/deno",
        ".local/bin/yt-dlp",
        ".local/lib/node_modules/deno",
        ".local/share/claude-video-edit",
        ".local/share/pipx/venvs/yt-dlp",
        ".npm-global/bin/vercel",
        ".npm-global/lib/node_modules/vercel",
        ".venvs/bigquery",
        ".venvs/finance",
        ".venvs/heif",
        ".venvs/spreadsheets",
    }
)
APPROVED_MANAGED_PATHS = frozenset(
    {
        *(f"bin/{name}" for name in MANAGED_BIN_NAMES),
        *MANAGED_DEPENDENCY_PATHS,
    }
)


class PolicyError(ValueError):
    pass


def normalize_v1_name(value: str) -> str:
    if not TOOL_NAME.fullmatch(value) or value not in MANAGED_BIN_NAMES:
        raise PolicyError(f"непогоджене застаріле ім’я керованого компонента: {value}")
    return f"bin/{value}"


def validate_v2_path(value: str) -> str:
    if value not in APPROVED_MANAGED_PATHS:
        raise PolicyError(f"непогоджений шлях керованого компонента: {value}")
    return value


def load_policy(path: Path) -> dict[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise PolicyError(f"не вдалося прочитати політику керованих компонентів: {error}") from error
    if not isinstance(data, dict):
        raise PolicyError("політика керованих компонентів має бути об’єктом")
    if set(data) != {"schemaVersion", "selected", "managed"}:
        raise PolicyError("політика керованих компонентів містить неочікувані ключі")
    schema_version = data["schemaVersion"]
    if (
        isinstance(schema_version, bool)
        or schema_version not in {1, 2}
    ):
        raise PolicyError(
            "schemaVersion політики керованих компонентів має дорівнювати 1 або 2"
        )
    normalized: dict[str, list[str]] = {}
    for field in ("selected", "managed"):
        values = data[field]
        if (
            not isinstance(values, list)
            or len(values) != len(set(values))
            or any(
                not isinstance(value, str)
                for value in values
            )
        ):
            raise PolicyError(
                f"поле {field} політики керованих компонентів має містити унікальні шляхи"
            )
        validator = normalize_v1_name if schema_version == 1 else validate_v2_path
        normalized[field] = [validator(value) for value in values]
    if not set(normalized["selected"]).issubset(set(normalized["managed"])):
        raise PolicyError("вибрані шляхи мають бути підмножиною керованих шляхів")
    return {
        "schemaVersion": 2,
        "selected": normalized["selected"],
        "managed": normalized["managed"],
    }


def write_policy(path: Path, policy: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(
                policy,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def remove_managed_path(home_root: Path, relative: str) -> None:
    path = home_root / relative
    parent = path.parent
    while parent != home_root:
        if parent.is_symlink():
            raise PolicyError(
                f"батьківський каталог керованого компонента є символічним посиланням: {parent}"
            )
        parent = parent.parent
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        raise PolicyError(f"непідтримуваний шлях керованого компонента: {relative}")


def reconcile(home_root: Path, policy_path: Path, state_path: Path) -> None:
    policy = load_policy(policy_path)
    previous_managed: set[str] = set()
    if state_path.exists():
        previous = load_policy(state_path)
        previous_managed = set(previous["managed"])

    selected = set(policy["selected"])
    managed = set(policy["managed"]) | previous_managed
    for relative in sorted(managed - selected):
        # Source-backed bin files are classified, installed, retained, or removed
        # transactionally by update-safety-check. Deleting them again here would
        # erase a customized file that the three-way planner deliberately kept.
        if relative.startswith("bin/"):
            continue
        remove_managed_path(home_root, relative)
    write_policy(state_path, policy)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 3:
        print(
            "використання: reconcile-managed-runtime.py "
            "HOME_DIR POLICY_JSON STATE_JSON",
            file=sys.stderr,
        )
        return 2
    try:
        reconcile(Path(args[0]), Path(args[1]), Path(args[2]))
    except PolicyError as error:
        print(f"помилка політики керованих компонентів: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
