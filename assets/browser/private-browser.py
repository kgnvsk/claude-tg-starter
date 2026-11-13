#!/usr/bin/env python3
"""Private browser identity and setup, scoped to one installed Claude agent."""
from pathlib import Path
import pwd
import re


class InvalidBrowser(ValueError):
    pass


def agent_identity(user, account=None):
    """Derive every mutable path from the selected OS identity, never caller paths."""
    if (not isinstance(user, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', user)
            or user in {'root', 'nobody', 'daemon', 'bin', 'sys', 'www-data', 'claude-browser'}
            or user.startswith('claude-browser-')):
        raise InvalidBrowser('invalid selected agent user')
    try:
        account = account or pwd.getpwnam(user)
    except KeyError:
        raise InvalidBrowser('selected agent does not exist') from None
    if (account.pw_name != user or not 1000 <= account.pw_uid < 65534
            or account.pw_dir != '/home/' + user):
        raise InvalidBrowser('selected agent identity or home does not match')
    uid = account.pw_uid
    return {
        'user': user, 'uid': uid, 'gid': account.pw_gid, 'home': account.pw_dir,
        'agent_service': 'claude-telegram.service' if user == 'claude' else f'claude-telegram@{user}.service',
        'browser_user': f'claude-browser-{uid}',
        'unit': f'claude-browser-private-{uid}',
        'socket': f'/run/claude-browser-private-{uid}.sock',
        'state': f'/var/lib/claude-browser-private/{uid}',
        'config': f'/etc/claude-browser-private/{uid}.json',
    }

import argparse
import fcntl
import grp
import ipaddress
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

VERSION = '0.0.78'
UNIT_DIR = Path('/etc/systemd/system')
BACKUP_DIR = Path('/var/backups/claude-browser-private')
DENY = '127.0.0.0/8 ::1/128 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 fc00::/7 fe80::/10'


def nft_binary():
    path = Path('/usr/sbin/nft')
    if not path.is_file():
        raise InvalidBrowser('nft is missing; provision host prerequisites before selected browser setup')
    s = path.stat()
    if s.st_uid != 0 or s.st_mode & 0o022:
        raise InvalidBrowser('nft must be root-owned and immutable')
    return str(path)


def guard_objects(i, marker):
    table = 'claude_browser_guard_' + str(i['uid'])
    return [
        {'table': {'family': 'inet', 'name': table, 'comment': marker}},
        {'chain': {'family': 'inet', 'table': table, 'name': 'output', 'type': 'filter',
                   'hook': 'output', 'prio': -10, 'policy': 'accept'}},
        {'rule': {'family': 'inet', 'table': table, 'chain': 'output', 'comment': marker, 'expr': [
            {'match': {'op': '==', 'left': {'meta': {'key': 'skuid'}}, 'right': i['uid']}},
            # Native FIB lookup covers loopback and every other local IPv4/IPv6 address.
            {'match': {'op': '==', 'left': {'fib': {'result': 'type', 'flags': ['daddr']}}, 'right': 'local'}},
            {'match': {'op': '==', 'left': {'meta': {'key': 'l4proto'}}, 'right': 'tcp'}},
            {'match': {'op': '==', 'left': {'payload': {'protocol': 'tcp', 'field': 'dport'}}, 'right': 8931}},
            {'counter': None}, {'reject': {'type': 'tcp reset'}}]}}]


def guard_paths(i):
    directory = Path(i['config']).parent
    return (directory / (str(i['uid']) + '-guard.json'), directory / (str(i['uid']) + '-guard.py'),
            UNIT_DIR / (i['unit'] + '-guard.service'),
            UNIT_DIR / (i['agent_service'] + '.d') / '40-private-browser-egress.conf')


def guard_manifest(i):
    path = guard_paths(i)[0]
    if not path.exists() and not path.is_symlink():
        return None
    root_dir(path.parent)  # Existing ancestors only; do not read through an unsafe parent.
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or s.st_nlink != 1 or s.st_size > 4096:
        raise InvalidBrowser('unsafe browser guard manifest')
    manifest = json.loads(path.read_text())
    if (any(manifest.get(k) != i[k] for k in ('user', 'uid', 'home')) or
            not re.fullmatch('private-browser-' + str(i['uid']) + '-[a-f0-9]{32}', manifest.get('marker', ''))):
        raise InvalidBrowser('browser guard identity mismatch')
    return manifest


def guard_read(i):
    result = subprocess.run([nft_binary(), '-j', '-n', 'list', 'table', 'inet',
                             'claude_browser_guard_' + str(i['uid'])], capture_output=True,
                            text=True, timeout=10, env={**os.environ, 'LC_ALL': 'C'})
    if len(result.stdout) > 65536 or len(result.stderr) > 4096:
        raise InvalidBrowser('unexpected browser guard table size')
    if result.returncode:
        if not result.stdout and 'No such file or directory' in result.stderr:
            return None
        raise InvalidBrowser('cannot inspect selected browser guard table')
    return [entry for entry in json.loads(result.stdout)['nftables'] if 'metainfo' not in entry]


def guard_validate(i, marker, actual):
    if not isinstance(actual, list):
        raise InvalidBrowser('selected browser guard table is absent')
    expected = guard_objects(i, marker)
    expected_expr = expected[2]['rule']['expr']
    normalized = json.loads(json.dumps(actual))
    for entry in normalized:
        if len(entry) != 1 or next(iter(entry)) not in ('table', 'chain', 'rule'):
            raise InvalidBrowser('unknown browser guard table object')
        value = next(iter(entry.values()))
        value.pop('handle', None)
        for expression in value.get('expr', []):
            if 'counter' in expression:
                counter = expression['counter']
                if isinstance(counter, dict) and set(counter) == {'packets', 'bytes'} and all(
                        type(v) is int and v >= 0 for v in counter.values()):
                    expression['counter'] = None
            match = expression.get('match', {})
            if match.get('left') == {'meta': {'key': 'l4proto'}} and match.get('right') == 6:
                match['right'] = 'tcp'
            if match.get('left') == {'fib': {'result': 'type', 'flags': ['daddr']}} and match.get('right') == 2:
                match['right'] = 'local'  # Numeric nft readback uses Linux RTN_LOCAL.
        # nft may omit only the redundant l4proto match implied by tcp dport.
        # Accept that exact remaining expression list, never a missing boundary.
        if value.get('expr') == expected_expr[:2] + expected_expr[3:]:
            value['expr'] = expected_expr
    if normalized != expected:
        raise InvalidBrowser('unknown or changed browser guard table; never replace it')


def guard_preflight(i):
    nft_binary()  # Before directories, downloads, accounts, service stops or registration.
    manifest, table = guard_manifest(i), guard_read(i)
    if table is not None:
        if manifest is None:
            raise InvalidBrowser('unknown browser guard table; never adopt it')
        guard_validate(i, manifest['marker'], table)
    if manifest is None and any(p.exists() or p.is_symlink() for p in guard_paths(i)[1:]):
        raise InvalidBrowser('unknown browser guard files; reconcile them explicitly')
    return manifest, table


def nft_change(commands):
    run([nft_binary(), '-j', '-f', '-'], input=json.dumps({'nftables': commands}).encode(),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)


def guard_apply(i):
    manifest, table = guard_preflight(i)
    if manifest is None:
        raise InvalidBrowser('browser guard has not been installed')
    if table is None:
        objects = guard_objects(i, manifest['marker'])
        # create, not add: a concurrent unknown table must fail the atomic batch.
        nft_change([{'create': objects[0]}, *({'add': item} for item in objects[1:])])
        guard_validate(i, manifest['marker'], guard_read(i))


def guard_delete(i, marker):
    table = guard_read(i)
    if table is not None:
        guard_validate(i, marker, table)
        nft_change([{'delete': {'table': {'family': 'inet', 'name': 'claude_browser_guard_' + str(i['uid'])}}}])


def guard_restore(i, previous):
    if previous is None:
        return
    old, table_existed, was_active, was_enabled, marker = previous
    table_error = None
    if not table_existed:
        try:
            guard_delete(i, marker)
        except (InvalidBrowser, OSError, ValueError, subprocess.SubprocessError) as error:
            # Preserve a concurrently changed table, but still undo our files.
            table_error = error
    unit = i['unit'] + '-guard.service'
    if not was_active and active(unit):
        run(['systemctl', 'stop', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    enabled = subprocess.run(['systemctl', 'is-enabled', '--quiet', unit], timeout=10,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not was_enabled and enabled:
        run(['systemctl', 'disable', unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path, value in old.items():
        if value is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, value[0], value[1])
    run(['systemctl', 'daemon-reload'])
    if was_active:
        run(['systemctl', 'start', unit])
    if table_error is not None:
        raise table_error


def install_guard(i):
    manifest, table = guard_preflight(i)
    manifest = manifest or {**{k: i[k] for k in ('user', 'uid', 'home')},
                            'marker': 'private-browser-' + str(i['uid']) + '-' + uuid.uuid4().hex}
    state, helper, unit_path, dropin = guard_paths(i)
    unit = i['unit'] + '-guard.service'
    # A root-owned per-agent copy keeps boot independent of a staging/update path.
    files = {state: (json.dumps(manifest, sort_keys=True) + '\n', 0o644),
             helper: (Path(__file__).read_bytes(), 0o444),
             unit_path: (f'''[Unit]
Description=Block shared legacy browser access for {i['user']}
After=network-pre.target nftables.service ufw.service
Before={i['agent_service']}
[Service]
Type=oneshot
RemainAfterExit=yes
TimeoutStartSec=30
ExecStart=/usr/bin/python3 {helper} guard --agent {i['user']}
[Install]
WantedBy=multi-user.target
''', 0o644),
             dropin: (f'[Unit]\nRequires={unit}\nAfter={unit}\n', 0o644)}
    old = {}
    backup = Path(tempfile.mkdtemp(prefix=str(i['uid']) + '-guard-', dir=root_dir(BACKUP_DIR, 0o700)))
    for index, path in enumerate(files):
        if path.exists() or path.is_symlink():
            root_dir(path.parent)
            s = path.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or s.st_nlink != 1:
                raise InvalidBrowser('unsafe browser guard file')
            old[path] = (path.read_bytes(), stat.S_IMODE(s.st_mode))
            (backup / str(index)).write_bytes(old[path][0])
        else:
            old[path] = None
    was_active = active(unit)
    was_enabled = subprocess.run(['systemctl', 'is-enabled', '--quiet', unit], timeout=10,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    previous = old, table is not None, was_active, was_enabled, manifest['marker']
    try:
        for path, (data, mode) in files.items():
            atomic(path, data, mode)
        guard_apply(i)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', '--now', unit])
        if not active(unit):
            raise InvalidBrowser('selected browser guard did not start')
    except Exception:
        guard_restore(i, previous)
        raise
    print('Selected browser guard backup: ' + str(backup))
    return previous


def resolvers(text):
    result = set()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == 'nameserver':
            try:
                result.add(str(ipaddress.ip_address(parts[1])))
            except ValueError:
                pass
    return sorted(result)


def units(identity, runtime, dns, node='/usr/bin/node'):
    i = identity
    socket = f'''[Unit]
Description=Private browser socket for {i['user']}
[Socket]
ListenStream={i['socket']}
SocketUser={i['user']}
SocketGroup={i['user']}
SocketMode=0600
Accept=yes
MaxConnections=1
RemoveOnStop=yes
[Install]
WantedBy=sockets.target
'''
    service = f'''[Unit]
Description=Private browser connection for {i['user']}
[Service]
Type=exec
User={i['browser_user']}
Group={i['browser_user']}
Environment=HOME={i['state']}/home
Environment=PLAYWRIGHT_BROWSERS_PATH={runtime}/ms-playwright
WorkingDirectory={i['state']}/output
ExecStart={node} {runtime}/node_modules/@playwright/mcp/cli.js --headless --browser=chromium --user-data-dir={i['state']}/profile --output-dir={i['state']}/output --output-max-size=52428800
StandardInput=socket
StandardOutput=socket
StandardError=journal
UMask=0007
TimeoutStopSec=20
KillMode=control-group
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectProc=invisible
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
AmbientCapabilities=
ReadWritePaths={i['state']}
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny={DENY}
MemoryHigh=1536M
MemoryMax=2G
TasksMax=1024
'''
    if dns:
        service += 'IPAddressAllow=' + ' '.join(str(ipaddress.ip_address(x)) for x in dns) + '\n'
    return socket, service


def check_registration(state, project, identity):
    """Do not silently leave a higher-precedence local/project HTTP registration."""
    if not isinstance(state, dict) or not isinstance(project, dict):
        raise InvalidBrowser('invalid MCP configuration')
    expected = {'type': 'stdio', 'command': identity['home'] + '/bin/browser-mcp', 'args': []}
    current = state.get('mcpServers', {}).get('playwright')
    if isinstance(current, dict) and current.get('env') == {}:
        current = {k: v for k, v in current.items() if k != 'env'}
    legacy = {'type': 'http', 'url': 'http://localhost:8931/mcp'}
    if current is not None and current not in (expected, legacy):
        raise InvalidBrowser('custom user Playwright registration; reconcile it explicitly first')
    for name in (identity['home'], identity['home'] + '/obsidian-vault'):
        if 'playwright' in state.get('projects', {}).get(name, {}).get('mcpServers', {}):
            raise InvalidBrowser('local Playwright override; reconcile it explicitly first')
    if 'playwright' in project.get('mcpServers', {}):
        raise InvalidBrowser('project Playwright override; reconcile it explicitly first')


def immutable_tree(path, owner=0):
    path = Path(path)
    if path.is_symlink() or not path.is_dir():
        raise InvalidBrowser('browser runtime must be a real directory')
    for entry in [path, *path.rglob('*')]:
        s = entry.lstat()
        if s.st_uid != owner or (not stat.S_ISLNK(s.st_mode) and s.st_mode & 0o022):
            raise InvalidBrowser('browser runtime is not immutable/root-owned')
        if entry.is_symlink():
            if not entry.resolve().is_relative_to(path.resolve()):
                raise InvalidBrowser('browser runtime link escapes its immutable directory')
        elif not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)):
            raise InvalidBrowser('unexpected runtime file type')


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, timeout=kwargs.pop('timeout', 60), **kwargs)


def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit], timeout=10).returncode == 0


def root_dir(path, mode=0o755):
    """Every ancestor must be real, root-owned and not writable by another UID."""
    path = Path(path)
    for item in reversed([path, *path.parents][:-1]):
        if not item.exists() and not item.is_symlink():
            item.mkdir(mode=mode if item == path else 0o755)
            item.chmod(mode if item == path else 0o755)
        s = item.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise InvalidBrowser('unsafe root browser directory')
    return path


def atomic(path, data, mode=0o644):
    path = Path(path)
    root_dir(path.parent)
    if path.exists() or path.is_symlink():
        s = path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1:
            raise InvalidBrowser('unsafe existing browser configuration file')
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data if isinstance(data, bytes) else data.encode())
            os.fchmod(handle.fileno(), mode)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def user_run(i, args, **kwargs):
    return run(['runuser', '-u', i['user'], '--', 'env', '-i', 'HOME=' + i['home'],
                'PATH=/usr/local/bin:/usr/bin:/bin', *args], **kwargs)


