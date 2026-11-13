#!/usr/bin/env python3
"""Root operator escape for one uncertain Telegram upload; never sends a file."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import pwd
import re
import stat
import time
import uuid

TABLE = 'outbound_file_attempts'
AUDIT = 'outbound_file_release_audit'
COLUMNS = ('chat_id', 'thread_key', 'sha256', 'attempt_id', 'delivery_id',
           'state', 'created_at', 'updated_at', 'message_id')
CREATE_AUDIT = '''CREATE TABLE IF NOT EXISTS outbound_file_release_audit (
    chat_id TEXT NOT NULL, thread_key TEXT NOT NULL, sha256 TEXT NOT NULL,
    attempt_id TEXT NOT NULL, delivery_id TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, message_id INTEGER,
    released_at INTEGER NOT NULL, acknowledged_possible_duplicate INTEGER NOT NULL,
    operator_reason TEXT NOT NULL,
    PRIMARY KEY(chat_id,thread_key,sha256,attempt_id))'''


def ensure_audit(db):
    db.execute(CREATE_AUDIT)


def validate_binding(row):
    if set(row) != set(COLUMNS):
        raise ValueError('exact original attempt fields required')
    if (not re.fullmatch(r'-?[1-9][0-9]{0,19}', row['chat_id'])
            or not re.fullmatch(r'|[1-9][0-9]{0,15}', row['thread_key'])
            or not re.fullmatch(r'[a-f0-9]{64}', row['sha256'])
            or str(uuid.UUID(row['attempt_id'])) != row['attempt_id']
            or not isinstance(row['delivery_id'], str)
            or not 1 <= len(row['delivery_id']) <= 4096
            or any(ord(c) < 32 for c in row['delivery_id'])
            or row['state'] != 'sending' or row['message_id'] is not None
            or any(type(row[k]) is not int or not 0 < row[k] < 2**53
                   for k in ('created_at', 'updated_at'))):
        raise ValueError('invalid exact uncertain-attempt binding')


def release(db, expected, *, acknowledge, reason):
    validate_binding(expected)
    if acknowledge is not True or not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
        raise ValueError('explicit acknowledgement of possible duplicate and operator reason required')
    if any(ord(c) < 32 for c in reason):
        raise ValueError('operator reason must be a single line')
    if db.in_transaction:
        raise ValueError('operator release requires its own transaction')
    db.execute('BEGIN IMMEDIATE')
    try:
        # Agent-controlled SQLite is interpreted only after dropping privileges.
        # Still refuse application triggers/views rather than executing unrelated effects.
        if db.execute('SELECT 1 FROM sqlite_master WHERE type=\'trigger\' AND tbl_name IN (?,?)',
                      (TABLE, AUDIT)).fetchone():
            raise ValueError('unexpected upload-ledger trigger')
        for table in (TABLE, AUDIT):
            found = db.execute('SELECT type FROM sqlite_master WHERE name=?', (table,)).fetchone()
            if found and found[0] != 'table':
                raise ValueError('upload ledger must be an ordinary table')
        current = db.execute('SELECT ' + ','.join(COLUMNS) + ' FROM outbound_file_attempts '
                             'WHERE chat_id=? AND thread_key=? AND sha256=?',
                             tuple(expected[k] for k in COLUMNS[:3])).fetchone()
        if current is None or dict(zip(COLUMNS, current)) != expected:
            raise ValueError('attempt changed, completed, absent or already released; inspect again')
        ensure_audit(db)
        released_at = int(time.time() * 1000)
        db.execute('INSERT INTO outbound_file_release_audit VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                   tuple(expected[k] for k in COLUMNS) + (released_at, 1, reason.strip()))
        deleted = db.execute('DELETE FROM outbound_file_attempts WHERE chat_id=? AND thread_key=? '
                             'AND sha256=? AND attempt_id=? AND delivery_id=? AND state=\'sending\' '
                             'AND created_at=? AND updated_at=? AND message_id IS NULL',
                             tuple(expected[k] for k in ('chat_id', 'thread_key', 'sha256',
                                  'attempt_id', 'delivery_id', 'created_at', 'updated_at'))).rowcount
        if deleted != 1:
            raise ValueError('attempt compare-and-swap failed')
        db.commit()
        return {'status': 'released-for-explicit-retry', 'attempt_id': expected['attempt_id'],
                'released_at': released_at, 'possible_duplicate': True, 'sent': False}
    except BaseException:
        db.rollback()
        raise


def drop_to_agent(user):
    # No agent path or SQLite bytes are opened by root, including inspect.
    if os.geteuid() != 0 or os.getuid() != 0:
        raise ValueError('root operator required; this command is not an agent tool')
    if not re.fullmatch(r'claude(?:-[a-z0-9][a-z0-9-]{0,23})?', user):
        raise ValueError('selected Claude instance required')
    identity = pwd.getpwnam(user)
    home = Path('/home') / user
    if identity.pw_uid == 0 or identity.pw_dir != str(home):
        raise ValueError('canonical non-root Claude home required')
    os.setgroups([])
    os.setgid(identity.pw_gid)
    os.setuid(identity.pw_uid)
    if os.geteuid() != identity.pw_uid or os.getuid() != identity.pw_uid:
        raise ValueError('failed to drop operator privileges')
    os.umask(0o077)
    os.environ.clear()
    os.chdir('/')
    return home, identity.pw_uid


def inspect(db, chat, thread, sha256, attempt=None):
    row = db.execute('SELECT ' + ','.join(COLUMNS) + ' FROM outbound_file_attempts '
                     'WHERE chat_id=? AND thread_key=? AND sha256=?', (chat, thread, sha256)).fetchone()
    result = {'status': 'found' if row else 'absent',
              'attempt': dict(zip(COLUMNS, row)) if row else None, 'release': None}
    if attempt and db.execute('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?', (AUDIT,)).fetchone():
        audit = db.execute('SELECT ' + ','.join(COLUMNS) + ',released_at,acknowledged_possible_duplicate '
                           'FROM outbound_file_release_audit WHERE chat_id=? AND thread_key=? '
                           'AND sha256=? AND attempt_id=?', (chat, thread, sha256, attempt)).fetchone()
        if audit:
            result['release'] = dict(zip(COLUMNS + ('released_at', 'acknowledged_possible_duplicate'), audit))
    return result


@contextmanager
def agent_database(home, uid):
    if os.geteuid() != uid or uid == 0:
        raise ValueError('agent UID required before opening SQLite')
    import sqlite3
    parent = guard = None
    db = None
    try:
        parent = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        path = Path(home) / '.claude/channels/telegram'
        current = Path('/')
        for part in path.parts[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = following
            info = os.fstat(parent)
            current /= part
            if (info.st_uid not in (0, uid) or info.st_mode & 0o022
                    or current == Path(home) and info.st_uid != uid):
                raise ValueError('unsafe agent ledger directory')
        guard = os.open('messages.db', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(guard)
        for name in ('messages.db', 'messages.db-wal', 'messages.db-shm', 'messages.db-journal'):
            try:
                info = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                if name == 'messages.db': raise
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1 or info.st_mode & 0o022:
                raise ValueError('unsafe agent SQLite file')
        # Linux installation only. Pin the already-checked directory for SQLite sidecars.
        db = sqlite3.connect('file:/proc/self/fd/' + str(parent) + '/messages.db?mode=rw', uri=True, timeout=5)
        if hasattr(db, 'setlimit'):
            db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 65536)
        after = os.stat('messages.db', dir_fd=parent, follow_symlinks=False)
        if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('agent database changed during open')
        deadline = time.monotonic() + 10
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
        db.execute('PRAGMA trusted_schema=OFF')
        db.execute('PRAGMA foreign_keys=OFF')
        db.execute('PRAGMA recursive_triggers=OFF')
        yield db
    finally:
        if db is not None: db.close()
        if guard is not None: os.close(guard)
        if parent is not None: os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
        epilog='Procedure: assets/lib/TROUBLESHOOTING-UNCERTAIN-UPLOAD.md in this trusted kit.')
    parser.add_argument('action', choices=('inspect', 'release'))
    parser.add_argument('--user', required=True)
    parser.add_argument('--chat-id', required=True)
    parser.add_argument('--thread-id', required=True, help='positive topic ID or none')
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--attempt-id')
    parser.add_argument('--delivery-id')
    parser.add_argument('--created-at', type=int)
    parser.add_argument('--updated-at', type=int)
    parser.add_argument('--acknowledge-possible-duplicate', action='store_true')
    parser.add_argument('--reason')
    args = parser.parse_args()
    try:
        home, uid = drop_to_agent(args.user)
        thread = '' if args.thread_id == 'none' else args.thread_id
        with agent_database(home, uid) as db:
            if args.action == 'inspect':
                result = inspect(db, args.chat_id, thread, args.sha256, args.attempt_id)
            else:
                result = release(db, dict(chat_id=args.chat_id, thread_key=thread, sha256=args.sha256,
                    attempt_id=args.attempt_id, delivery_id=args.delivery_id, state='sending',
                    created_at=args.created_at, updated_at=args.updated_at, message_id=None),
                    acknowledge=args.acknowledge_possible_duplicate, reason=args.reason)
            print(json.dumps(result))
    except Exception:
        # Do not print arbitrary SQLite errors or agent-controlled schema text.
        parser.exit(1, 'Upload release refused or unconfirmed; inspect the exact attempt before any retry.\n')


if __name__ == '__main__':
    main()
