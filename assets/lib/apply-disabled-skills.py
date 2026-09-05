#!/usr/bin/env python3
"""Навички, що вимкнені: за замовчуванням продукту або рукою власника.

    apply-disabled-skills.py <AGENT_HOME> <DEFAULT_OFF_JSON>

Вимкнена навичка живе в ~/.claude/skills.disabled/<name>, а не в
~/.claude/skills/: Claude Code її не бачить, файли лишаються, увімкнути —
перенести назад (Novsky → Скіли). Запускається після всіх джерел навичок в
install-core, бо кожне з них кладе свіжу копію в ~/.claude/skills/.

Два правила:
1. Список продукту «вимкнено за замовчуванням» застосовується до навички один
   раз — при першій появі. Рішення власника увімкнути її потім поважається:
   імена, до яких список уже застосовано, пишуться в
   ~/.claude/product/skills-default-off-applied.json.
2. Усе, що лежить у skills.disabled/, лишається вимкненим: свіжа копія з
   ~/.claude/skills/ переїжджає туди замість старої.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path


def load_names(path: Path) -> list[str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    names = data.get("skills") if isinstance(data, dict) else None
    return [n for n in names if isinstance(n, str)] if isinstance(names, list) else []


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: apply-disabled-skills.py AGENT_HOME DEFAULT_OFF_JSON", file=sys.stderr)
        return 2
    home = Path(argv[1])
    on_dir = home / ".claude" / "skills"
    off_dir = home / ".claude" / "skills.disabled"
    state_path = home / ".claude" / "product" / "skills-default-off-applied.json"
    default_off = load_names(Path(argv[2]))
    applied = set(load_names(state_path))

    moved_default: list[str] = []
    for name in default_off:
        if name in applied:
            continue
        applied.add(name)
        if (on_dir / name).is_dir() and not (off_dir / name).exists():
            off_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(on_dir / name), str(off_dir / name))
            moved_default.append(name)

    refreshed: list[str] = []
    if off_dir.is_dir():
        for entry in sorted(off_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            fresh = on_dir / entry.name
            if fresh.is_dir():
                shutil.rmtree(entry)
                shutil.move(str(fresh), str(entry))
                refreshed.append(entry.name)

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({"schemaVersion": 1, "skills": sorted(applied)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(state_path, 0o600)
    print(f"вимкнені навички: за замовчуванням {len(moved_default)}, оновлено вимкнених {len(refreshed)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
