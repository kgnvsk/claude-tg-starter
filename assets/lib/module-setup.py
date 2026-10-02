#!/usr/bin/env python3
"""What every module setup an agent runs itself shares (kit-module setup <назва>).

  module-setup.py install НАЗВА КАТАЛОГ   поставити підготовлені файли в дім агента — усі або жодного
  module-setup.py check НАЗВА КАТАЛОГ     те саме порівняння без запису: чи стане install, перш ніж щось качати
  module-setup.py crontab ВИРАЗ           замінити власні рядки модуля в розкладі агента (нові — зі stdin)
  module-setup.py env-add КОНФІГ ШАБЛОН   додати в наявний конфіг налаштування шаблону, яких у ньому немає

A module's helpers are not managed files: their owner may have edited them. `install` keeps, beside the
module's release record, the hash of every file it put in place, and replaces only a file that is missing,
already the same, or still the bytes it installed. Anything else stops the whole setup before one file is
written; the kit's own version is left beside the record for the operator to compare.
"""
from __future__ import annotations

import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

STATE = Path.home() / ".claude/product/modules"


def env_reader():
    """merge-env.py beside this file: the one reader of these configs. What it takes for a setting is a setting."""
    spec = importlib.util.spec_from_file_location("merge_env", Path(__file__).with_name("merge-env.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setting(line: str, reader) -> str | None:
    """The name a line assigns, by that reader's grammar: leading whitespace and `export` included."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    name, separator, _ = stripped.partition("=")
    return name if separator and reader.ASSIGNMENT.fullmatch(name) else None


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.kit-module")
    temporary.write_bytes(data)
    temporary.chmod(mode)
    os.replace(temporary, path)


def install(name: str, staged: Path, check: bool = False) -> int:
    home = Path.home()
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = STATE / f"{name}.files.json"
    try:
        accepted = json.loads(record.read_text(encoding="utf-8")) if record.exists() else {}
    except (OSError, ValueError):
        accepted = {}  # a record that cannot be read vouches for nothing
    if not isinstance(accepted, dict):
        accepted = {}
    planned, conflicts = [], []
    for source in sorted(path for path in staged.rglob("*") if path.is_file() and not path.is_symlink()):
        relative = source.relative_to(staged).as_posix()
        target = home / relative
        new = digest(source)
        if target.is_symlink() or (target.exists() and not target.is_file()):
            conflicts.append(relative)
        elif target.exists() and digest(target) not in (new, accepted.get(relative)):
            conflicts.append(relative)
        else:
            planned.append((source, target, relative, new))
    if conflicts:
        kept = STATE / f"{name}.planned"
        shutil.rmtree(kept, ignore_errors=True)
        for relative in conflicts:
            write(kept / relative, (staged / relative).read_bytes(), 0o600)
        print(f"Модуль «{name}» не поставлено, жодного файлу не змінено: ці файли вже є і відрізняються від того, "
              "що ставив комплект (їх міг правити власник):", file=sys.stderr)
        for relative in conflicts:
            print(f"  ~/{relative}  — версія комплекту для порівняння: {kept / relative}", file=sys.stderr)
        print("Сам їх не видаляй і не замінюй. Покажи власникові цей список: якщо його правка не потрібна, він "
              "прибирає файл, і тоді налаштування можна запустити ще раз.", file=sys.stderr)
        return 3
    if check:
        return 0
    for source, target, relative, new in planned:
        write(target, source.read_bytes(), stat.S_IMODE(source.stat().st_mode))
        accepted[relative] = new
    write(record, (json.dumps(accepted, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(), 0o600)
    shutil.rmtree(STATE / f"{name}.planned", ignore_errors=True)
    return 0


def crontab(own: str) -> int:
    pattern = re.compile(own)
    wanted = [line for line in sys.stdin.read().splitlines() if line.strip()]
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    environment = {**os.environ, "LC_ALL": "C"}
    # Two setups at once must not each write the schedule the other has just read.
    with open(STATE / ".crontab.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        read = subprocess.run(["crontab", "-l"], capture_output=True, text=True, env=environment)
        if read.returncode == 0:
            current = read.stdout
        elif re.search(r"no crontab for", read.stderr, re.IGNORECASE):
            current = ""
        else:
            # Anything but a proven empty schedule: writing now would wipe the watchdogs and backups.
            print("Розклад агента (crontab) не прочитано, тому його не змінено: "
                  + (read.stderr.strip() or f"код {read.returncode}"), file=sys.stderr)
            return 4
        lines = current.splitlines()
        if [line for line in lines if pattern.search(line)] == wanted:
            return 0  # already there: a rerun writes nothing
        new = "".join(line + "\n" for line in [line for line in lines if not pattern.search(line)] + wanted)
        written = subprocess.run(["crontab", "-"], input=new, capture_output=True, text=True, env=environment)
        if written.returncode != 0:
            print("Розклад агента (crontab) не записано: " + (written.stderr.strip() or f"код {written.returncode}"),
                  file=sys.stderr)
            return 4
    return 0


def env_add(config: Path, template: Path) -> int:
    wanted = template.read_text(encoding="utf-8")
    if not config.exists():
        write(config, wanted.encode(), 0o600)
        return 0
    reader = env_reader()
    try:
        # A file the reader refuses is not guessed at: appending to it could only make it worse.
        have = set(reader.parse(config))
        current = config.read_text(encoding="utf-8")
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Конфіг {config} не читається ({error}), тому в ньому нічого не змінено. Виправ цей рядок і "
              "запусти налаштування ще раз.", file=sys.stderr)
        return 5
    added: list[str] = []
    comments: list[str] = []
    for line in wanted.splitlines():
        name = setting(line, reader)
        if name is None:
            comments = comments + [line] if line.strip() else []
            continue
        if name not in have:
            have.add(name)
            added += ["", *comments, line]
        comments = []
    if added:
        # The owner's lines stay byte for byte; only what is missing is appended.
        write(config, (current + ("" if current.endswith("\n") or not current else "\n") + "\n".join(added) + "\n").encode(), 0o600)
    else:
        config.chmod(0o600)
    return 0


def main() -> int:
    arguments = sys.argv[1:]
    if len(arguments) == 3 and arguments[0] in ("install", "check") and re.fullmatch(r"[a-z][a-z0-9-]{0,40}", arguments[1]):
        return install(arguments[1], Path(arguments[2]), check=arguments[0] == "check")
    if len(arguments) == 2 and arguments[0] == "crontab":
        return crontab(arguments[1])
    if len(arguments) == 3 and arguments[0] == "env-add":
        return env_add(Path(arguments[1]), Path(arguments[2]))
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
