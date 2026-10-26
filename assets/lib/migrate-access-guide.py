#!/usr/bin/env python3
"""Replace only the published Claude access guide; preserve an exact rollback copy."""
import argparse
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import uuid

# release/2026-10-23.a8edb898ce62 (peeled a8edb898ce6285ca40de34d8169cb7735b25ec6f)
# and origin/main a4a700154c9d2184551cb189d19f9e49d6ec0cb9 have the same blob
# e5e34b666f547248c9161c9ff18c44e853630ea1. No fuzzy/line-based matching.
STOCK_SHA256 = 'c74b88d89b7498793339ff0552e51e1569782268967e8bb5c4a69e335873b6d5'
BACKUP_NAME = 'access-security.r21.' + STOCK_SHA256 + '.md'
NAME = 'access-security.md'
LIMIT = 128 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(info):
    # Reading may update atime on Linux; it is not a content/ownership change.
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def checked_dir(fd, uid, *, ancestor=False):
    info = os.fstat(fd)
    sticky_root = ancestor and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid)
            or (info.st_mode & 0o022 and not sticky_root)):
        raise ValueError('unsafe access-guide directory')


def directory(stack, path, uid):
    """Pin every absolute component without resolving symlinks."""
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('absolute access-guide path required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    stack.callback(os.close, fd)
    for part in path.parts[1:]:
        fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        stack.callback(os.close, fd)
        checked_dir(fd, uid, ancestor=True)
    checked_dir(fd, uid)
    return fd


def child_dir(stack, parent, name, uid, gid, *, create=False):
    made = False
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            made = True
        except FileExistsError:
            pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    stack.callback(os.close, fd)
    if made:
        os.fchown(fd, uid, gid)
    checked_dir(fd, uid)
    return fd


def read_at(parent, name, uid):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid not in (0, uid) or info.st_mode & 0o022
                or info.st_size > LIMIT):
            raise ValueError('unsafe access-guide file')
        with os.fdopen(os.dup(fd), 'rb') as stream:
            data = stream.read(LIMIT + 1)
        if len(data) > LIMIT or identity(os.fstat(fd)) != identity(info):
            raise ValueError('access-guide file changed while reading')
        return data, info
    finally:
        os.close(fd)


def write_file(parent, name, data, uid, gid, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=parent)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fchown(fd, uid, gid)
            os.fchmod(fd, mode)
            os.fsync(fd)
    finally:
        os.close(fd)


def backup_stock(parent, data, uid, gid):
    try:
        old, _ = read_at(parent, BACKUP_NAME, uid)
        if old != data:
            raise ValueError('access-guide backup differs; refusing overwrite')
    except FileNotFoundError:
        write_file(parent, BACKUP_NAME, data, uid, gid, 0o600)
        os.fsync(parent)


def replace_checked(parent, expected, old_info, updated, uid, gid):
    temporary = '.access-guide-' + uuid.uuid4().hex
    try:
        write_file(parent, temporary, updated, uid, gid, stat.S_IMODE(old_info.st_mode))
        current, info = read_at(parent, NAME, uid)
        if current != expected or identity(info) != identity(old_info):
            raise ValueError('access-guide changed before replacement')
        os.replace(temporary, NAME, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass


def migrate(source, home, uid, gid, *, rollback=False, engine='claude'):
    if engine != 'claude':
        return {'status': 'unsupported-engine'}
    with ExitStack() as stack:
        source = Path(source)
        source_dir = directory(stack, source.parent, os.geteuid())
        updated, _ = read_at(source_dir, source.name, os.geteuid())
        if not updated or digest(updated) == STOCK_SHA256:
            raise ValueError('corrected access-guide source required')
        home_fd = directory(stack, home, uid)
        if os.fstat(home_fd).st_uid != uid:
            raise ValueError('access-guide home owner mismatch')
        try:
            target = home_fd
            for component in ('obsidian-vault', 'wiki', 'concepts'):
                target = child_dir(stack, target, component, uid, gid)
            current, info = read_at(target, NAME, uid)
        except FileNotFoundError:
            return {'status': 'absent'}
        if not rollback and current == updated:
            return {'status': 'current'}
        if not rollback and digest(current) != STOCK_SHA256:
            return {'status': 'preserved-custom'}
        if rollback and current != updated:
            raise ValueError('rollback requires the unchanged corrected guide')
        backups = child_dir(stack, home_fd, 'backups', uid, gid, create=not rollback)
        if rollback:
            replacement, _ = read_at(backups, BACKUP_NAME, uid)
            if digest(replacement) != STOCK_SHA256:
                raise ValueError('rollback backup is not the published stock guide')
        else:
            backup_stock(backups, current, uid, gid)
            replacement = updated
        replace_checked(target, current, info, replacement, uid, gid)
        return {'status': 'rolled-back' if rollback else 'migrated',
                'before_sha256': digest(current), 'after_sha256': digest(replacement),
                'backup': str(Path(home) / 'backups' / BACKUP_NAME)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('home')
    parser.add_argument('--user', required=True)
    parser.add_argument('--engine', required=True, choices=('claude', 'codex'))
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    user = pwd.getpwnam(args.user)
    try:
        print(json.dumps(migrate(args.source, args.home, user.pw_uid, user.pw_gid,
                                 rollback=args.rollback, engine=args.engine)))
    except (OSError, ValueError) as error:
        parser.exit(1, 'access-guide migration stopped: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
