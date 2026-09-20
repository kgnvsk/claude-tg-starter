#!/usr/bin/env python3
"""Install verified Claude foundation files; the native host owns auth and services."""
from datetime import date
import json
import os
from pathlib import Path
import sys
from install import apply_reconcile, atomic, plan_reconcile, safe_path, starter_configuration, verify
from setup import plan_configuration


def prepare(data):
    home = Path(data['home'])
    if not home.is_absolute() or home.resolve() != home:
        raise ValueError('an absolute owned home is required')
    marker = safe_path(home, 'installation.json')
    info = marker.stat()
    if info.st_nlink != 1 or info.st_size > 4096 or (hasattr(os, 'getuid') and info.st_uid != os.getuid()):
        raise ValueError('invalid local installation marker')
    identity = json.loads(marker.read_text())
    if (identity.get('schemaVersion') != 1 or identity.get('engine') != 'claude'
            or data.get('engine') != 'claude'
            or any(identity.get(key) != str(data[key]) for key in ('id', 'botId', 'ownerChatId'))):
        raise ValueError('local Claude identity mismatch')
    root = Path(data['payload'])
    manifest = verify(root, 'claude')
    if manifest['productId'] != data['productId']:
        raise ValueError('selected product does not match payload')
    state = safe_path(home, '.local/share/novsky-kit/managed.json')
    previous = json.loads(state.read_text()) if state.exists() else {}
    configuration = plan_configuration(home, starter_configuration(manifest, data, previous), previous, '.claude')
    effective = configuration['data']
    previous = {**previous, 'ownerChatId': effective['ownerChatId'], 'timezone': effective['timezone']}
    render = {'AGENT_NAME': effective['agentName'], 'OWNER_NAME': data.get('ownerName') or '', 'OWNER_TG_USERNAME': data.get('ownerUsername') or '',
              'OWNER_CHAT_ID': effective['ownerChatId'], 'BOT_USERNAME': data.get('botUsername') or '', 'TIMEZONE': effective['timezone'],
              'CALENDAR_EMAIL': 'primary', 'DEPLOY_DATE': date.today().isoformat(), 'AGENT_HOME': str(home),
              'AGENT_SERVICE': 'com.novsky.agent.' + data['id'], 'AGENT_USER': data['id']}
    plan = plan_reconcile(root, home, manifest, previous, render)
    uid, gid = (os.getuid(), os.getgid()) if hasattr(os, 'getuid') else (-1, -1)
    apply_reconcile(plan, uid, gid)
    for path, content, mode in configuration['writes']:
        atomic(path, content, uid, gid, mode)
    atomic(safe_path(home, '.local/share/novsky-kit/manifest.json'), json.dumps(manifest), uid, gid)
    atomic(state, json.dumps({**previous, 'files': plan['files'], 'productId': manifest['productId'],
                             'revision': manifest['sourceRevision']}), uid, gid)
    return {'ok': True, 'productId': manifest['productId'], 'skills': len(manifest['nativeSkills']), 'plugins': 0}


if __name__ == '__main__':
    print(json.dumps(prepare(json.load(sys.stdin))))
