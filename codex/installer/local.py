#!/usr/bin/env python3
"""Prepare the same managed kit inside an existing owner-only local installation.

The desktop installer owns dependency provisioning, credentials and the native
service. This entry point never starts a poller or changes the computer account.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tomllib

from install import (apply_reconcile, atomic, digest, native_config, plan_reconcile,
                     safe_path, starter_configuration, verify)
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
    if (identity.get('schemaVersion') != 1 or identity.get('engine') != 'codex'
            or identity.get('ownerChatId') != str(data['ownerChatId'])
            or identity.get('id') != data['id'] or identity.get('botId') != data['botId']):
        raise ValueError('local agent identity mismatch')
    root = Path(data['payload'])
    manifest = verify(root)
    if manifest['productId'] != data['productId']:
        raise ValueError('selected product does not match payload')
    state = safe_path(home, '.local/share/novsky-kit/managed.json')
    previous = json.loads(state.read_text()) if state.exists() else {}
    if not isinstance(previous, dict) or not isinstance(previous.get('files', {}), dict):
        raise ValueError('invalid managed state')
    configuration = plan_configuration(home, starter_configuration(manifest, data, previous), previous)
    effective = configuration['data']
    previous = {**previous, 'ownerChatId': effective['ownerChatId'], 'timezone': effective['timezone']}
    plan = plan_reconcile(root, home, manifest, previous)
    owner_home = Path(data['ownerHome'])
    if not owner_home.is_absolute() or owner_home == home:
        raise ValueError('invalid computer owner home')
    config = native_config(home, data['id'], None)
    rules = {str(owner_home): 'deny', str(home): 'read', str(home / 'obsidian-vault'): 'write',
             str(home / 'config.json'): 'deny', str(home / 'installation.json'): 'deny',
             str(home / 'logs'): 'deny', str(home / '.local/appdata'): 'deny'}
    config = config.replace('[permissions.novsky-agent.filesystem]\n', '[permissions.novsky-agent.filesystem]\n' +
                            '\n'.join(json.dumps(k) + ' = ' + json.dumps(v) for k, v in rules.items()) + '\n')
    project = safe_path(home, 'obsidian-vault/.codex/config.toml')
    if project.exists() and digest(project.read_bytes()) not in (digest(config.encode()), previous.get('configSha')):
        raise ValueError('local project configuration needs reconciliation')
    global_config = safe_path(home, '.codex/config.toml')
    global_text = global_config.read_text() if global_config.exists() else ''
    project_entry = tomllib.loads(global_text).get('projects', {}).get(str(home / 'obsidian-vault'))
    if project_entry is not None and project_entry.get('trust_level') != 'trusted':
        raise ValueError('the owner changed workspace trust; review it before installation')
    if project_entry is None:
        global_text += '\n[projects.' + json.dumps(str(home / 'obsidian-vault')) + ']\ntrust_level = "trusted"\n'
    uid, gid = (os.getuid(), os.getgid()) if hasattr(os, 'getuid') else (-1, -1)
    # Complete validation precedes every mutation, just as in the server installer.
    apply_reconcile(plan, uid, gid)
    for path, content, mode in configuration['writes']:
        atomic(path, content, uid, gid, mode)
    atomic(project, config, uid, gid)
    atomic(global_config, global_text, uid, gid)
    atomic(safe_path(home, '.local/share/novsky-kit/manifest.json'), json.dumps(manifest), uid, gid)
    atomic(state, json.dumps({**previous, 'files': plan['files'], 'productId': manifest['productId'],
                            'revision': manifest['sourceRevision'], 'configSha': digest(config.encode())}), uid, gid)
    return {'ok': True, 'productId': manifest['productId'], 'revision': manifest['sourceRevision'],
            'skills': len(manifest['nativeSkills']), 'plugins': len(manifest['nativePlugins'])}


if __name__ == '__main__':
    sys.dont_write_bytecode = True
    print(json.dumps(prepare(json.load(sys.stdin))))