def user_json(i, relative):
    # Reading as the selected UID cannot read a neighbour's private configuration.
    result = user_run(i, ['/usr/bin/python3', '-c',
        'import pathlib,sys; p=pathlib.Path(sys.argv[1]); '
        'assert not p.is_symlink(); '
        'print(p.read_text() if p.exists() else "{}")', i['home'] + '/' + relative], capture_output=True)
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise InvalidBrowser('invalid selected MCP configuration') from None


def preflight(i):
    if Path(i['home']).is_symlink() or Path(i['home']).stat().st_uid != i['uid']:
        raise InvalidBrowser('selected home is not owned by selected agent')
    if not Path(i['home'] + '/.local/bin/claude').is_file():
        raise InvalidBrowser('install selected Claude CLI before browser setup')
    state = user_json(i, '.claude.json')
    project = user_json(i, 'obsidian-vault/.mcp.json')
    check_registration(state, project, i)
    check_registration(state, user_json(i, '.mcp.json'), i)
    # An explicit config-dir changes native precedence; require stock home setup.
    env_file = Path('/etc/claude-tg-starter') / ('agent.env' if i['user'] == 'claude' else 'agent-' + i['user'] + '.env')
    if env_file.is_file() and any(line.startswith('CLAUDE_CONFIG_DIR=') for line in env_file.read_text().splitlines()):
        raise InvalidBrowser('custom CLAUDE_CONFIG_DIR requires explicit browser registration')
    return state


