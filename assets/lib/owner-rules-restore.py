#!/usr/bin/env python3
"""Put an agent's owner rules back into CLAUDE.md when it comes from main's line.

Main's line (until 28.10.2026) kept owner rules in ~/.claude/owner-rules/index.json. Its CLAUDE.md has one kit line naming
that library right under «# Правила власника», and with reads off main also rendered every rule into a kit-owned
~/.claude/CLAUDE.md. V2 has neither the library helpers nor that rendering and reads the rules in CLAUDE.md, so the update
writes the active rules in place of that one line, whole and in order, keeps every other byte, records that it is done
and then retires the rendered copy. The library stays; both previous files are kept beside it. It runs inside the
maintenance window (the agent is stopped) under main's own rule lock, and rereads every file before it writes. Anything
ambiguous stops the update instead of guessing: a kit line edited or found twice, rules living only in the library, a
rendered copy edited by hand, or a rule for a company chat, which has no place in the owner's CLAUDE.md.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time

HEADING = '# Правила власника'
MARK = 'Правила збережено без скорочень у ~/.claude/owner-rules/index.json.'
# Main's four kit lines, exactly as its owner-rules and answer-context wrote them.
REFERENCES = (
    MARK + ' Перед відповіддю прочитай актуальні правила й переписку через answer-context. Зміни правил зберігай через'
    ' owner-rules з джерелом, областю дії та явною заміною старого правила.',
    MARK + ' Перед роботою: ~/bin/owner-rules context "тема запиту"; повне правило: ~/bin/owner-rules read ID. Нові правила'
    ' власника додавай нижче: вони підхоплюються окремо, чинні правила не губляться.',
    MARK + ' Кожне правило власника вже у твоїх інструкціях, цілком (~/.claude/CLAUDE.md; правила тем - в інструкціях'
    ' субагентів, що ведуть ці теми). Зміни правил зберігай через owner-rules з джерелом, областю дії та явною заміною'
    ' старого правила.',
    MARK + ' Кожне правило власника вже у твоїх інструкціях, цілком (~/.claude/CLAUDE.md; правила тем - в інструкціях'
    ' субагентів, що ведуть ці теми): перед відповіддю нічого не читай. Зміни правил зберігай через owner-rules з джерелом,'
    ' областю дії та явною заміною старого правила.',
)
ANCHORED = re.compile('(?m)^' + re.escape(HEADING) + r'[ \t]*\r?\n(' + '|'.join(map(re.escape, REFERENCES)) + r')(\r?\n)')
RULES_FILE_MARK = b'<!-- kit: every owner rule, rewritten on each save; change rules through the agent, not here -->'
RULES_FILE_END = re.compile(rb'<!-- kit: end of owner rules, ([0-9a-f]{64}) -->\n\Z')
OWNER_SCOPES = {'owner', 'all'}


def regular(path: Path) -> bool:
    return not path.is_symlink() and path.is_file() and path.lstat().st_nlink == 1


def read_regular(path: Path, label: str) -> bytes:
    if not regular(path):
        raise ValueError(f'{label} is not a regular file')
    return path.read_bytes()


def kit_rules_file(path: Path) -> bytes | None:
    """Main's rendered rules file, intact. A link or anything not starting with main's mark is the agent's own (main never
    wrote through a link); a copy with main's mark that was edited, or has another name, is ambiguous."""
    if path.is_symlink() or not path.is_file():
        return None
    raw = path.read_bytes()
    if not raw.startswith(RULES_FILE_MARK):
        return None
    end = RULES_FILE_END.search(raw)
    if path.lstat().st_nlink != 1 or end is None or hashlib.sha256(raw[:end.start()]).hexdigest() != end.group(1).decode():
        raise ValueError('the kit rules copy in ~/.claude/CLAUDE.md was edited by hand')
    return raw


def sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_file(path: Path, data: bytes, mode: int) -> None:
    """A complete file under its final name, or no change: temporary file, fsync, rename, fsync of the folder."""
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    sync_directory(path.parent)


def keep(path: Path, data: bytes) -> None:
    """A backup holds exactly these bytes: published once, or already there from a run that stopped."""
    if os.path.lexists(path):
        if read_regular(path, path.name) != data:
            raise ValueError(f'{path.name} already holds something else')
        return
    write_file(path, data, 0o600)


def transform(original: bytes, rules: list[str]) -> bytes | None:
    """CLAUDE.md with the active rules in place of main's one kit line; None when that line is not there exactly once."""
    text = original.decode('utf-8')
    anchored = list(ANCHORED.finditer(text))
    if len(anchored) != 1 or text.count(MARK) != 1:
        return None
    found = anchored[0]
    newline = found.group(2)
    body = (newline * 2).join(rule.replace('\n', newline) for rule in rules)
    return (text[:found.start(1)] + (body + newline if rules else '') + text[found.end(2):]).encode('utf-8')


