#!/usr/bin/env python3
"""Shared receipts for messages sent by tools, never proof that the human typed a message."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import time
from zoneinfo import ZoneInfo


class AuditError(RuntimeError):
    pass


def check_hours(home: Path, confirmed: bool = False, now: datetime | None = None) -> None:
    """No default curfew. An owner's explicit send can override their configured automatic-reply hours."""
    if confirmed:
        return
    path = home / '.claude/personal-inbox/send-policy.json'
    try:
        policy = json.loads(path.read_text())
    except FileNotFoundError:
        return
    except (OSError, ValueError) as error:
        raise AuditError('правило годин надсилання не читається; не надіслано') from error
    try:
        zone = ZoneInfo(policy['timezone'])
        def minute(value):
            h, m = value.split(':')
            if len(h) != 2 or len(m) != 2 or not (0 <= int(h) < 24 and 0 <= int(m) < 60):
                raise ValueError('invalid time')
            return int(h) * 60 + int(m)
        start, end = minute(policy['quietStart']), minute(policy['quietEnd'])
        local = (now or datetime.now(zone)).astimezone(zone)
        current = local.hour * 60 + local.minute
        quiet = start <= current < end if start < end else current >= start or current < end
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise AuditError('правило годин надсилання некоректне; не надіслано') from error
    if quiet:
        raise AuditError('зараз години тиші власника; не надіслано, відклади до їх завершення')


def save(path: Path, row: dict) -> None:
    tmp = path.with_name(path.name + '.' + secrets.token_hex(6) + '.tmp')
    try:
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            json.dump(row, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


class Receipt:
    def __init__(self, home: Path, via: str, peer, text: str, source: str, name: str = ''):
        outbox = home / '.claude/personal-inbox/outbox'
        outbox.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.journal = outbox / 'sent.jsonl'
        # Refuse a broken/unwritable journal before the transport sees the request.
        fd = os.open(self.journal, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        folder = outbox / 'receipts'
        folder.mkdir(mode=0o700, exist_ok=True)
        self.path = folder / (secrets.token_hex(16) + '.json')
        self.row = dict(ts=time.time(), via=via, peer=peer, name=name, chars=len(text), actor='agent',
                        source=source, message_id='', state='uncertain', uncertain=True)
        save(self.path, self.row)  # process death after handoff remains an uncertain attempt

    def finish(self, state: str, message_id: str = '') -> None:
        self.row.update(state=state, message_id=str(message_id), uncertain=state == 'uncertain')
        save(self.path, self.row)  # authoritative even if appending the shared index fails
        if state == 'failed':
            return
        with os.fdopen(os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW), 'a') as handle:
            handle.write(json.dumps(self.row, ensure_ascii=False) + '\n')
            handle.flush()
            os.fsync(handle.fileno())


@contextmanager
def attempt(home: Path, via: str, pending: dict, source: str, unknown):
    receipt = Receipt(home, via, pending['peer'], pending['text'], source, pending.get('name', ''))
    result = {'message_id': ''}
    try:
        yield result
    except BaseException as error:
        try:
            # Cancellation/invalid response can follow an accepted write too. Only a local
            # refusal proves no handoff; do not turn an unfamiliar exception into "not sent".
            receipt.finish('failed' if isinstance(error, (SystemExit, AuditError)) else 'uncertain')
        except OSError:
            pass  # durable intent survives; never hide the transport's original outcome
        raise
    else:
        try:
            receipt.finish('sent', result['message_id'])
        except OSError as error:
            raise unknown(f'надіслано {result["message_id"]}; квитанція {receipt.path}; журнал недоступний. Не повторюй') from error


def known_ids(home: Path, via: str, peer=None) -> set[str]:
    found = set()
    if via == 'telegram' and peer is None:
        return found  # a Telegram message id alone is not a chat identity
    def matches(row):
        return row.get('via') == via and (peer is None or str(row.get('peer')) == str(peer))
    folder = home / '.claude/personal-inbox/outbox'
    try:
        with (folder / 'sent.jsonl').open() as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                    if matches(row) and row.get('message_id'):
                        found.add(str(row['message_id']))
                except (ValueError, AttributeError):
                    pass
    except OSError:
        pass  # missing receipts never prove human authorship
    for path in (folder / 'receipts').glob('*.json'):
        try:
            row = json.loads(path.read_text())
            if matches(row) and row.get('state') == 'sent' and row.get('message_id'):
                found.add(str(row['message_id']))
        except (OSError, ValueError, AttributeError):
            pass
    return found