def prepare_runtime(kit, version):
    if not re.fullmatch(r'0\.0\.[0-9]{1,4}', version):
        raise InvalidBrowser('expected an exact pinned MCP version')
    parent = root_dir('/opt/claude-browser-runtimes')
    runtime = parent / version
    node = Path(shutil.which('node') or '/usr/bin/node').resolve()
    root_dir(node.parent)
    s = node.stat()
    if s.st_uid != 0 or s.st_mode & 0o022 or not re.fullmatch(r'/[A-Za-z0-9_./+-]+', str(node)):
        raise InvalidBrowser('Node must be root-owned and immutable')
    run([node, '-e', 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'])
    if runtime.exists() or runtime.is_symlink():
        immutable_tree(runtime)
    else:
        temp = Path(tempfile.mkdtemp(prefix='.install-', dir=parent))
        try:
            clean = kit / 'assets/lib/install-env'
            run([clean, '/root', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1', 'npm', 'install', '--prefix', temp,
                 '--omit=dev', '--no-audit', '--no-fund', '@playwright/mcp@' + version], timeout=900)
            cli = temp / 'node_modules/playwright/cli.js'
            # OS libraries belong to host provisioning, never selected-agent setup:
            # Playwright install-deps runs apt upgrades and needrestart on neighbours.
            # Stock browser download validates host libraries; the actual setup smoke
            # must also pass before registration is accepted. No host package mutation.
            run([clean, '/root', 'PLAYWRIGHT_BROWSERS_PATH=' + str(temp / 'ms-playwright'),
                 node, cli, 'install', 'chromium'], timeout=900)
            # mkdtemp is private; binaries/cache contain no credentials and are shared read-only.
            for entry in [temp, *temp.rglob('*')]:
                if not entry.is_symlink():
                    entry.chmod(0o755 if entry.is_dir() or entry.stat().st_mode & 0o111 else 0o644)
            immutable_tree(temp)
            temp.rename(runtime)
        finally:
            if temp.exists():
                shutil.rmtree(temp)
    package = json.loads((runtime / 'node_modules/@playwright/mcp/package.json').read_text())
    if package.get('version') != version or not (runtime / 'node_modules/@playwright/mcp/cli.js').is_file():
        raise InvalidBrowser('pinned Playwright MCP runtime mismatch')
    return str(runtime), str(node)


def browser_account(i):
    try:
        account = pwd.getpwnam(i['browser_user'])
    except KeyError:
        run(['useradd', '--system', '--user-group', '--home-dir', i['state'],
             '--shell', '/usr/sbin/nologin', i['browser_user']])
        account = pwd.getpwnam(i['browser_user'])
    group = grp.getgrgid(account.pw_gid)
    if (account.pw_dir != i['state'] or account.pw_shell != '/usr/sbin/nologin'
        or account.pw_uid == i['uid'] or group.gr_name != i['browser_user']
        or set(group.gr_mem) - {i['user'], i['browser_user']}
        or any(p.pw_gid == group.gr_gid and p.pw_uid != account.pw_uid for p in pwd.getpwall())):
        raise InvalidBrowser('private browser account/group belongs to another identity')
    root_dir('/var/lib/claude-browser-private')
    state = Path(i['state'])
    created = not state.exists() and not state.is_symlink()
    if created:
        state.mkdir(0o750)
        os.chown(state, 0, account.pw_gid)
        state.chmod(0o750)
    s = state.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_gid != account.pw_gid or stat.S_IMODE(s.st_mode) != 0o750:
        raise InvalidBrowser('unsafe existing private browser state root')
    # UID reuse must not hand a removed agent's persistent logins to a new name.
    marker = state / 'agent.json'
    identity = {key: i[key] for key in ('user', 'uid', 'home')}
    if created:
        atomic(marker, json.dumps(identity, sort_keys=True) + '\n')
    else:
        m = marker.lstat()
        if (not stat.S_ISREG(m.st_mode) or m.st_uid != 0 or m.st_mode & 0o022 or m.st_nlink != 1
            or json.loads(marker.read_text()) != identity):
            raise InvalidBrowser('existing browser state belongs to a different agent')
    for child, mode in [('home', 0o700), ('profile', 0o700), ('output', 0o2770)]:
        path = state / child
        if not path.exists() and not path.is_symlink():
            path.mkdir(mode)
            os.chown(path, account.pw_uid, account.pw_gid)
            path.chmod(mode)
        s = path.lstat()
        if (not stat.S_ISDIR(s.st_mode) or s.st_uid != account.pw_uid or s.st_gid != account.pw_gid
            or stat.S_IMODE(s.st_mode) != mode):
            raise InvalidBrowser('unsafe existing profile/output; never reset owner login data')
    if i['user'] not in group.gr_mem:
        run(['usermod', '-a', '-G', i['browser_user'], i['user']])
    return account


def restore_units(i, previous):
    if not previous:
        return
    old, was_active, was_enabled = previous
    run(['systemctl', 'stop', i['unit'] + '.socket', i['unit'] + '@*.service'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not was_enabled:
        run(['systemctl', 'disable', i['unit'] + '.socket'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for path, value in old.items():
        if value is None:
            path.unlink(missing_ok=True)
        else:
            atomic(path, value)
    run(['systemctl', 'daemon-reload'])
    if was_active:
        run(['systemctl', 'start', i['unit'] + '.socket'])


def install_units(i, config, activate=False):
    socket, service = units(i, config['runtime'], resolvers(Path('/etc/resolv.conf').read_text()), config['node'])
    paths = {UNIT_DIR / (i['unit'] + '.socket'): socket,
             UNIT_DIR / (i['unit'] + '@.service'): service,
             Path(i['config']): json.dumps(config, sort_keys=True) + '\n'}
    changed = any(not p.exists() or p.read_text() != value for p, value in paths.items())
    if not changed and not activate:
        return
    backup = root_dir(BACKUP_DIR, 0o700)
    backup = Path(tempfile.mkdtemp(prefix=str(i['uid']) + '-', dir=backup))
    old = {}
    for path in paths:
        if path.exists() or path.is_symlink():
            s = path.lstat()
            if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_nlink != 1:
                raise InvalidBrowser('unsafe private browser unit/config')
            old[path] = path.read_bytes()
            (backup / path.name).write_bytes(old[path])
        else:
            old[path] = None
    was_active = active(i['unit'] + '.socket')
    was_enabled = subprocess.run(['systemctl', 'is-enabled', '--quiet', i['unit'] + '.socket'],
                                 timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    # Exact selected unit prefix only. No host-global HTTP service actions.
    run(['systemctl', 'stop', i['unit'] + '.socket', i['unit'] + '@*.service'], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL) if (UNIT_DIR / (i['unit'] + '.socket')).exists() else None
    try:
        for path, value in paths.items():
            atomic(path, value)
        run(['systemctl', 'daemon-reload'])
        if activate:
            run(['systemctl', 'enable', '--now', i['unit'] + '.socket'])
        elif was_active:
            run(['systemctl', 'start', i['unit'] + '.socket'])
        if (activate or was_active) and not active(i['unit'] + '.socket'):
            raise InvalidBrowser('selected browser socket did not start')
    except Exception:
        restore_units(i, (old, was_active, was_enabled))
        raise
    print('Selected browser configuration backup: ' + str(backup))
    return old, was_active, was_enabled


def refresh(i, kit):
    """Only an existing selected private browser; no onboarding or global migration."""
    existing = Path(i['config'])
    if not existing.exists() and not existing.is_symlink():
        print('Private browser is not configured; existing legacy service left unchanged.')
        return
    guard_preflight(i)
    root_dir(existing.parent)
    metadata = existing.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
        or metadata.st_mode & 0o022 or metadata.st_nlink != 1):
        raise InvalidBrowser('unsafe existing private browser configuration')
    config = json.loads(existing.read_text())
    if any(config.get(key) != value for key, value in i.items()):
        raise InvalidBrowser('existing private browser identity mismatch')
    if (not re.fullmatch(r'/opt/claude-browser-runtimes/0\.0\.[0-9]{1,4}', config.get('runtime', ''))
        or not re.fullmatch(r'/[A-Za-z0-9_./+-]+', config.get('node', ''))):
        raise InvalidBrowser('unexpected existing private browser runtime')
    root_dir(Path(config['node']).resolve().parent)
    node_stat = Path(config['node']).stat()
    if node_stat.st_uid != 0 or node_stat.st_mode & 0o022:
        raise InvalidBrowser('existing Node executable is not immutable')
    immutable_tree(config['runtime'])
    browser_account(i)
    guard = install_guard(i)
    try:
        install_units(i, config)
    except Exception:
        guard_restore(i, guard)
        raise


def helper_snapshot(i):
    return user_run(i, ['/usr/bin/python3', '-c', '''import base64,json,pathlib,stat
result={}
for name in ('bin/browser-mcp','bin/browser-doctor','bin/browser-pdf.mjs','bin/html-to-pdf','.claude.json'):
 p=pathlib.Path.home()/name
 if not p.exists() and not p.is_symlink(): result[name]=None; continue
 s=p.lstat()
 assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_size<16777216
 result[name]={'mode':stat.S_IMODE(s.st_mode),'data':base64.b64encode(p.read_bytes()).decode()}
print(json.dumps(result))'''], capture_output=True).stdout


def restore_helpers(i, snapshot):
    user_run(i, ['/usr/bin/python3', '-c', '''import base64,json,os,pathlib,sys,tempfile
for name,value in json.load(sys.stdin).items():
 assert name in ('bin/browser-mcp','bin/browser-doctor','bin/browser-pdf.mjs','bin/html-to-pdf','.claude.json')
 p=pathlib.Path.home()/name
 if value is None: p.unlink(missing_ok=True); continue
 fd,t=tempfile.mkstemp(dir=p.parent)
 with os.fdopen(fd,'wb') as f: f.write(base64.b64decode(value['data'])); os.fchmod(f.fileno(),value['mode'])
 os.replace(t,p)'''], input=snapshot)


def setup(i, kit, version):
    nft_binary()
    state = preflight(i)  # unknown higher-precedence registrations fail before setup
    if not Path('/usr/bin/socat').is_file():
        raise InvalidBrowser('socat is missing; install host prerequisites during host provisioning, not selected-agent setup')
    guard_preflight(i)
    runtime, node = prepare_runtime(kit, version)
    browser_account(i)
    config = dict(i, schema=1, transport='private-stdio', runtime=runtime, node=node, version=version)
    was_active = active(i['agent_service'])
    if was_active:
        run(['systemctl', 'stop', i['agent_service']])
    previous = None
    helpers = None
    guard = None
    try:
        state = preflight(i)  # fresh after the selected agent stops, not before a long package install
        backup = root_dir(BACKUP_DIR, 0o700)
        snapshot = Path(tempfile.mkdtemp(prefix=str(i['uid']) + '-registration-', dir=backup))
        (snapshot / 'claude.json').write_text(json.dumps(state))
        helpers = helper_snapshot(i)
        (snapshot / 'selected-files.json').write_bytes(helpers)
        print('Selected configuration/helper rollback copy: ' + str(snapshot))
        # Copy as the selected user, never with root authority into an agent-writable home.
        user_run(i, ['mkdir', '-p', i['home'] + '/bin'])
        for name in ('browser-mcp', 'browser-doctor', 'browser-pdf.mjs', 'html-to-pdf'):
            user_run(i, ['install', '-m', '755', kit / 'assets/bin' / name, i['home'] + '/bin/' + name])
        previous = install_units(i, config, activate=True)
        guard = install_guard(i)
        # Config snapshot contents are private. No transcript/auth/profile is touched.
        cli = i['home'] + '/.local/bin/claude'
        # Stock command owns native configuration semantics; selected bot is stopped above.
        user_run(i, [cli, 'mcp', 'remove', '--scope', 'user', 'playwright'],
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) if state.get('mcpServers', {}).get('playwright') else None
        user_run(i, [cli, 'mcp', 'add', '--scope', 'user', '--transport', 'stdio',
                     'playwright', '--', i['home'] + '/bin/browser-mcp'], stdout=subprocess.DEVNULL)
        after = user_json(i, '.claude.json')
        expected = {'type': 'stdio', 'command': i['home'] + '/bin/browser-mcp', 'args': []}
        registered = dict(after.get('mcpServers', {}).get('playwright') or {})
        if registered.get('env') == {}:
            registered.pop('env')
        if registered != expected:
            raise InvalidBrowser('native Playwright registration did not match private stdio')
        before_other = {k: v for k, v in state.get('mcpServers', {}).items() if k != 'playwright'}
        after_other = {k: v for k, v in after.get('mcpServers', {}).items() if k != 'playwright'}
        if before_other != after_other or state.get('projects') != after.get('projects'):
            raise InvalidBrowser('native registration changed unrelated MCP configuration')
        check_registration(after, user_json(i, 'obsidian-vault/.mcp.json'), i)
        user_run(i, [node, kit / 'assets/browser/private-browser-smoke.mjs'], timeout=120)
        print('Private browser ready; persistent profile, one active MCP connection. Registration backup: ' + str(snapshot))
        if Path('/etc/systemd/system/claude-browser.service').exists():
            print('LEGACY HTTP still exists; selected UID is blocked from local TCP8931. Other legacy users require separate migration.')
    except Exception:
        try:
            try:
                guard_restore(i, guard)
            finally:
                restore_units(i, previous)
        finally:
            if helpers is not None:
                restore_helpers(i, helpers)
        raise
    finally:
        if was_active:
            run(['systemctl', 'start', i['agent_service']])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('setup', 'refresh', 'guard-install', 'guard'))
    parser.add_argument('--agent', default=os.environ.get('AGENT_USER', 'claude'))
    parser.add_argument('--kit', type=Path)
    parser.add_argument('--version', default=VERSION)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise InvalidBrowser('run browser setup as root')
    i = agent_identity(args.agent)
    if args.action == 'guard':
        guard_apply(i)
        return
    if args.action != 'refresh' or Path(i['config']).exists():
        nft_binary()  # Even the selected setup lock must not precede this prerequisite.
    if args.action in ('setup', 'refresh') and args.kit is None:
        raise InvalidBrowser('--kit is required for browser setup/refresh')
    # Per-selected-agent setup serialisation; no request-time privileged helper.
    fd = os.open('/run/' + i['unit'] + '.setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    s = os.fstat(fd)
    if s.st_uid != 0 or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
        raise InvalidBrowser('unsafe browser setup lock')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if args.action == 'guard-install':
        # Harden only an already configured private browser; no native/CLI/auth update.
        config = Path(i['config'])
        root_dir(config.parent)
        s = config.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or s.st_nlink != 1:
            raise InvalidBrowser('unsafe private browser configuration')
        current = json.loads(config.read_text())
        if any(current.get(key) != value for key, value in i.items()):
            raise InvalidBrowser('existing private browser identity mismatch')
        install_guard(i)
    elif args.action == 'setup':
        setup(i, args.kit.resolve(), args.version)
    else:
        refresh(i, args.kit.resolve())


if __name__ == '__main__':
    try:
        main()
    except (InvalidBrowser, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        # Provider/config values are never emitted on an error path.
        print('FATAL private browser: ' + (str(error) if isinstance(error, InvalidBrowser) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
