"""Install only a marked Novsky Codex agent; input is JSON on stdin, never argv."""
import datetime, json, os, pathlib, pwd, re, subprocess, sys, tarfile, tempfile

def assert_stopped(unit):
    result = subprocess.run(['systemctl', 'show', unit, '--property=LoadState,ActiveState,MainPID'], capture_output=True, text=True)
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    # systemctl may return nonzero for a missing first-install unit, but an
    # empty reply or failed D-Bus query is never proof of a stopped agent.
    missing = fields.get('LoadState') == 'not-found'
    if (result.returncode and not missing) or fields.get('ActiveState') not in ('inactive', 'failed') or fields.get('MainPID') != '0':
        raise ValueError('target agent stop was not confirmed; no backup or runtime update was attempted')

def runtime_config(path, defaults, *, completed=True):
    # Installation requests describe first setup. The running agent owns later
    # model, integration and policy choices; only fill genuinely missing fields.
    current = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(current, dict):
        raise ValueError('invalid existing runtime configuration')
    result = {**defaults, **current}
    # An incomplete first setup may be retried with a corrected API key.
    # Completed installations retain the owner's key, including upgrade retries.
    if not completed and 'openaiApiKey' in defaults:
        result['openaiApiKey'] = defaults['openaiApiKey']
    return result

