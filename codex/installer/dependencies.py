"""Install selected dependencies without replacing neighbouring agent runtimes."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import platform
import pwd
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

PLAYWRIGHT_MCP_PACKAGE = '@playwright/mcp@0.0.78'


def execute(command, *, user=None, env=None, cwd=None, label="dependency", timeout=900, input=None, success_codes=(0,)):
    if user:
        command = ["runuser", "-u", user, "--", "env", "-i", *[key + "=" + value for key, value in env.items()], *map(str, command)]
        cwd = cwd or env["HOME"]
    result = subprocess.run(command, cwd=cwd, capture_output=True, timeout=timeout, input=input)
    if result.returncode not in success_codes:
        # Package commands may echo repository credentials. Return only the
        # known stage name, never unsanitized command output to Novsky logs.
        raise ValueError(label + " failed (exit " + str(result.returncode) + ")")
    return result.stdout


def directory(path, user, mode=0o700):
    from install import safe_path
    safe_path(Path("/"), str(path).lstrip("/"))
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    account = pwd.getpwnam(user)
    os.chown(path, account.pw_uid, account.pw_gid)
    os.chmod(path, mode)


def install_chromium_dependencies(node, cli, *, user, env):
    # The pinned package proposes public package names as an unprivileged user;
    # root only invokes apt with the bounded package-name grammar below.
    # Playwright reports missing packages with exit 1 on a fresh Ubuntu. Its
    # dry-run still succeeds as a plan; only the validated names reach apt.
    dependencies = execute([str(node), str(cli), 'install-deps', '--dry-run', 'chromium'], user=user, env=env, label='browser dependency plan', success_codes=(0, 1)).decode()
    import re
    packages = sorted(set(re.findall(r'\b(?:lib[a-z0-9.+-]+|fonts-[a-z0-9-]+|xfonts-[a-z0-9-]+|x11-[a-z0-9-]+|xserver-[a-z0-9-]+|xvfb)\b', dependencies)))
    if not packages and 'All system dependencies are installed.' not in dependencies:
        raise ValueError('browser dependency plan is empty')
    if packages:
        execute(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', *packages], label='Chromium system libraries')


def install_browser(root, home, user):
    """A stdio MCP browser with a separate OS identity and no owner-home access."""
    from install import atomic
    browser_user = "nb-" + str(pwd.getpwnam(user).pw_uid)
    state = Path("/var/lib/novsky-browser") / browser_user
    marker = Path("/etc/novsky/codex") / (user + ".browser.json")
    try:
        account = pwd.getpwnam(browser_user)
        if not marker.is_file() or account.pw_dir != str(state) or account.pw_uid >= 1000:
            raise ValueError("existing browser account is not owned by this agent")
    except KeyError:
        if state.exists():
            raise ValueError("browser state already exists without ownership")
        execute(["useradd", "--system", "--user-group", "--home-dir", str(state), "--shell", "/usr/sbin/nologin", browser_user], label="browser account")
        account = pwd.getpwnam(browser_user)
    marker_data = {"user": user, "browserUser": browser_user, "state": str(state)}
    if marker.exists() and json.loads(marker.read_text()) != marker_data:
        raise ValueError("browser ownership mismatch")
    atomic(marker, json.dumps(marker_data), 0, 0)
    directory(state, browser_user)
    runtime = state / "runtime"
    directory(runtime, browser_user)
    shared = Path("/srv/novsky-browser") / user
    shared.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    directory(shared, user, 0o2770)
    os.chown(shared, pwd.getpwnam(user).pw_uid, account.pw_gid)
    execute(["usermod", "-a", "-G", browser_user, user], label="browser artifact group")
    env = {"HOME": str(state), "PATH": f"{state}/.local/lib/novsky-node/bin:/usr/bin:/bin", "PLAYWRIGHT_BROWSERS_PATH": str(state / "ms-playwright"), "LANG": "C.UTF-8"}
    execute(["python3", "-"], user=browser_user, env=env, label="browser Node runtime", input=(root / "installer/install-node.py").read_bytes())
    execute(["npm", "install", "--prefix", str(runtime), "--omit=dev", "--no-audit", "--no-fund", PLAYWRIGHT_MCP_PACKAGE], user=browser_user, env=env, label="Playwright MCP")
    node = state / ".local/lib/novsky-node/bin/node"
    cli = runtime / "node_modules/playwright/cli.js"
    install_chromium_dependencies(node, cli, user=browser_user, env=env)
    execute([str(node), str(cli), "install", "chromium"], user=browser_user, env=env, label="Chromium")
    # Socket activation preserves NoNewPrivileges in the Telegram runtime.
    # The model host opens a private Unix socket; it never invokes sudo.
    unit = "novsky-browser-" + user
    socket_path = "/run/" + unit + ".sock"
    command = [str(node), str(runtime / "node_modules/@playwright/mcp/cli.js"), "--headless", "--browser=chromium",
        "--user-data-dir=" + str(state / "profile"), "--output-dir=" + str(shared)]
    service = "\n".join([
        "[Unit]", "Description=Novsky browser for " + user,
        "[Service]", "Type=exec", "User=" + browser_user, "Group=" + browser_user,
        "ExecStart=" + " ".join(command), "StandardInput=socket", "StandardOutput=inherit", "StandardError=journal",
        "NoNewPrivileges=yes", "PrivateTmp=yes", "PrivateDevices=yes", "ProtectHome=yes", "ProtectSystem=strict",
        "ReadWritePaths=" + str(state) + " " + str(shared), "UMask=0007", "TimeoutStopSec=15", "KillMode=control-group",
        "Environment=HOME=" + str(state), "Environment=PLAYWRIGHT_BROWSERS_PATH=" + str(state / "ms-playwright"), ""])
    socket = "\n".join(["[Unit]", "Description=Novsky browser socket for " + user,
        "[Socket]", "ListenStream=" + socket_path, "SocketUser=" + user, "SocketMode=0600", "Accept=yes", "RemoveOnStop=yes",
        "[Install]", "WantedBy=sockets.target", ""])
    atomic(Path("/etc/systemd/system") / (unit + "@.service"), service, 0, 0, 0o644)
    atomic(Path("/etc/systemd/system") / (unit + ".socket"), socket, 0, 0, 0o644)
    launcher = Path("/usr/local/bin") / unit
    content = """#!/usr/bin/python3
