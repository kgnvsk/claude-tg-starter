"""Export selected, credential-free tools outside the owner's private Linux HOME.

Pinned Codex bwrap supports writable children of a denied parent, but does not
restore read-only exceptions there. Public packages therefore live in a separate
root-owned tree; native history, auth and broker state stay in the owner's HOME.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import re
import shutil
import stat
import tempfile
from contextlib import contextmanager

PRIVATE = {'.env', '.ssh', 'auth.json', 'credentials.json', '.npmrc', '.pypirc', 'token.json'}
# Package-manager configuration is not needed to execute exported packages;
# Node's public distribution includes npm/.npmrc, which must also stay omitted.
SKIP = {'.git', '__pycache__', '.DS_Store', '.env.example', '.env.sample', '.env.template', '.npmrc'}


def copy_public(source: Path, target: Path):
    if source.is_symlink() or source != source.resolve(strict=True):
        raise ValueError('public package root must not be an alias')
    budget = [0, 0]

    def visit(path: Path, destination: Path, ancestors: set[Path]):
        if path.name in SKIP:
            return
        if path.name in PRIVATE or path.name.startswith('.env.'):
            raise ValueError('private file is not a public dependency')
        real = path.resolve(strict=True)
        if not real.is_relative_to(source) or real in ancestors:
            raise ValueError('public dependency link leaves its package or cycles')
        relative = real.relative_to(source)
        if any(part in SKIP for part in relative.parts):
            return
        if any(part in PRIVATE or part.startswith('.env.') for part in relative.parts):
            raise ValueError('private file is not a public dependency')
        if path.is_symlink():
            # npm and other package launchers resolve their module-relative
            # imports through these links. Flattening them breaks the package.
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(os.path.relpath(target / relative, destination.parent), target_is_directory=real.is_dir())
            return
        info = real.stat()
        if real.is_dir():
            destination.mkdir(parents=True, exist_ok=True, mode=0o700)
            for child in sorted(real.iterdir()):
                visit(child, destination / child.name, ancestors | {real})
        elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
            budget[0] += 1; budget[1] += info.st_size
            if budget[0] > 50000 or budget[1] > 2 * 1024**3:
                raise ValueError('public dependency is too large')
            destination.parent.mkdir(parents=True, exist_ok=True)
            # A copied file never retains a link to owner-writable package data.
            destination.write_bytes(real.read_bytes())
            destination.chmod(0o755 if info.st_mode & 0o111 else 0o644)
        else:
            raise ValueError('only regular public dependency files are allowed')
    visit(source, target, set())


def link_skill(toolkit: Path, name: str, target: Path):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,149}', name) or not target.resolve().is_relative_to(toolkit.resolve()):
        raise ValueError('invalid public skill target')
    if not (target / 'SKILL.md').is_file():
        raise ValueError('public skill entrypoint missing')
    destination = toolkit / 'skills' / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.symlink_to(os.path.relpath(target, destination.parent), target_is_directory=True)


def public_inventory(root: Path) -> dict:
    files = {}
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('public export link escapes')
            files[path.relative_to(root).as_posix()] = {'link': os.readlink(path)}
        elif path.is_file():
            files[path.relative_to(root).as_posix()] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    return files


def dependency_packages(manifest: dict) -> tuple[list[str], list[str]]:
    features = set(manifest['features'])
    python = []
    for feature, packages in {
        'spreadsheets': ['openpyxl', 'xlsxwriter'],
        'finance-data': ['yfinance'],
        'sql-readonly': ['google-cloud-bigquery==3.42.2'],
    }.items():
        if feature in features: python.extend(packages)
    documents = any(name.startswith('document-skills@') for name in manifest['nativePlugins'])
    if documents:
        python.extend(['python-docx', 'python-pptx', 'pypdf', 'pdfplumber', 'reportlab', 'Pillow', 'cairosvg', 'defusedxml', 'openpyxl', 'xlsxwriter'])
    return sorted(set(python)), ['docx', 'pptxgenjs', 'pdf-lib', 'sharp'] if documents else []


def export_libraries(stage: Path, home: Path, user: str, manifest: dict, env: dict):
    # Existing owner venvs can contain custom/private code even when their names
    # match a managed feature. Resolve public packages into a fresh empty tree;
    # never publish owner environments or their extra files to employees.
    from dependencies import execute
    python, node = dependency_packages(manifest)
    account = pwd.getpwnam(user)
    with tempfile.TemporaryDirectory(prefix='novsky-public-libraries-') as temp:
        root = Path(temp).resolve(strict=True)
        os.chown(root, account.pw_uid, account.pw_gid)
        if python:
            execute(['python3', '-m', 'venv', str(root / 'venv')], user=user, env=env, cwd=root, label='public Python environment')
            execute([str(root / 'venv/bin/pip'), '--isolated', 'install', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', '--no-cache-dir', '--target', str(root / 'python'), *python], user=user, env=env, cwd=root, label='public Python libraries')
            copy_public(root / 'python', stage / 'python/libraries')
        if node:
            execute(['npm', 'install', '--prefix', str(root / 'node'), '--userconfig', '/dev/null', '--globalconfig', str(root / 'empty-global-npmrc'), '--registry', 'https://registry.npmjs.org', '--omit=dev', '--no-audit', '--no-fund', *node], user=user, env=env, cwd=root, label='public JavaScript libraries')
            copy_public(root / 'node/node_modules', stage / 'node-packages')


def export_browser(stage: Path, public: Path, user: str, manifest: dict, env: dict):
    """Publish a fresh stateless browser, never the owner's browser installation."""
    if 'browser' not in manifest['features']:
        return
    from dependencies import execute, install_chromium_dependencies, PLAYWRIGHT_MCP_PACKAGE
    runtime = public / 'browser/runtime'
    cache = public / 'browser/chromium'
    browser_env = {**env, 'PLAYWRIGHT_BROWSERS_PATH': str(cache)}
    execute(['npm', 'install', '--prefix', str(runtime), '--userconfig', '/dev/null',
             '--globalconfig', str(public / 'empty-browser-global-npmrc'), '--registry', 'https://registry.npmjs.org',
             '--omit=dev', '--no-audit', '--no-fund', PLAYWRIGHT_MCP_PACKAGE],
            user=user, env=browser_env, cwd=public, label='public scoped browser')
    node = str(public / '.local/lib/novsky-node/bin/node')
    cli = str(runtime / 'node_modules/playwright/cli.js')
    install_chromium_dependencies(node, cli, user=user, env=browser_env)
    execute([node, cli, 'install', 'chromium'], user=user, env=browser_env, cwd=public, label='public scoped Chromium')
    copy_public(runtime, stage / 'browser/runtime')
    copy_public(cache, stage / 'browser/chromium')


