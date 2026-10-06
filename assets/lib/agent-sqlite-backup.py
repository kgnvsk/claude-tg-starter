#!/usr/bin/env python3
"""Root-private recovery copy; all SQLite and agent paths run as the agent UID."""
import os
from pathlib import Path
import pwd
import stat
import sys
import time

MAX_BYTES = 512 * 1024 * 1024


def directory(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('absolute path required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = following
        return fd
    except BaseException:
        os.close(fd)
        raise


def copy_as_agent(source, output, identity, max_bytes):
    import sqlite3
    if os.geteuid() != identity.pw_uid or os.geteuid() == 0:
        raise ValueError('agent UID required for SQLite')
    parent = directory(source.parent)
    guard = temp_fd = temp_parent = None
    source_db = target_db = None
    temporary = None
    try:
        guard = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(guard)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != identity.pw_uid
                or before.st_nlink != 1 or not 0 < before.st_size <= max_bytes):
            raise ValueError('unsafe source database')
        source_db = sqlite3.connect('file:/proc/self/fd/' + str(parent) + '/' + source.name + '?mode=ro', uri=True, timeout=10)
        source_db.execute('PRAGMA query_only=ON')
        page_size = source_db.execute('PRAGMA page_size').fetchone()[0]
        now = os.stat(source.name, dir_fd=parent, follow_symlinks=False)
        if (now.st_dev, now.st_ino) != (before.st_dev, before.st_ino):
            raise ValueError('source database changed')
        deadline = time.monotonic() + 120
        def progress(status, remaining, total):
            if time.monotonic() > deadline or total * page_size > max_bytes:
                raise ValueError('snapshot exceeds its budget')
        # Python 3.10 has no serialize. Use a private, exclusive agent-owned
        # temporary in the same profile; never grant access to root's folder.
        logs = source.parents[3] / 'logs'
        temp_parent = directory(logs)
        parent_info = os.fstat(temp_parent)
        if parent_info.st_uid != identity.pw_uid or parent_info.st_mode & 0o022:
            raise ValueError('unsafe agent snapshot directory')
        temporary = '.sqlite-preimage-' + os.urandom(16).hex()
        temp_fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=temp_parent)
        created = os.fstat(temp_fd)
        target_db = sqlite3.connect('/proc/self/fd/' + str(temp_parent) + '/' + temporary)
        source_db.backup(target_db, pages=256, progress=progress)
        target_db.close(); target_db = None
        current = os.stat(temporary, dir_fd=temp_parent, follow_symlinks=False)
        if ((current.st_dev, current.st_ino, current.st_uid, current.st_nlink)
                != (created.st_dev, created.st_ino, identity.pw_uid, 1) or current.st_size > max_bytes):
            raise ValueError('agent snapshot changed or exceeds its budget')
        os.lseek(temp_fd, 0, os.SEEK_SET)
        with os.fdopen(os.dup(output), 'wb') as target:
            while True:
                block = os.read(temp_fd, 65536)
                if not block:
                    break
                target.write(block)
            target.flush(); os.fsync(target.fileno())
    finally:
        if source_db is not None: source_db.close()
        if target_db is not None: target_db.close()
        if temp_fd is not None:
            own = os.fstat(temp_fd)
            if temporary is not None:
                try:
                    current = os.stat(temporary, dir_fd=temp_parent, follow_symlinks=False)
                    if (current.st_dev, current.st_ino) == (own.st_dev, own.st_ino):
                        os.unlink(temporary, dir_fd=temp_parent); os.fsync(temp_parent)
                except FileNotFoundError: pass
            os.close(temp_fd)
        if temp_parent is not None: os.close(temp_parent)
        if guard is not None: os.close(guard)
        os.close(parent)


def backup_database(source, destination, user):
    if os.geteuid() != 0:
        raise ValueError('private recovery output requires root')
    identity = pwd.getpwnam(user)
    source, destination = Path(source), Path(destination)
    if identity.pw_uid == 0 or source.name != 'messages.db' or source.parts[-4:-1] != ('.claude', 'channels', 'telegram'):
        raise ValueError('invalid agent ledger')
    output_parent = directory(destination.parent)
    output = None
    try:
        info = os.fstat(output_parent)
        if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('private root recovery folder required')
        output = os.open(destination.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=output_parent)
        child = os.fork()
        if child == 0:
            try:
                os.setgroups([]); os.setgid(identity.pw_gid); os.setuid(identity.pw_uid)
                copy_as_agent(source, output, identity, MAX_BYTES)
                os._exit(0)
            except BaseException: os._exit(2)
        _, status = os.waitpid(child, 0)
        if not os.WIFEXITED(status) or os.WEXITSTATUS(status):
            raise ValueError('agent recovery snapshot refused')
        os.fsync(output_parent)
    finally:
        if output is not None: os.close(output)
        os.close(output_parent)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4: raise ValueError('expected source destination agent')
        backup_database(*sys.argv[1:])
    except (OSError, ValueError, KeyError):
        sys.exit('agent database snapshot refused; nothing was installed')