class locked:
    """Main's own rule lock, so nothing of main's line writes the rules while they move."""
    def __init__(self, directory: Path):
        self.path = directory / 'write.lock'

    def __enter__(self):
        self.descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        deadline = time.monotonic() + 30
        while True:
            try:
                fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() > deadline:
                    os.close(self.descriptor)
                    raise ValueError('the owner rules are being written right now')
                time.sleep(0.2)

    def __exit__(self, *_):
        os.close(self.descriptor)


def same(path: Path, data: bytes) -> None:
    """An existing backup must hold exactly these bytes; the check before the stop compares without writing."""
    if os.path.lexists(path) and read_regular(path, path.name) != data:
        raise ValueError(f'{path.name} already holds something else')


class unlocked:
    def __init__(self, directory: Path):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass


def restore(home: Path, *, check: bool = False) -> str:
    library = home / '.claude/owner-rules/index.json'
    claude_md = home / 'CLAUDE.md'
    rules_file = home / '.claude/CLAUDE.md'
    backup = library.parent / 'CLAUDE.md.before-v2'
    rules_backup = library.parent / 'claude-rules-file.before-v2'
    done = library.parent / 'restored-v2.json'
    if not os.path.isdir(library.parent) or os.path.islink(library.parent):
        return 'no library'  # Nothing of main's library; a first save needs the agent, stopped for the update.
    # Everything is read under main's own lock, once, the library's presence included: what moves is what a finished
    # save left (Codex r4, r5). The check before the stop takes no lock and writes nothing.
    with (unlocked if check else locked)(library.parent):
        if not os.path.lexists(library) and not os.path.lexists(done):
            return 'no library'
        rendered = kit_rules_file(rules_file)
        if os.path.lexists(done):
            read_regular(done, 'restore record')
            if rendered is not None:
                same(rules_backup, rendered)
                if not check:
                    keep(rules_backup, rendered)
                    rules_file.unlink()
                    sync_directory(rules_file.parent)
            return 'nothing to restore'
        library_bytes = read_regular(library, 'owner rules library')
        value = json.loads(library_bytes.decode('utf-8'))
        rows = value.get('rules') if isinstance(value, dict) and value.get('schemaVersion') == 1 else None
        if not isinstance(rows, list) or not all(isinstance(row, dict) and isinstance(row.get('text'), str) for row in rows):
            raise ValueError('owner rules library is not readable')
        foreign = sorted({str(row.get('scope', 'owner')) for row in rows} - OWNER_SCOPES)
        if foreign:
            raise ValueError('owner rules for company chats need their own migration: ' + ', '.join(foreign))
        rules = [row['text'].strip().replace('\r\n', '\n') for row in rows if row['text'].strip()]
        current = read_regular(claude_md, 'CLAUDE.md')
        restored = transform(current, rules)
        resumed = False
        if restored is None:
            if MARK in current.decode('utf-8'):
                raise ValueError('CLAUDE.md names the owner rules library in a way this update does not know; restore it by hand')
            if os.path.lexists(backup) and transform(read_regular(backup, backup.name), rules) == current:
                resumed = True  # The new CLAUDE.md was written; the run stopped before its record.
            elif not rules:
                return 'nothing to restore'
            else:
                raise ValueError('owner rules live only in the library and CLAUDE.md does not name it; restore them by hand')
        else:
            same(backup, current)
        if rendered is not None:
            same(rules_backup, rendered)
        if check:
            return f'would restore {len(rows)}'
        if not resumed:
            keep(backup, current)
            write_file(claude_md, restored, claude_md.stat().st_mode & 0o7777)
        record = {'schemaVersion': 1, 'library': hashlib.sha256(library_bytes).hexdigest(), 'rules': len(rows)}
        write_file(done, (json.dumps(record) + '\n').encode(), 0o600)
        if rendered is not None:
            keep(rules_backup, rendered)
            rules_file.unlink()
            sync_directory(rules_file.parent)
    return f'restored {len(rows)}'


def main() -> int:
    check = sys.argv[1:2] == ['--check']
    arguments = sys.argv[2:] if check else sys.argv[1:]
    if len(arguments) != 1:
        print('використання: owner-rules-restore.py [--check] HOME_DIR', file=sys.stderr)
        return 2
    try:
        print(restore(Path(arguments[0]), check=check))
    except (OSError, ValueError, UnicodeError) as error:
        print(f'FATAL: правила власника не перенесено в CLAUDE.md: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