@contextmanager
def fresh_public_packages(root: Path, user: str):
    """Use the public native importer in an empty HOME without owner credentials."""
    from dependencies import execute
    from setup import RPC, import_plugins
    account = pwd.getpwnam(user)
    with tempfile.TemporaryDirectory(prefix='novsky-public-packages-') as temp:
        home = Path(temp).resolve(strict=True)
        os.chown(home, account.pw_uid, account.pw_gid)
        codex_home = home / '.codex'
        codex_home.mkdir(mode=0o700)
        os.chown(codex_home, account.pw_uid, account.pw_gid)
        copy_public(root / 'migration', home / 'migration')
        for path in (home / 'migration').rglob('*'):
            os.chown(path, account.pw_uid, account.pw_gid)
        os.chown(home / 'migration', account.pw_uid, account.pw_gid)
        env = {'HOME': str(home), 'CODEX_HOME': str(home / '.codex'), 'LANG': 'C.UTF-8',
               'PATH': str(home / '.local/lib/novsky-node/bin') + ':/usr/bin:/bin'}
        execute(['python3', '-'], user=user, env=env, cwd=home, label='public Node runtime', input=(root / 'installer/install-node.py').read_bytes())
        execute(['npm', 'install', '--prefix', str(home / 'runtime'), '--userconfig', '/dev/null', '--globalconfig', str(home / 'empty-global-npmrc'), '--registry', 'https://registry.npmjs.org', '--omit=dev', '--no-audit', '--no-fund', '@openai/codex@0.153.3'], user=user, env=env, cwd=home, label='public Codex runtime')
        manifest = json.loads((root / 'manifest.json').read_text())
        rpc = RPC(home / 'runtime/node_modules/.bin/codex', home, {**env, 'HOME': str(home / 'migration')}, user)
        try: import_plugins(rpc, home / 'migration', manifest['nativePlugins'])
        finally: rpc.close()
        rpc = RPC(home / 'runtime/node_modules/.bin/codex', home, env, user)
        try:
            entries = rpc.call('skills/list', {'cwds': [str(home)], 'forceReload': True})['data']
            skills = [skill for entry in entries for skill in entry['skills'] if skill['enabled']]
        finally: rpc.close()
        yield home, env, skills


