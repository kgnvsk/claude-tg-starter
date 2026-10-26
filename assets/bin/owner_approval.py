#!/usr/bin/env python3
"""One owner message authorizes one immutable preview. No network or model calls."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3


def fingerprint(payload):
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def connect(home):
    folder = Path(home)/'.claude/owner-approvals'
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder/'state.db'
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.executescript('''CREATE TABLE IF NOT EXISTS previews(
      kind TEXT,id TEXT,owner TEXT,payload_hash TEXT,preview TEXT,created REAL,
      PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS consumed(
      kind TEXT,id TEXT,owner TEXT,message TEXT,payload_hash TEXT,
      PRIMARY KEY(kind,id),UNIQUE(owner,message));''')
    os.chmod(path, 0o600)
    return db


def register(home, kind, ident, owner, payload, preview, created):
    with closing(connect(home)) as db, db:
        db.execute('INSERT INTO previews VALUES(?,?,?,?,?,?)',
                   (kind,ident,str(owner),fingerprint(payload),preview,created))


def proof(home, kind, ident, owner, payload, *, replacement=None):
    """Private, explicitly affirmative reply to this exact shown preview; fail closed on ambiguity."""
    normalize = lambda text: ' '.join(text.split())
    try:
        with closing(connect(home)) as db:
            row = db.execute('SELECT * FROM previews WHERE kind=? AND id=?', (kind,ident)).fetchone()
            if (not row or row['owner'] != str(owner) or row['payload_hash'] != fingerprint(payload)
                or db.execute('SELECT 1 FROM consumed WHERE kind=? AND id=?',(kind,ident)).fetchone()):
                return None
            # Other questions asked lately: a plain yes to a preview that shows no id must not be shared with one of them.
            others = {normalize(other['preview'] or '') for other in db.execute(
                'SELECT preview FROM previews WHERE NOT (kind=? AND id=?) AND created>?',
                (kind,ident,row['created']-86400))} - {'', normalize(row['preview'])}
        channel = Path(home)/'.claude/channels/telegram/messages.db'
        with closing(sqlite3.connect(f'file:{channel}?mode=ro',uri=True,timeout=5)) as db:
            db.row_factory = sqlite3.Row
            # Latest owner decision only: a later refusal or unrelated reply cannot reuse an earlier yes.
            incoming = db.execute("SELECT * FROM messages WHERE chat_id=? AND direction='in' AND ts>? ORDER BY ts DESC,id DESC LIMIT 1",
                                  (str(owner),int(row['created']*1000))).fetchone()
            if not incoming or str(incoming['user_id']) != str(owner): return None
            reply = (incoming['text'] or '').strip()
            if incoming['message_id'] is None: return None
            reply_to = None
            if incoming['message_id'] is not None:
                delivery = str(owner)+':'+str(incoming['message_id'])
                request = db.execute('SELECT request_payload FROM delivery_results WHERE delivery_id=?',(delivery,)).fetchone()
                if not request: return None
                meta = json.loads(request[0]).get('params',{}).get('meta',{})
                if (str(meta.get('user_id'))!=str(owner) or str(meta.get('chat_id'))!=str(owner)
                    or meta.get('delivery_id')!=delivery or meta.get('forward_from') is not None
                    or meta.get('sender_chat_id') is not None): return None
                reply_to = meta.get('reply_to_message_id')
            explicit = re.search(r'(?:^|\s)\[?'+re.escape(ident)+r'\]?[.!✅]*$',reply) is not None
            history = db.execute("SELECT direction,text,message_id FROM messages WHERE chat_id=? AND ts>? AND ts<? ORDER BY ts,id",
                                 (str(owner),int(row['created']*1000),incoming['ts'])).fetchall()
            groups, group = [], []
            for message in history:
                if message['direction']=='out': group.append(message)
                elif group: groups.append(group); group=[]
            if group: groups.append(group)
            candidates = groups if explicit or reply_to is not None else groups[-1:]
            plain = not explicit and reply_to is None
            # A human preview (root, 24.10.2026) shows the owner no id or command: his plain yes binds to it only as the
            # last thing he was shown, with nothing after it and no other question in that group.
            hidden = ident not in row['preview']
            found = False
            for block in candidates:
                if plain and not hidden and ident not in (block[-1]['text'] or ''): continue
                pieces = [normalize(m['text'] or '') for m in block]
                text = ' '.join(pieces)
                start = text.find(normalize(row['preview']))
                if start < 0: continue
                end = start + len(normalize(row['preview']))
                offset, shown = 0, []
                for m,piece in zip(block,pieces):
                    if offset < end and offset+len(piece) > start: shown.append(m)
                    offset += len(piece)+1
                if reply_to is not None and not any(str(m['message_id'])==str(reply_to) for m in shown): continue
                identifiers={a or b for a,b in re.findall(r'\[([0-9a-f]{6})\]|--confirm ([0-9a-f]{6})',text)}
                if plain and not hidden and len(identifiers)>1: continue
                if plain and hidden and (not text.endswith(normalize(row['preview'])) or identifiers-{ident}
                                         or any(other in text for other in others)): continue
                found=True
            if not found: return None
            if replacement is not None:
                edit = re.fullmatch(r'(?:напиши|надішли|отправь|send|reply)\s*:\s*(.+)',reply,re.I|re.S)
                if not edit or edit.group(1).strip() != replacement: return None
            elif not re.fullmatch(r'(?:так|да|yes|ok|okay|добре|согласен|підтверджую|подтверждаю|надішли|отправь|send)(?:\s+\[?'+re.escape(ident)+r'\]?)?[.!✅]*',reply,re.I):
                return None
            return {'message':str(incoming['id']), 'payload_hash':fingerprint({**payload,'text':replacement} if replacement is not None else payload)}
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        return None


def approve(home, kind, ident, owner, payload, *, replacement=None, consume=False):
    evidence = proof(home,kind,ident,owner,payload,replacement=replacement)
    if not evidence: return False
    try:
        with closing(connect(home)) as db, db:
            if db.execute('SELECT 1 FROM consumed WHERE owner=? AND message=?',(str(owner),evidence['message'])).fetchone():
                return False
            if consume:
                db.execute('INSERT INTO consumed VALUES(?,?,?,?,?)',
                           (kind,ident,str(owner),evidence['message'],evidence['payload_hash']))
        return True
    except sqlite3.Error:
        return False


def consume_request(home, kind, ident, owner, payload, request):
    """Caller already verified the current owner request and its explicit send instruction."""
    try:
        with closing(connect(home)) as db, db:
            row=db.execute('SELECT * FROM previews WHERE kind=? AND id=?',(kind,ident)).fetchone()
            if not row or row['owner']!=str(owner) or row['payload_hash']!=fingerprint(payload): return False
            db.execute('INSERT INTO consumed VALUES(?,?,?,?,?)',
                       (kind,ident,str(owner),'request:'+request,fingerprint(payload)))
        return True
    except sqlite3.Error:
        return False
