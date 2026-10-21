"""Telegram endpoint shared by the bot's CLI and cron senders.

A local API is opt-in. Invalid configuration never falls back to Telegram's cloud:
that would log the same bot into a second receiver after the operator's cutover.
"""
from pathlib import Path
import os
import re
import stat
from urllib.parse import urlsplit

CLOUD_API = 'https://api.telegram.org'


def setting(name, state_dir=None):
    if name in os.environ:
        return os.environ[name].strip()
    directory = Path(state_dir or os.environ.get('TELEGRAM_STATE_DIR') or Path.home() / '.claude/channels/telegram')
    try:
        with (directory / '.env').open(encoding='utf-8') as handle:
            for line in handle:
                match = re.fullmatch(r'(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=(.*)', line.strip())
                if match and match[1] == name:
                    value = match[2].strip()
                    return value[1:-1] if len(value) >= 2 and value[0] in '\"\'' and value[-1] == value[0] else value
    except FileNotFoundError:
        pass
    return ''


def api_base(state_dir=None):
    raw = setting('TELEGRAM_API_BASE', state_dir) or CLOUD_API
    if raw in (CLOUD_API, CLOUD_API + '/'):
        return CLOUD_API
    # Compare the literal hostname too: URL parsers normalise some surprising names.
    if not re.fullmatch(r'http://(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}/?', raw):
        raise ValueError('TELEGRAM_API_BASE must be Telegram cloud or HTTP loopback with a port')
    url = urlsplit(raw)
    if not url.port or not 0 < url.port <= 65535:
        raise ValueError('TELEGRAM_API_BASE has an invalid port')
    return raw.rstrip('/')


def is_local():
    return api_base() != CLOUD_API


def local_file_root():
    if not is_local():
        return None
    raw = setting('TELEGRAM_LOCAL_FILE_ROOT')
    root = Path(raw)
    if not raw or not root.is_absolute() or '..' in root.parts or root == Path('/'):
        raise ValueError('TELEGRAM_LOCAL_FILE_ROOT must name a private absolute directory')
    metadata = root.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_mode & 0o007:
        raise ValueError('TELEGRAM_LOCAL_FILE_ROOT is not a private directory')
    return root


def open_local_file(path):
    """Open only a regular descendant, without following a symlink at any level."""
    root = local_file_root()
    candidate = Path(path)
    if root is None or not candidate.is_absolute() or '..' in candidate.parts:
        raise ValueError('Telegram returned an invalid local file path')
    try:
        relative = candidate.relative_to(root)
    except ValueError:
        raise ValueError('Telegram returned a file outside its local directory') from None
    if not relative.parts:
        raise ValueError('Telegram returned a directory instead of a file')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for component in relative.parts[:-1]:
            nested = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory); directory = nested
        descriptor = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    finally:
        os.close(directory)
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        os.close(descriptor)
        raise ValueError('Telegram returned a non-regular file')
    return os.fdopen(descriptor, 'rb')