def main():
    payload = json.load(sys.stdin)
    user = payload['user']
    if not re.fullmatch(r'codex-[a-z0-9][a-z0-9-]{0,23}', user):
        raise ValueError('invalid user')
    home = pathlib.Path('/home') / user
    config_dir = pathlib.Path('/etc/novsky/codex')
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o711)
    marker = config_dir / (user + '.installed.json')
    config = config_dir / (user + '.json')
    state_path = config_dir / (user + '.managed.json')
    unit = 'codex-telegram@' + user + '.service'
    unit_path = pathlib.Path('/etc/systemd/system') / unit
    if any(part.is_symlink() for path in (home, marker, config, state_path) for part in (path, *path.parents)):
        raise ValueError('unsafe installation path')
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    if not isinstance(previous, dict) or not isinstance(previous.get('files', {}), dict):
        raise ValueError('invalid existing managed state')
    next_config = runtime_config(config, payload['config'], completed=bool(previous.get('revision')))
    try:
        account = pwd.getpwnam(user)
        if not marker.is_file() or account.pw_dir != str(home) or account.pw_uid < 1000:
            raise ValueError('existing user is not owned by Novsky Codex')
    except KeyError:
        if home.exists():
            raise ValueError('existing home is not owned by Novsky Codex')
        account = None
    # Stop only our named unit to capture a consistent SQLite/WAL backup.
    subprocess.run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    assert_stopped(unit)
    backups = pathlib.Path('/root/backups')
    backups.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = backups / ('novsky-codex-' + user + '-' + stamp + '.tar.gz')
    def keep(info):
        return None if any(x in info.name.split('/') for x in ('node_modules', '.cache', '.npm')) else info
    with tarfile.open(backup, 'w:gz') as archive:
        owned_configs = list(config_dir.glob(user + '.*'))
        browser_units = [pathlib.Path('/etc/systemd/system') / ('novsky-browser-' + user + suffix) for suffix in ('.socket', '@.service')]
        for path in (home, *owned_configs, unit_path, *browser_units):
            if path.exists(): archive.add(path, arcname=str(path).lstrip('/'), filter=keep)
    os.chmod(backup, 0o600)
    if account is None:
        subprocess.run(['useradd', '--create-home', '--user-group', '--shell', '/bin/bash', user], check=True)
        account = pwd.getpwnam(user)
    os.chmod(home, 0o700)
    uid, gid = account.pw_uid, account.pw_gid

    def write(path, content, mode=0o600, owner=True, preserve=False):
        # Refuse symlink ancestors, including links planted by an existing agent.
        for part in (path, *path.parents):
            if part.is_symlink(): raise ValueError('symlink in installation path')
        if preserve and path.exists(): return
        missing = []
        parent = path.parent
        while not parent.exists():
            missing.append(parent); parent = parent.parent
        for directory in reversed(missing):
            directory.mkdir(mode=0o700 if owner else 0o755)
            if owner: os.chown(directory, uid, gid)
        fd, name = tempfile.mkstemp(dir=path.parent)
        try:
            with os.fdopen(fd, 'w') as out: out.write(content)
            os.chmod(name, mode)
            if owner: os.chown(name, uid, gid)
            os.replace(name, path)
        finally:
            if os.path.exists(name): os.unlink(name)

    # The backup retains the last completed state. A failed runtime or dependency
    # update must not leave its old readiness flag authorizing a later start.
    write(state_path, json.dumps({**previous, 'state':'installing'}), owner=False)
    write(marker, json.dumps({'engine':'codex', 'user':user}), owner=False)
    for name, text in payload['runtime'].items():
        if name not in ('main.ts','rpc.ts','store.ts','telegram.ts'): raise ValueError('unexpected runtime file')
        write(home / '.local/lib/novsky-codex' / name, text)
    # Retire only unchanged files from the bundled preview after the backup.
    # Owner instructions and all confirmed memory survive the full-kit upgrade.
    for name, text in payload.get('legacyKit', {}).items():
        relative = pathlib.PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts: raise ValueError('unsafe legacy path')
        if name in ('AGENTS.md', 'OWNER.md', 'memory/MEMORY.md'): continue
        path = home / 'obsidian-vault' / relative
        for parent in (path, *path.parents):
            if parent.is_symlink(): raise ValueError('unsafe legacy path')
        if path.is_file() and path.read_text() == text: path.unlink()
    for name, text in payload['kit'].items():
        path = pathlib.PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts: raise ValueError('unsafe kit path')
        write(home / 'obsidian-vault' / path, text, preserve=name in ('AGENTS.md','OWNER.md','memory/MEMORY.md'))
    for directory in (home/'.codex', home/'.local', home/'.local/state', home/'.local/state/novsky-codex', home/'logs', home/'obsidian-vault', home/'obsidian-vault/inbox', home/'obsidian-vault/outbox'):
        if any(part.is_symlink() for part in (directory, *directory.parents)): raise ValueError('unsafe directory')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chown(directory,uid,gid)
    # Native project trust is local to this agent; no host/user-wide configuration changes.
    workspace = str(home/'obsidian-vault')
    write(home/'.codex/config.toml', '[projects.' + json.dumps(workspace) + ']\ntrust_level = "trusted"\n', preserve=True)
    write(config, json.dumps(next_config), mode=0o400)
    prefix = str(home/'.local/lib/novsky-runtime/node_modules/.bin')
    write(unit_path, '\n'.join([
        '[Unit]', 'Description=Novsky Codex Telegram ('+user+')',
        'After=network-online.target', 'Wants=network-online.target',
        '[Service]', 'Type=simple', 'User='+user, 'Group='+user,
        'WorkingDirectory='+workspace, 'Environment=HOME='+str(home),
        'Environment=CODEX_HOME='+str(home/'.codex'),
        'Environment=PATH='+str(home/'.local/lib/novsky-node/bin')+':'+prefix+':/usr/local/bin:/usr/bin:/bin',
        'ExecStart='+prefix+'/bun '+str(home/'.local/lib/novsky-codex/main.ts')+' --config '+str(config),
        'Restart=on-failure', 'RestartPreventExitStatus=78', 'RestartSec=5', 'TimeoutStopSec=30', 'KillMode=control-group',
        'UMask=0077', 'NoNewPrivileges=yes', 'ProtectHome=read-only',
        'ReadWritePaths='+str(home), 'PrivateTmp=yes',
        'StandardOutput=append:'+str(home/'logs/codex-telegram.log'),
        'StandardError=append:'+str(home/'logs/codex-telegram.log'),
        '[Install]', 'WantedBy=multi-user.target', ''
    ]), mode=0o644, owner=False)
    subprocess.run(['systemctl','daemon-reload'], check=True)
    print(json.dumps({'ok':True, 'backup':str(backup)}))

if __name__ == '__main__':
    try: main()
    except Exception:
        # Never echo payloads, tokens or config content on failure.
        print('Novsky Codex installation could not be completed safely.', file=sys.stderr)
        sys.exit(1)