import os,selectors,socket,sys
if len(sys.argv) != 1: sys.exit(64)
connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
connection.connect(SOCKET_PATH)
poller=selectors.DefaultSelector()
poller.register(sys.stdin.buffer,selectors.EVENT_READ)
poller.register(connection,selectors.EVENT_READ)
while True:
    for key,_ in poller.select():
        if key.fileobj is connection:
            data=connection.recv(65536)
            if not data: sys.exit(0)
            sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
        else:
            data=os.read(sys.stdin.fileno(),65536)
            if not data:
                connection.shutdown(socket.SHUT_WR);poller.unregister(sys.stdin.buffer)
            else: connection.sendall(data)
""".replace("SOCKET_PATH", repr(socket_path))
    atomic(launcher, content, 0, 0, 0o755)
    execute(["systemctl", "daemon-reload"], label="browser service")
    execute(["systemctl", "enable", "--now", unit + ".socket"], label="browser socket")
    return {"command": str(launcher), "args": [], "artifacts": str(shared)}



def install_gog(home, user, env):
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine())
    if not architecture:
        raise ValueError("unsupported Google CLI architecture")
    name = "gogcli_0.34.1_linux_" + architecture + ".tar.gz"
    base = "https://github.com/openclaw/gogcli/releases/download/v0.34.1/"
    with urllib.request.urlopen(base + "checksums.txt", timeout=60) as response:
        sums = response.read(100000).decode()
    sha = next((line.split()[0] for line in sums.splitlines() if line.split()[-1] == name), None)
    if not sha:
        raise ValueError("Google CLI checksum is missing")
    with tempfile.TemporaryDirectory(prefix="novsky-gog-") as temp:
        archive = Path(temp) / name
        with urllib.request.urlopen(base + name, timeout=120) as response:
            data = response.read(100 * 1024 * 1024 + 1)
        if len(data) > 100 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != sha:
            raise ValueError("Google CLI checksum mismatch")
        archive.write_bytes(data)
        with tarfile.open(archive) as tar:
            member = tar.getmember("gog")
            if not member.isfile() or member.size > 100 * 1024 * 1024:
                raise ValueError("invalid Google CLI executable")
            content = tar.extractfile(member).read()
        from install import atomic
        account = pwd.getpwnam(user)
        target = home / ".local/lib/novsky-gog/gog"
        atomic(target, content, account.pw_uid, account.pw_gid, 0o755)
        execute([str(target), "--version"], user=user, env=env, label="Google CLI verification")


def install_dependencies(root, home, user, manifest, env):
    features = set(manifest["features"])
    env = {**env, "PATH": f"{home}/.local/bin:{home}/.npm-global/bin:" + env["PATH"]}
    execute(["apt-get", "install", "-y", "-qq", "ca-certificates", "git", "sudo", "python3", "python3-venv", "python3-numpy", "python3-markdown", "sqlite3", "ffmpeg", "curl", "jq", "xz-utils", "libnspr4", "libnss3"], label="kit system dependencies")
    if {'telegram-corporate-sessions', 'browser'} <= features:
        execute(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', 'bubblewrap'], label='corporate browser isolation')
    specs = {
        "spreadsheets": ("spreadsheets", ["openpyxl", "xlsxwriter"], "import openpyxl,xlsxwriter"),
        "finance-data": ("finance", ["yfinance"], "import yfinance"),
        "sql-readonly": ("bigquery", ["google-cloud-bigquery==3.42.2"], "from google.cloud import bigquery"),
    }
    for feature, (name, packages, probe) in specs.items():
        if feature not in features:
            continue
        venv = home / ".venvs" / name
        execute(["python3", "-m", "venv", "--system-site-packages", str(venv)], user=user, env=env, label=name + " environment")
        execute([str(venv / "bin/pip"), "install", "--disable-pip-version-check", *packages], user=user, env=env, label=name + " libraries")
        execute([str(venv / "bin/python"), "-c", probe], user=user, env=env, label=name + " verification")
    if any(name.startswith('document-skills@') for name in manifest['nativePlugins']):
        execute(['apt-get', 'install', '-y', '-qq', '--no-install-recommends', 'libreoffice-writer', 'libreoffice-impress', 'libreoffice-calc', 'poppler-utils', 'libcairo2'], label='document renderers')
        venv = home / '.venvs/documents'
        execute(['python3', '-m', 'venv', '--system-site-packages', str(venv)], user=user, env=env, label='document environment')
        execute([str(venv / 'bin/pip'), 'install', '--disable-pip-version-check', 'python-docx', 'python-pptx', 'pypdf', 'pdfplumber', 'reportlab', 'Pillow', 'cairosvg', 'defusedxml', 'openpyxl', 'xlsxwriter'], user=user, env=env, label='document libraries')
        execute([str(venv / 'bin/python'), '-c', 'import docx,pptx,pypdf,pdfplumber,reportlab,PIL,cairosvg,defusedxml,openpyxl,xlsxwriter'], user=user, env=env, label='document library verification')
        node = home / '.local/lib/novsky-documents'
        execute(['npm', 'install', '--prefix', str(node), '--omit=dev', '--no-audit', '--no-fund', 'docx', 'pptxgenjs', 'pdf-lib', 'sharp'], user=user, env=env, label='document JavaScript libraries')
        execute(['node', '-e', 'for(const name of ["docx","pptxgenjs","pdf-lib","sharp"]) require(name)'], user=user, env={**env, 'NODE_PATH': str(node / 'node_modules')}, label='document JavaScript verification')
    if "google-workspace" in features:
        install_gog(home, user, env)
    if "media-downloads" in features:
        venv = home / ".local/share/novsky-media"
        execute(["python3", "-m", "venv", str(venv)], user=user, env=env, label="media environment")
        execute([str(venv / "bin/pip"), "install", "yt-dlp"], user=user, env=env, label="media downloader")
        execute(["npm", "install", "--prefix", str(home / ".local"), "--no-audit", "--no-fund", "deno"], user=user, env=env, label="media JavaScript runtime")
        execute(["python3", "-c", "from pathlib import Path; p=Path.home()/'.local/bin';p.mkdir(parents=True,exist_ok=True);[(p/n).unlink(missing_ok=True) for n in ('yt-dlp','deno')];(p/'yt-dlp').symlink_to(Path.home()/'.local/share/novsky-media/bin/yt-dlp');(p/'deno').symlink_to(Path.home()/'.local/node_modules/.bin/deno')"], user=user, env=env, label="media commands")
    if "vercel" in features:
        execute(["npm", "install", "--prefix", str(home / ".npm-global"), "--global", "--no-audit", "--no-fund", "vercel"], user=user, env=env, label="Vercel CLI")
    if "video-edit" in features:
        source = home / ".local/share/novsky-kit/resources/assets/video-edit"
        target = home / ".local/share/novsky-video-edit"
        # All copy/npm work is unprivileged; owner code is never executed as root.
        execute(["python3", "-c", "import shutil,sys;shutil.copytree(sys.argv[1],sys.argv[2],dirs_exist_ok=True)", str(source), str(target)], user=user, env=env, label="video runtime assets")
        execute(["npm", "ci", "--no-audit", "--no-fund"], user=user, env=env, cwd=target, label="video runtime libraries")
        execute(["npm", "run", "typecheck"], user=user, env=env, cwd=target, label="video runtime verification")
        execute(["npx", "--no-install", "remotion", "browser", "ensure"], user=user, env=env, cwd=target, label="video browser")
        execute([str(home / "bin/video-edit"), "smoke"], user=user, env=env, label="video render verification")
    return install_browser(root, home, user) if "browser" in features else None