def export_corporate(root: Path, home: Path, user: str, manifest: dict, env: dict) -> dict | None:
    if 'telegram-corporate-sessions' not in manifest['features']:
        return None
    with fresh_public_packages(root, user) as (public, public_env, skills):
        return assemble_export(root, home, user, manifest, public, public_env, skills)


def assemble_export(root: Path, home: Path, user: str, manifest: dict, public: Path, env: dict, skills: list) -> dict:
    from install import safe_path
    parent = safe_path(Path('/'), 'usr/local/lib/novsky-corporate/' + user)
    parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
        raise ValueError('public export root must be owned by root')
    stage = Path(tempfile.mkdtemp(prefix='.pending-', dir=parent))
    try:
        toolkit = stage / 'toolkit'
        (toolkit / 'skills').mkdir(parents=True)
        for name in ('ROLE.md', 'NOVSKY.md'):
            copy_public(root / 'workspace' / name, toolkit / 'instructions' / name)
        for name in manifest['nativeSkills']:
            copy_public(root / 'home/.agents/skills' / name, toolkit / 'native/skills' / name)
            link_skill(toolkit, name, toolkit / 'native/skills' / name)
        (toolkit / 'agents').mkdir()
        for name in manifest['nativeAgents']:
            copy_public(root / 'home/.codex/agents' / (name + '.toml'), toolkit / 'agents' / (name + '.toml'))
        cache = (public / '.codex/plugins/cache').resolve()
        exported = set()
        selected_plugins = set(manifest['nativePlugins'])
        for skill in skills:
            plugin = skill.get('pluginId')
            if plugin not in selected_plugins:
                continue
            path = Path(skill['path']).resolve(strict=True)
            if not path.is_relative_to(cache):
                raise ValueError('selected plugin is outside the native cache')
            parts = path.relative_to(cache).parts
            if len(parts) < 5 or parts[0] != plugin.split('@', 1)[1] or parts[1] != plugin.split('@', 1)[0]:
                raise ValueError('native plugin identity differs from its package')
            key = re.sub(r'[^a-z0-9-]', '-', plugin.lower())
            package = cache.joinpath(*parts[:3])
            destination = toolkit / 'plugins' / key
            if key not in exported:
                copy_public(package, destination)
                exported.add(key)
            skill_target = destination / path.parent.relative_to(package)
            alias = key + '-' + path.parent.name
            if not (toolkit / 'skills' / alias).exists():
                link_skill(toolkit, alias, skill_target)
        if len(exported) != len(selected_plugins):
            raise ValueError('a selected plugin has no enabled public skills')
        architecture = {'x86_64': ('codex-linux-x64', 'x86_64-unknown-linux-musl'), 'aarch64': ('codex-linux-arm64', 'aarch64-unknown-linux-musl')}.get(platform.machine())
        if not architecture:
            raise ValueError('unsupported corporate architecture')
        vendor = public / 'runtime/node_modules/@openai' / architecture[0] / 'vendor' / architecture[1]
        copy_public(vendor, stage / 'runtime')
        copy_public(public / '.local/lib/novsky-node', stage / 'node')
        export_libraries(stage, home, user, manifest, env)
        export_browser(stage, public, user, manifest, env)
        inventory = public_inventory(stage)
        revision = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()[:20]
        target = parent / revision
        if target.exists():
            if public_inventory(target) != inventory:
                raise ValueError('existing public export has changed')
            shutil.rmtree(stage)
        else:
            for path in stage.rglob('*'):
                if not path.is_symlink():
                    os.chown(path, 0, 0)
                    path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
            stage.chmod(0o755)
            stage.rename(target)
        dependency_roots = [str(target / 'runtime'), str(target / 'node')]
        for name in ('python', 'node-packages'):
            if (target / name).exists(): dependency_roots.append(str(target / name))
        config = {'moduleDir': str(home / '.local/share/novsky-kit/resources/modules/telegram-corporate'),
                'toolkitRoot': str(target / 'toolkit'), 'dependencyRoots': dependency_roots,
                'codexBin': str(target / 'runtime/bin/codex')}
        if 'browser' in manifest['features']:
            config['browserRuntime'] = {'nodeBin': str(target / 'node/bin/node'), 'bwrapBin': '/usr/bin/bwrap',
                                        'packageRoot': str(target / 'browser/runtime'), 'chromiumCacheDir': str(target / 'browser/chromium')}
        return config
    finally:
        if stage.exists(): shutil.rmtree(stage)
