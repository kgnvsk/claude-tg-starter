#!/usr/bin/env python3
"""Hand an agent of this kit to another owner (owner, 23.11.2026: Novsky's «Передати іншому власнику»).

Root runs it from the agent's own kit folder with one JSON request on stdin:
  {"user": "claude", "ownerChatId": "<Telegram ID>", "ownerName": "<name>", "ownerUsername": "<username or empty>",
   "previous": "superadmin" | "remove", "claudeLogout": true | false}
("claudeLogout": the new owner signs in to his own Claude subscription: the previous owner's login leaves the agent, and
is revoked once the transfer is done; the kit's watchdog then sends the new owner a login link) or, to read only who owns the agent now (Novsky settles a transfer whose answer was lost with it):
  {"user": "claude", "status": true}
  {"user": "claude", "status": true, "owner": "<Telegram ID>"}  (settings that disagree follow this one of their two owners,
                                                                 when access.json already names him an administrator)
A status and an «already» answer never touch the logins, the holds or the service.
Novsky runs the idle check of a kit update right before it, and runs it apart from its SSH channel.

Refused before anything changes: a Codex agent (not changed for now), the owner modules with settings of their own
(Instagram, YouTube), what still ties the agent to the previous owner personally (his own Telegram or WhatsApp through
the personal inbox, his mail and accounts the agent signed in to, the nightly copy into his GitHub, and when he leaves, the
tasks that write to his chat), a superadministrator without company mode, a persona, helper or skill the owner edited
(install-core's own checks, for the new owner's render), restarts held by another operation or by the owner, a service
that does not run. All of it is read under the agent's lifecycle lock, which a running transfer holds until the agent is
back. Asked for the owner the server already has, it changes nothing and reports him (a transfer whose answer was lost,
an owner changed by hand), so Novsky can record him.

Then, under the agent's lifecycle lock (the one its watchdogs restart it under): a restart hold and its systemd drop-in
(no supervisor starts the agent meanwhile, as in update.sh), its crontab suspended, the idle check again for the work
that could have started since Novsky's (as stop-idle does right before its stop) and a scheduler tick at work, the
service stopped, no process of the agent left, the personal ties read again, root's copies in
/root/backups/owner-transfer-<time>-<user>. The owner goes into the live channel settings, the saved settings and the
agent's profile the way install-core writes them, and the previous owner's mail addresses leave them; the persona, the
helpers in ~/bin and the skills are rendered by install-core's own tools against their baselines; access.json gets the
new owner first among the administrators (the previous one a superadministrator or out); Novsky's installation contacts
and the vault's hot cache name him; the previous owner's profile USER.md and the installer's note about him are set
aside and the introduction markers removed; the memory review moves to his chat; the next start is a fresh session. The
memory, the vault and the rules stay. Then the hold goes, the service must be seen running and the crontab comes back.
A failure after the stop puts every copy back and starts the service again; so does a TERM, HUP or INT on the way.

Prints one JSON line. Exit 0 done (with "already": true when the server's owner already is that person, and with
"warnings" for what could not be tidied after a done transfer; a status request answers the owner only); 2 refused,
nothing changed; 3 busy, nothing changed; 1 failed, everything put back; 4 failed and not everything could be put back
(the copies stay in the folder named).
"""
from __future__ import annotations

import fcntl
import importlib.util
import io
import json
import os
import pwd
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(os.environ.get("OWNER_TRANSFER_TEST_ROOT", "/"))  # tests run against a fake root
KIT = Path(__file__).resolve().parents[2]
PY = sys.executable
SETTLE = 5 if ROOT == Path("/") else 0  # seconds the started service must stay up
START_WAIT = 90
# Tests only: the change fails right after the named step, so that each step's way back is proven.
FAIL_AFTER = os.environ.get("OWNER_TRANSFER_FAIL_AFTER", "") if ROOT != Path("/") else ""
# Tests only: the failure comes as this signal to the run itself (TERM, HUP, INT), as a stop or a reboot would send it.
FAIL_SIGNAL = os.environ.get("OWNER_TRANSFER_FAIL_SIGNAL", "") if ROOT != Path("/") else ""
# Tests only: the run's clock for its stamp, so that two runs within one second are shown as they are.
TEST_NOW = os.environ.get("OWNER_TRANSFER_TEST_NOW", "") if ROOT != Path("/") else ""
OWNER_ID = re.compile(r"[1-9][0-9]{4,19}")
AGENT_USER = re.compile(r"[a-z][a-z0-9-]{0,30}")
USERNAME = re.compile(r"[A-Za-z0-9_]{5,32}")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
TEMPLATE = KIT / "assets/templates/CLAUDE.md.template"
MERGE = KIT / "assets/lib/merge-env.py"
PERSONA, PERSONA_BASELINE = ".claude/CLAUDE.premium.md", ".claude/product/CLAUDE.premium.sha256"
REMINDERS, HOLD = ".atarax/reminders", "logs/restart-hold.until"
DROP_IN = "zz-owner-transfer-hold.conf"
# Another operation holds the service (update.sh, Novsky's company transaction): a transfer waits for it to end.
FOREIGN_HOLDS = ("zz-maintenance-hold.conf", "zy-novsky-transaction.conf")
# The scheduler's tick records itself here (cash-reminder-tick); it runs under cron, and stopping the service ends nothing.
TICK_HOLDER = ".atarax/reminders.worker.lock.holder"
# The previous owner's mail and accounts the agent signed in to: the new owner would read and send as him.
ACCOUNTS = ((".config/gogcli", "Google (Gmail, Календар, Диск)"), (".local/share/gogcli", "Google (Gmail, Календар, Диск)"),
            (".config/icloud-mail/credentials.json", "пошта iCloud"), (".config/gh/hosts.yml", "GitHub (вхід gh)"),
            (".config/slack-personal/token.json", "Slack (від його імені)"))
# The kit's and Novsky's own tasks that follow the owner; every other task to the previous owner's chat is his.
SYSTEM_TASKS = ("memory-review", "novsky-onboarding")
# Everything this command may change in the agent's home, copied before the first change; skills come from the check.
HOME_FILES = (".claude/channels/telegram/.env", ".claude/channels/telegram/access.json", ".agent-profile.env",
              PERSONA, PERSONA_BASELINE, "bin", ".claude/product/managed-runtime-baseline.json",
              ".claude/product/managed-skills.json", ".claude/product/managed-skills-baseline.json",
              ".claude/memory/USER.md", ".claude/memory/first-contact.done", ".novsky/client-context.md",
              ".novsky/onboarding.json", ".claude/fresh-start.flag", "CLAUDE.md", "obsidian-vault/OWNER.md",
              "obsidian-vault/wiki/hot.md", ".novsky-installation-people.json", "logs/access-grants.log",
              ".claude/.credentials.json", ".claude/.credentials.json.relogin", ".claude/auth-rescue-auto-attempts",
              "logs/auth-rescue.state", ".claude.json")
# The Claude login the agent runs on, and the copy a forced relogin keeps aside.
CREDENTIALS = (".claude/.credentials.json", ".claude/.credentials.json.relogin")
# What decides when the kit's watchdog sends a login link: removed, the new owner gets his link at the next check.
RESCUE_STATE = (".claude/auth-rescue-auto-attempts", "logs/auth-rescue.state")
# Where a login copy waits for its revocation: outside the agent's home, in a folder only root lists, only while the agent
# is stopped (no process of the agent but the CLI that revokes it exists meanwhile); /run is gone at a reboot.
LOGOUT_ROOT = ROOT / "run/owner-transfer-logout"

# The idle check's part that new work shows in (Novsky's corporate-update.py busy, read as the agent): a message in
# the queue, an open turn, a request answered in the last half hour, company work; and the background commands that
# belong to no request, which a running command may be (they wait for hours and are not counted).
QUIET = r"""
import json, sqlite3, sys, time
reasons, exempt = [], []
try:
    connection = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=10)
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        recent = int(time.time() * 1000) - 30 * 60 * 1000
        for name, table, sql, args in (
                ("queue", "pending_inbound_deliveries", "SELECT count(*) FROM pending_inbound_deliveries", ()),
                ("open-turns", "delivery_turns", "SELECT count(*) FROM delivery_turns WHERE closed_at IS NULL", ()),
                ("unfinished-results", "delivery_results", "SELECT count(*) FROM delivery_results WHERE state NOT IN "
                 "('complete','no_reply','cancelled','failed','blocked') AND updated_at > ?", (recent,)),
                ("company-jobs", "conversation_jobs", "SELECT count(*) FROM conversation_jobs WHERE state IN "
                 "('queued','leased','prompt_submitted','result_persisted','outbound_sending')", ())):
            if table in tables:
                count = connection.execute(sql, args).fetchone()[0]
                if count:
                    reasons.append(name + "=" + str(count))
        if {"delivery_task_launches", "delivery_task_owners"} <= tables:
            exempt = [row[0] for row in connection.execute(
                "SELECT o.task_id FROM delivery_task_owners o JOIN delivery_task_launches l ON l.launch_ref=o.launch_ref "
                "AND l.task_id=o.task_id AND l.session_id=o.session_id AND l.stamp=o.stamp WHERE l.tool_name='Bash' "
                "AND l.state='resolved' AND o.state='unowned' AND o.delivery_id IS NULL AND o.launched_turn IS NULL") if row[0]]
    finally:
        connection.close()
except sqlite3.Error:
    reasons.append("ledger-unreadable")
print(json.dumps({"reasons": reasons, "exempt": exempt}))
"""
# Whether the nightly copy goes to a GitHub repository: the nightly runner's own choice of a configured backend.
GITHUB = r"""
import importlib.machinery, importlib.util, pathlib, sys
loader = importlib.machinery.SourceFileLoader("nightly_github_backup", sys.argv[1])
module = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
loader.exec_module(module)
print("yes" if module.selected_command(pathlib.Path(sys.argv[2])) else "no")
"""
# The queued tasks that write to a chat, by name, read as reminder-task reads their headers.
TASKS = r"""
import pathlib, re, sys
header, found = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$"), []
for path in sorted(pathlib.Path(sys.argv[1]).glob("*.rem")):
    fields = {}
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        match = header.fullmatch(line)
        if not match:
            break
        fields.setdefault(match.group(1), match.group(2))
    if fields.get("CHAT") == sys.argv[2] and fields.get("TASK") not in sys.argv[3].split(","):
        found.append(fields.get("TASK") or path.stem)
print("\n".join(found))
"""
# The account the CLI names (email, organisation) in its record ~/.claude.json: the previous owner's, it goes with his login.
OAUTH = r"""
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
if path.is_file() and not path.is_symlink():
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "oauthAccount" in data:
        data.pop("oauthAccount")
        mode = path.stat().st_mode & 0o777
        descriptor, temporary = tempfile.mkstemp(prefix=".claude.json.", dir=path.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as out:
            json.dump(data, out, ensure_ascii=False, indent=2)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
"""
# Whether Claude Code reaches the model with a key from apiKeyHelper (a Nooman agent), read as the kit's own notices read it.
API_KEY = r"""
import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("agent_notice_locale", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(module.api_key_access(pathlib.Path(sys.argv[2])))
"""
# Novsky's installation contacts (its installation-people.py): the block in ~/CLAUDE.md and the vault's OWNER.md and the
# marker beside the home name the owner. They name the new one; an installer who became the owner is no separate person
# any more, and his block goes. The block's JSON keeps no "<": a name cannot close the comment that ends the block. The
# vault's hot cache, which every session reads, names the owner on one line from the install (vault-skeleton/wiki/hot.md).
PEOPLE = r"""
import json, os, pathlib, re, sys, tempfile
home, owner, previous, line = pathlib.Path(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3], sys.argv[4]
block = re.compile(r"\n*<!-- novsky-installation-people -->.*?<!-- /novsky-installation-people -->\n?", re.S)
details = re.compile(r"(\{\s*\"owner\".*\})(\s*<!-- /novsky-installation-people -->)", re.S)
def put(path, text):
    mode = path.stat().st_mode & 0o777
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    with os.fdopen(descriptor, "w", encoding="utf-8") as out:
        out.write(text)
    os.chmod(temporary, mode)
    os.replace(temporary, path)
marker = home / ".novsky-installation-people.json"
if marker.is_file() and not marker.is_symlink():
    data = json.loads(marker.read_text(encoding="utf-8"))
    data["owner"] = owner
    put(marker, json.dumps(data, ensure_ascii=False) + "\n")
for path in (home / "CLAUDE.md", home / "obsidian-vault/OWNER.md"):
    if not path.is_file() or path.is_symlink():
        continue
    text = path.read_text(encoding="utf-8")
    found = block.search(text)
    if not found:
        continue
    inside = details.search(found.group(0))
    people = json.loads(inside.group(1)) if inside else None
    if not isinstance(people, dict) or not isinstance(people.get("owner"), dict):
        raise SystemExit(path.name + ": контакти установки не прочитано")
    if (people.get("administrator") or {}).get("chatId") == owner["chatId"]:
        rest = text[:found.start()] + text[found.end():]
        new = rest if rest.endswith("\n") or not rest else rest + "\n"
    else:
        people["owner"] = owner
        whole = found.group(0)
        written = json.dumps(people, ensure_ascii=False, indent=2).replace("<", "\\u003c")
        new = text.replace(whole, whole[:inside.start(1)] + written + whole[inside.end(1):], 1)
    if new != text:
        put(path, new)
hot = home / "obsidian-vault/wiki/hot.md"
if hot.is_file() and not hot.is_symlink():
    text = hot.read_text(encoding="utf-8")
    new = re.sub(r"(?m)^- [^\n]*\bchat_id " + re.escape(previous) + r"\b[^\n]*$", lambda _: line, text, count=1)
    if new != text:
        put(hot, new)
"""


class Refused(Exception):
    """Nothing changed."""

    def __init__(self, reason: str, code: int = 2) -> None:
        super().__init__(reason)
        self.reason, self.code = reason, code


class Failed(Exception):
    pass


SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)


def interrupted(number, _frame) -> None:
    """A TERM, HUP or INT while the agent is held: the way back runs as for any failure, and is not interrupted again
    (update.sh traps them for the same reason: the hold, the drop-in and the suspended crontab must not stay)."""
    for name in SIGNALS:
        signal.signal(name, signal.SIG_IGN)
    raise Failed(f"передачу перервано сигналом {signal.Signals(number).name}")


def refuse(reason: str, code: int = 2):
    raise Refused(reason, code)


def answer(code: int, **fields) -> int:
    try:  # a channel closed meanwhile leaves the agent as this run left it; nothing else depends on the print
        print(json.dumps({"ok": code == 0, **fields}, ensure_ascii=False), flush=True)
    except OSError:
        pass
    return code


def last_line(text: str | bytes) -> str:
    if isinstance(text, bytes):
        text = text.decode("utf-8", "replace")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[-1][:300] if lines else ""


def kit_module(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, KIT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Agent:
    def __init__(self, user: str) -> None:
        primary = user == "claude"
        self.user, self.home = user, ROOT / "home" / user
        self.state = self.home / ".claude/channels/telegram"
        self.unit = "claude-telegram.service" if primary else f"claude-telegram@{user}.service"
        self.config = ROOT / "etc/claude-tg-starter" / ("agent.env" if primary else f"agent-{user}.env")


def as_agent(a: Agent, command: list, env: dict | None = None, stdin=None, binary: bool = False, timeout: int = 600):
    """With the agent's own rights and only the environment given here, as install-core runs its tools. Nothing here
    reaches the agent through /dev/stdin: reopening root's pipe is refused to the agent."""
    clean = {"HOME": str(a.home), "USER": a.user, "LOGNAME": a.user, "PATH": "/usr/local/bin:/usr/bin:/bin",
             "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1", **(env or {})}
    prefix = ["runuser", "-u", a.user, "--"] if os.geteuid() == 0 else []
    return subprocess.run([*prefix, "env", "-i", *(f"{name}={value}" for name, value in clean.items()), *map(str, command)],
                          input=stdin, capture_output=True, text=not binary, timeout=timeout)


def must(result, what: str, ok=(0,)):
    if result.returncode not in ok:
        raise Failed(f"{what}: {last_line(result.stderr) or last_line(result.stdout) or f'код {result.returncode}'}")
    return result


def done(what: str) -> None:
    if FAIL_AFTER == what:
        if FAIL_SIGNAL:
            os.kill(os.getpid(), getattr(signal, "SIG" + FAIL_SIGNAL))
        raise Failed(f"{what}: тестова відмова після кроку")


def systemctl(*args: str):
    try:
        return subprocess.run(["systemctl", *args], capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:  # a state nobody can read: the callers wait for one, and then say so
        return subprocess.CompletedProcess(["systemctl", *args], 124, "", "timeout")


def state_of(unit: str) -> str:
    return systemctl("is-active", unit).stdout.strip()


def stop(unit: str) -> None:
    systemctl("stop", unit)
    if state_of(unit) not in ("inactive", "failed"):
        raise Failed("службу агента не вдалося зупинити")


def start(unit: str) -> None:
    systemctl("start", unit)
    deadline = time.monotonic() + START_WAIT
    while (state := state_of(unit)) != "active":
        if state == "failed" or time.monotonic() > deadline:
            raise Failed(f"служба агента не запустилася ({state or 'стан невідомий'})")
        time.sleep(1)
    time.sleep(SETTLE)
    if state_of(unit) != "active":
        raise Failed("служба агента запустилася й одразу впала")


def write_private(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)


def replace_private(path: Path, data: bytes) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def request_of(raw: str) -> dict:
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if isinstance(data, dict) and {"user", "status"} <= set(data) <= {"user", "status", "owner"} and data["status"] is True:
        if not isinstance(data["user"], str) or not AGENT_USER.fullmatch(data["user"]) or data["user"] in ("root", "claude-browser", "streampost"):
            refuse("Некоректний користувач агента")
        settle = data.get("owner")
        if settle is not None and (not isinstance(settle, str) or not OWNER_ID.fullmatch(settle)):
            refuse("Власник, на якого узгодити налаштування, — Telegram ID")
        return {"user": data["user"], "status": True, "settle": settle}
    fields = {"user", "ownerChatId", "ownerName", "ownerUsername", "previous", "claudeLogout"}
    if not isinstance(data, dict) or not set(data) <= fields:
        refuse("Запит — один JSON-обʼєкт з полями user, ownerChatId, ownerName, ownerUsername, previous, claudeLogout")
    if not isinstance(data.get("claudeLogout", False), bool):
        refuse("claudeLogout — true або false")
    user, owner, name = data.get("user"), data.get("ownerChatId"), data.get("ownerName")
    username, previous = data.get("ownerUsername", ""), data.get("previous")
    if not isinstance(user, str) or not AGENT_USER.fullmatch(user) or user in ("root", "claude-browser", "streampost"):
        refuse("Некоректний користувач агента")
    if not isinstance(owner, str) or not OWNER_ID.fullmatch(owner):
        refuse("Telegram ID нового власника — це число з @userinfobot")
    if not isinstance(name, str) or not name.strip() or len(name) > 200 or CONTROL.search(name):
        refuse("Імʼя нового власника — один рядок до 200 символів")
    username = username.strip().removeprefix("@") if isinstance(username, str) else None
    if username is None or (username and not USERNAME.fullmatch(username)):
        refuse("Username нового власника: 5–32 латинські літери, цифри або _; можна залишити порожнім")
    if previous not in ("superadmin", "remove"):
        refuse("Попередній власник лишається суперадміністратором (superadmin) або втрачає доступ (remove)")
    return {"user": user, "owner": owner, "name": name.strip(), "username": username, "previous": previous,
            "logout": data.get("claudeLogout", False)}


def codex_agent(user: str) -> bool:
    return any(os.path.lexists(path) for path in (
        ROOT / f"etc/novsky/codex/{user}.json", ROOT / f"etc/novsky/codex/{user}.installed.json",
        ROOT / f"etc/systemd/system/codex-telegram@{user}.service"))


def saved_settings(a: Agent, merge) -> dict[str, str]:
    try:
        info = os.lstat(a.config)
    except FileNotFoundError:
        refuse("Це не агент Claude Code цього кита: на сервері немає його збережених налаштувань")
    if not stat.S_ISREG(info.st_mode):
        refuse("Збережені налаштування агента — не звичайний файл")
    try:
        return merge.parse(a.config)
    except (OSError, UnicodeError, ValueError):
        refuse("Збережені налаштування агента не читаються; спершу онови кит")


def template_values(a: Agent, saved: dict[str, str], r: dict) -> dict[str, str]:
    """What install-core renders the kit's templates with: the saved settings with the live profile over them, as
    update.sh reads them (a name or a language the owner changed after the install wins), and the new owner."""
    kept = {name: saved.get(name, "") for name in ("AGENT_NAME", "BOT_USERNAME", "TIMEZONE", "CALENDAR_EMAIL", "OWNER_NOTICE_LOCALE")}
    exported = as_agent(a, [PY, KIT / "assets/bin/update-safety-check", "profile-export", "--home", a.home], binary=True)
    if exported.returncode:
        refuse("Профіль агента ~/.agent-profile.env не читається; спершу онови кит")
    pairs = exported.stdout.split(b"\0")
    live = {pairs[index].decode("utf-8"): pairs[index + 1].decode("utf-8") for index in range(0, len(pairs) - 1, 2)}
    kept.update({name: value for name, value in live.items() if name in kept})
    if not all(kept[name] for name in ("AGENT_NAME", "BOT_USERNAME", "TIMEZONE")):
        refuse("У налаштуваннях агента бракує імені, бота чи часового поясу; спершу онови кит")
    # The calendar is the previous owner's: the new one connects his own (cash-morning-calendar is rendered with it).
    return {**kept, "CALENDAR_EMAIL": "", "OWNER_NOTICE_LOCALE": kept["OWNER_NOTICE_LOCALE"] or "uk", "OWNER_CHAT_ID": r["owner"],
            "OWNER_NAME": r["name"], "OWNER_TG_USERNAME": r["username"], "DEPLOY_DATE": time.strftime("%Y-%m-%d"),
            "AGENT_HOME": str(a.home), "AGENT_SERVICE": a.unit, "AGENT_USER": a.user}


def runtime_args(a: Agent) -> list:
    return ["--home", a.home, "--kit", KIT, "--policy", KIT / "assets/product/managed-runtime.json",
            "--baseline", a.home / ".claude/product/managed-runtime-baseline.json", "--owner", a.user]


def skills_command(a: Agent) -> list:
    return [PY, KIT / "assets/lib/reconcile-managed-skills.py", a.home / ".claude/skills",
            KIT / "assets/product/managed-skills.json", a.home / ".claude/product/managed-skills.json",
            "--source", KIT / "assets/skills", "--external-source", KIT / "assets/external-skills",
            "--baseline", a.home / ".claude/product/managed-skills-baseline.json"]


def personal_ties(a: Agent, r: dict, old: str) -> None:
    """What still belongs to the previous owner personally: the change waits until it is undone."""
    inbox = a.home / ".claude/personal-inbox"
    if os.path.lexists(inbox / "telegram-owner.session") or os.path.lexists(inbox / "whatsapp"):
        refuse("Агент підключений до особистого Telegram чи WhatsApp попереднього власника («Особисті переписки»): новий "
               "власник читав би його листування й відповідав би від його імені. Спершу попереднього власника відʼєднують: "
               "попроси агента відʼєднати особисті Telegram і WhatsApp (або прибери ~/.claude/personal-inbox на сервері), "
               "потім повтори передачу.")
    signed = [(path, what) for path, what in ACCOUNTS if os.path.lexists(a.home / path)]
    if signed:
        refuse(f"Агент входив в облікові записи попереднього власника ({', '.join(dict.fromkeys(what for _, what in signed))}): "
               "новий власник читав би його пошту й писав би від його імені. Спершу видали на сервері "
               f"{', '.join('~/' + path for path, _ in signed)} (вихід через самого агента ці файли не прибирає), потім повтори передачу.")
    github = as_agent(a, [PY, "-c", GITHUB, KIT / "assets/bin/agent-nightly-github-backup", a.home], timeout=60)
    if github.stdout.strip() != "no":
        refuse("Агент щоночі копіює памʼять і вольт у GitHub попереднього власника: туди пішли б і нотатки нового. Спершу "
               "вимкни цю копію (попроси агента вимкнути резервну копію на GitHub; її стан у ~/.local/state/agent-github-backup "
               "і ~/.local/state/agent-full-backup), потім повтори передачу.")
    if r["previous"] == "remove":
        tasks = as_agent(a, [PY, "-c", TASKS, a.home / REMINDERS, old, ",".join(SYSTEM_TASKS)], timeout=60)
        names = tasks.stdout.split() if tasks.returncode == 0 else ["?"]
        if names:
            refuse(f"У розкладі агента є завдання й нагадування для попереднього власника ({', '.join(names[:3])}"
                   f"{' …' if len(names) > 3 else ''}): після передачі вони й далі писали б йому. Попроси агента скасувати їх "
                   "(або залиш попереднього власника суперадміном), потім повтори передачу.")


def preflight(a: Agent, values: dict[str, str]) -> tuple[list[str], list[str]]:
    """The checks install-core makes before it writes, for the new owner's render. Returns the skills that change and
    the ones that would be new."""
    if not os.path.lexists(a.home / PERSONA_BASELINE):
        refuse("Для ~/.claude/CLAUDE.premium.md ще немає контрольної суми кита: спершу онови кит")
    render = [PY, KIT / "assets/lib/render-template.py", "--check-baseline", a.home / PERSONA_BASELINE, TEMPLATE, a.home / PERSONA]
    if as_agent(a, render, values).returncode:
        refuse("Особистість агента ~/.claude/CLAUDE.premium.md змінено вручну або вона не з цього кита: передачу не почато. "
               "Поверни файл до версії кита або онови кит і повтори")
    plan = as_agent(a, [PY, KIT / "assets/bin/update-safety-check", "plan", *runtime_args(a), "--json"], values)
    if plan.returncode == 3:
        try:
            changed = sorted("~/" + item["path"] for item in json.loads(plan.stdout)["actions"]
                             if item.get("action") in ("conflict", "unclassified"))
        except (ValueError, KeyError, TypeError):
            changed = []
        refuse(f"Власник змінив керовані помічники кита ({', '.join(changed) or 'див. update-safety-check plan'}): "
               "передачу не почато")
    if plan.returncode:
        refuse("Помічники агента в ~/bin не перевірено: " + (last_line(plan.stderr) or f"код {plan.returncode}"))
    skills = as_agent(a, [*skills_command(a), "--check"], values)
    try:
        actions = json.loads(skills.stdout)["actions"] if skills.returncode == 0 else None
    except (ValueError, KeyError, TypeError):
        actions = None
    if not isinstance(actions, dict):
        refuse("Навички агента не перевірено: " + (last_line(skills.stderr) or f"код {skills.returncode}") + "; передачу не почато")
    changing = [f".claude/{folder}/{name}" for name, action in sorted(actions.items())
                if action in ("update", "remove") for folder in ("skills", "skills.disabled")]
    return changing, [f".claude/skills/{name}" for name, action in sorted(actions.items()) if action == "install"]


def lifecycle_lock(a: Agent, uid: int) -> int:
    """The lock the watchdogs stop and restart the agent under (cash-healthcheck, unstick-watch, limit recovery)."""
    try:
        logs = os.open(a.home / "logs", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        refuse("Немає теки ~/logs агента; спершу онови кит")
    try:
        descriptor = os.open("transport-lifecycle.lock", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=logs)
    except OSError:
        refuse("Немає замка служби агента ~/logs/transport-lifecycle.lock; спершу онови кит")
    finally:
        os.close(logs)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_nlink != 1:
        os.close(descriptor)
        refuse("Замок служби агента — не його звичайний файл")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        refuse("Службу агента саме перезапускає сторож або інша операція (передача власника, оновлення); спробуй за хвилину", 3)
    return descriptor


def hold(a: Agent) -> None:
    """The restart hold the kit's watchdogs read, and a drop-in that starts nothing while it lasts (update.sh)."""
    must(as_agent(a, ["sh", "-c", 'umask 077; echo $(( $(date +%s) + 3600 )) > "$1.tmp" && mv -f "$1.tmp" "$1"', "hold",
                      a.home / HOLD]), "утримання служби")
    folder = ROOT / "etc/systemd/system" / f"{a.unit}.d"
    folder.mkdir(mode=0o755, parents=True, exist_ok=True)
    (folder / DROP_IN).write_text(f"[Unit]\nConditionPathExists=!{a.home / HOLD}\n", encoding="utf-8")
    os.chmod(folder / DROP_IN, 0o644)
    systemctl("daemon-reload")


def release(a: Agent) -> list[str]:
    """The drop-in and the hold gone, whatever happened before; what could not be removed is named."""
    problems = []
    folder = ROOT / "etc/systemd/system" / f"{a.unit}.d"
    try:
        (folder / DROP_IN).unlink(missing_ok=True)
        if folder.is_dir() and not any(folder.iterdir()):
            folder.rmdir()
    except OSError:
        problems.append(f"drop-in {folder / DROP_IN}")
    systemctl("daemon-reload")
    try:
        if as_agent(a, ["rm", "-f", "--", a.home / HOLD]).returncode:
            problems.append(f"~/{HOLD}")
    except (OSError, subprocess.SubprocessError):
        problems.append(f"~/{HOLD}")
    return problems


def crontab_of(a: Agent) -> str | None:
    listed = subprocess.run(["crontab", "-u", a.user, "-l"], capture_output=True, text=True, timeout=60)
    if listed.returncode == 0:
        return listed.stdout
    if "no crontab" in listed.stderr.lower():
        return None
    raise Failed("розклад агента не прочитано: " + last_line(listed.stderr))


def suspend_cron(a: Agent, folder: Path) -> None:
    """The whole crontab kept in the copies and removed for the change, as the update's quiesce step does."""
    write_private(folder / "crontab.json", json.dumps({"text": crontab_of(a)}).encode())
    subprocess.run(["crontab", "-u", a.user, "-r"], capture_output=True, timeout=60)
    if crontab_of(a) is not None:
        raise Failed("розклад агента не призупинено")


def restore_cron(a: Agent, folder: Path) -> bool:
    saved = folder / "crontab.json"
    try:
        if not saved.exists():
            return True
        text = json.loads(saved.read_text(encoding="utf-8"))["text"]
        if text is None:
            subprocess.run(["crontab", "-u", a.user, "-r"], capture_output=True, timeout=60)
        else:
            subprocess.run(["crontab", "-u", a.user, "-"], input=text, text=True, capture_output=True, timeout=60)
        return crontab_of(a) == text
    except (OSError, ValueError, KeyError, subprocess.SubprocessError, Failed):
        return False


def tool_running(uid: int, exempt: set[str]) -> bool:
    """A Claude tool command of the agent runs (Novsky's busy): its own snapshot names it; one whose output is the task of
    a background command of no request is not counted."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or pid == str(os.getpid()):
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != uid:
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as command:
                if b"/shell-snapshots/snapshot-" not in command.read():
                    continue
        except OSError:
            continue
        try:
            task = re.search(r"/tasks/([A-Za-z0-9]+)\.output$", os.readlink(f"/proc/{pid}/fd/1"))
        except OSError:
            return True
        if not task or task.group(1) not in exempt:
            return True
    return False


def tick_running(a: Agent, uid: int) -> bool:
    """The scheduler's tick at work, as the tick itself tells (its holder record: the process and when it started)."""
    try:
        descriptor = os.open(a.home / TICK_HOLDER, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, encoding="utf-8") as source:
            fields = dict(line.split("=", 1) for line in source.read(4096).splitlines() if "=" in line)
    except (OSError, UnicodeError, ValueError):
        return False
    pid = fields.get("PID", "")
    try:
        if not pid.isdigit() or os.stat(f"/proc/{pid}").st_uid != uid:
            return False
    except OSError:
        return False
    if fields.get("TZ") != "UTC":
        return True  # an older record: a live process of the agent under that number is enough
    started = subprocess.run(["ps", "-o", "lstart=", "-p", pid], capture_output=True, text=True, timeout=30,
                             env={**os.environ, "LC_ALL": "C", "TZ": "UTC"}).stdout.strip()
    return bool(started) and started == fields.get("START", "")


def quiet(a: Agent, uid: int) -> str:
    """Why the agent is not idle now, or nothing."""
    try:
        found = json.loads(as_agent(a, [PY, "-c", QUIET, a.state / "messages.db"], timeout=60).stdout)
    except (ValueError, OSError, subprocess.SubprocessError):
        return "ledger-unreadable"
    reasons = list(found.get("reasons") or [])
    if tool_running(uid, set(found.get("exempt") or [])):
        reasons.append("tool-running")
    if tick_running(a, uid):
        reasons.append("reminder-tick")  # a memory review in flight would write the previous owner into the new profile
    return " ".join(reasons)


def leftovers(uid: int) -> str:
    """The agent's processes that outlive its service's stop (cron's jobs, a session someone opened): the change waits."""
    if ROOT != Path("/"):
        return ""  # tests in a fake root: the test's own account stands for the agent there
    deadline = time.monotonic() + 10
    while True:
        names = []
        for pid in os.listdir("/proc"):
            try:
                if pid.isdigit() and int(pid) != os.getpid() and os.stat(f"/proc/{pid}").st_uid == uid:
                    with open(f"/proc/{pid}/cgroup", encoding="utf-8", errors="replace") as cgroup:
                        if f"/user@{uid}.service/" in cgroup.read():
                            continue  # the account's own systemd manager and its services (lingering): not the kit's agent
                    with open(f"/proc/{pid}/comm", encoding="utf-8", errors="replace") as comm:
                        names.append(comm.read().strip())
            except OSError:
                continue
        if not names or time.monotonic() > deadline:
            return ", ".join(sorted(set(names))[:5])
        time.sleep(1)


def backup(a: Agent, folder: Path, skills: list[str], record: dict) -> list[str]:
    queued = sorted(path.relative_to(a.home).as_posix() for path in (a.home / REMINDERS).glob("*-memory-review.rem"))
    names = [name for name in (*HOME_FILES, *skills, *queued) if os.path.lexists(a.home / name)]
    archive = must(as_agent(a, ["tar", "-C", a.home, "-cf", "-", "--", *names], binary=True), "копія файлів агента")
    write_private(folder / "home.tar", archive.stdout)
    write_private(folder / "agent.env", a.config.read_bytes())
    write_private(folder / "manifest.json", json.dumps({**record, "config": str(a.config), "home": names},
                                                       ensure_ascii=False, indent=2).encode())
    return names


def put_back(a: Agent, folder: Path, names: list[str], created: list[str]) -> list[str]:
    """Every copy back where it was, and what this run made gone. Returns what could not be put back."""
    problems = []
    systemctl("stop", a.unit)
    if state_of(a.unit) not in ("inactive", "failed"):
        problems.append("службу не зупинено перед поверненням")
    # Each step runs whatever happened to the one before.
    try:
        if as_agent(a, ["tar", "-C", a.home, "-xpf", "-"], stdin=(folder / "home.tar").read_bytes(), binary=True).returncode:
            problems.append("файли агента")
    except (OSError, subprocess.SubprocessError):
        problems.append("файли агента")
    extra = [a.home / name for name in created if name not in names and os.path.lexists(a.home / name)]
    try:
        if extra and as_agent(a, ["rm", "-rf", "--", *extra]).returncode:
            problems.append("нові файли передачі")
    except (OSError, subprocess.SubprocessError):
        problems.append("нові файли передачі")
    try:
        replace_private(a.config, (folder / "agent.env").read_bytes())
    except OSError:
        problems.append("збережені налаштування")
    return problems


def managed(values: dict[str, str]) -> str:
    return "".join(f"{name}={shlex.quote(value)}\n" for name, value in values.items())


def merge_agent_file(a: Agent, path: Path, values: dict[str, str], what: str) -> None:
    """As install-core writes the channel settings: the agent's file read without following a link, merged in root's own
    files, put in place by the home helper as the agent's file."""
    helper = [PY, KIT / "assets/lib/agent-home.py", a.home, a.user]
    with tempfile.TemporaryDirectory(prefix="owner-transfer-") as work:
        previous, written, merged = (Path(work) / name for name in ("previous", "managed", "merged"))
        read = subprocess.run([*helper, "read", path], capture_output=True, timeout=60)
        if read.returncode not in (0, 4):
            raise Failed(f"{what}: {last_line(read.stderr) or 'файл не прочитано'}")
        previous.write_bytes(read.stdout if read.returncode == 0 else b"")
        written.write_text(managed(values), encoding="utf-8")
        must(subprocess.run([PY, MERGE, previous, written, merged], capture_output=True, text=True, timeout=60), what)
        must(subprocess.run([*helper, "copy", "600", merged, path], capture_output=True, text=True, timeout=60), what)


def merge_root_file(path: Path, values: dict[str, str], what: str) -> None:
    with tempfile.TemporaryDirectory(prefix="owner-transfer-") as work:
        written = Path(work) / "managed"
        written.write_text(managed(values), encoding="utf-8")
        must(subprocess.run([PY, MERGE, path, written, path], capture_output=True, text=True, timeout=60), what)


def change(a: Agent, r: dict, old: str, values: dict[str, str], stamp: str, at: int) -> None:
    owner = {"OWNER_CHAT_ID": r["owner"], "OWNER_NAME": r["name"]}
    # The previous owner's mail and calendar addresses are his: the new owner gives his own.
    known = {**owner, "OWNER_TG_USERNAME": r["username"], "OWNER_EMAIL": "", "CALENDAR_EMAIL": ""}
    merge_agent_file(a, a.state / ".env", owner, "налаштування каналу")
    done("налаштування каналу")
    merge_agent_file(a, a.home / ".agent-profile.env", known, "профіль агента")
    done("профіль агента")
    merge_root_file(a.config, known, "збережені налаштування")
    done("збережені налаштування")
    must(as_agent(a, [PY, KIT / "assets/bin/access-update", "transfer-owner", a.state / "access.json", old, r["owner"],
                      r["previous"]]), "доступи")
    done("доступи")
    # The files the kit renders with the owner, by install-core's tools: each against its baseline, accepted after.
    render = [PY, KIT / "assets/lib/render-template.py"]
    for action in ("--apply-baseline", "--accept-baseline"):
        must(as_agent(a, [*render, action, a.home / PERSONA_BASELINE, TEMPLATE, a.home / PERSONA], values), "особистість агента")
    done("особистість агента")
    must(as_agent(a, [PY, KIT / "assets/bin/update-safety-check", "apply", *runtime_args(a)], values), "помічники в ~/bin")
    done("помічники в ~/bin")
    must(as_agent(a, skills_command(a), values), "навички")
    done("навички")
    contact = {"name": r["name"], "username": r["username"], "chatId": r["owner"]}
    hot = f"- {r['name']}{' (@' + r['username'] + ')' if r['username'] else ''}, chat_id {r['owner']}, часовий пояс {values['TIMEZONE']}"
    must(as_agent(a, [PY, "-c", PEOPLE, a.home, json.dumps(contact, ensure_ascii=False), old, hot]), "контакти установки")
    done("контакти установки")
    # The agent meets its new owner from the start; what it knew about the previous one waits aside.
    memory, novsky = a.home / ".claude/memory", a.home / ".novsky"
    for source, target in ((memory / "USER.md", memory / f"USER.previous-owner-{stamp}.md"),
                           (novsky / "client-context.md", novsky / f"client-context.previous-owner-{stamp}.md"),
                           (novsky / "onboarding.json", novsky / f"onboarding.previous-owner-{stamp}.json")):
        if os.path.lexists(source):
            must(as_agent(a, ["mv", "-T", "--", source, target]), "профіль попереднього власника")
    must(as_agent(a, ["install", "-m", "600", "-T", KIT / "assets/templates/USER.md", memory / "USER.md"]), "новий профіль власника")
    must(as_agent(a, ["rm", "-f", "--", memory / "first-contact.done"]), "знайомство з власником")
    done("знайомство з власником")
    # The memory review goes to the owner's chat as install-core puts it in (ensure_memory_review_task).
    if any((a.home / REMINDERS).glob("*-memory-review.rem")):
        task = [PY, KIT / "assets/bin/reminder-task"]
        must(as_agent(a, [*task, "cancel", "--task", "memory-review"], timeout=120), "огляд памʼяті", ok=(0, 2))
        must(as_agent(a, [*task, "repeat", "--task", "memory-review", "--chat", r["owner"], "--at", str(at), "--every", "120",
                          "--timezone", values["TIMEZONE"], "--run", "--self-deliver", "--retry-safe",
                          "--check", "$HOME/bin/owner-chat-recent review-check",
                          "--text", (KIT / "assets/templates/memory-review-prompt.txt").read_text(encoding="utf-8")],
                      timeout=120), "огляд памʼяті")
    done("огляд памʼяті")
    # The launcher starts one fresh session on this flag: the new owner does not continue the previous one's.
    must(as_agent(a, ["touch", "--", a.home / ".claude/fresh-start.flag"]), "нова сесія")
    done("нова сесія")
    if r["logout"]:
        # The previous owner's Claude login leaves the agent; the copies keep it until the transfer is done, and only then
        # is it revoked (sign_out). The watchdog's own state goes too, so the new owner's link is not held back.
        must(as_agent(a, ["rm", "-f", "--", *(a.home / name for name in (*CREDENTIALS, *RESCUE_STATE))]), "вихід із Claude")
        must(as_agent(a, [PY, "-c", OAUTH, a.home / ".claude.json"]), "вихід із Claude")
        done("вихід із Claude")


def logins(folder: Path) -> dict[str, bytes]:
    """The previous owner's Claude logins in root's copies: the one the agent ran on and the copy a relogin kept."""
    found = {}
    with tarfile.open(fileobj=io.BytesIO((folder / "home.tar").read_bytes())) as archive:
        for name in CREDENTIALS:
            try:
                member = archive.extractfile(name)
            except KeyError:
                continue
            if member and (data := member.read()):
                found[name] = data
    return found


def revoke(a: Agent, uid: int, data: bytes) -> str:
    """One login revoked with Anthropic by the agent's own CLI (never run as root), from a copy in a folder of its own under
    LOGOUT_ROOT. Returns what went wrong, or nothing."""
    claude = a.home / ".local/bin/claude"
    if not os.access(claude, os.X_OK):
        return "Claude CLI агента не знайдено"
    LOGOUT_ROOT.mkdir(mode=0o711, parents=True, exist_ok=True)
    os.chmod(LOGOUT_ROOT, 0o711)
    work = Path(tempfile.mkdtemp(prefix=f"{a.user}.", dir=LOGOUT_ROOT))
    try:
        write_private(work / ".credentials.json", data)
        if os.geteuid() == 0:
            gid = pwd.getpwuid(uid).pw_gid
            for path in (work, work / ".credentials.json"):
                os.chown(path, uid, gid)
        out = as_agent(a, [claude, "auth", "logout"], env={"CLAUDE_CONFIG_DIR": str(work)}, timeout=60)
        return "" if out.returncode == 0 else (last_line(out.stderr) or last_line(out.stdout) or f"код {out.returncode}")
    except subprocess.TimeoutExpired:
        return "claude auth logout не відповів"
    finally:
        shutil.rmtree(work, ignore_errors=True)


def sign_out(a: Agent, uid: int, folder: Path) -> tuple[str, list[str]]:
    """Once the transfer is done (never on a path that can still roll back: revoking is final), one attempt: the previous
    owner's Claude logins, taken off the agent during the change, are revoked from root's copies with the agent held and
    stopped (only the transfer's own hold exists here: it checked for any other before it began), then it starts again.
    The copies under /run go in every case; nothing is retried later. Returns "revoked" or "not-revoked" and what to tell."""
    try:
        copies = logins(folder)
    except (OSError, tarfile.TarError):
        copies, why = {}, ["копії входу не прочитано"]
    else:
        why = []
    if not copies and not why:
        return "revoked", []
    touched = False
    problems: list[str] = []
    try:
        if not why:
            hold(a)
            touched = True
            stop(a.unit)
            left = leftovers(uid)
            if left:
                why.append(f"після зупинки лишилися процеси агента ({left})")
            else:
                why += [f"{name}: {failed}" for name, data in copies.items() if (failed := revoke(a, uid, data))]
    except Exception as error:  # noqa: BLE001 — whatever stopped it, the agent comes back and the outcome is told
        why.append(str(error) if isinstance(error, Failed) else f"помилка {type(error).__name__}")
    finally:
        if touched:
            problems += release(a)
            for attempt in (1, 2):
                try:
                    start(a.unit)
                    break
                except Failed as error:
                    if attempt == 2:
                        problems.append(f"служба агента після виходу з Claude: {error}")
    if not why:
        return "revoked", problems
    return "not-revoked", [f"Вхід попереднього власника в Claude прибрано з агента, але не відкликано ({'; '.join(why)}): "
                           "попередній власник може завершити цей вхід у налаштуваннях свого claude.ai.", *problems]


def settle_owner(a: Agent, saved: dict[str, str], live: str, chosen: str) -> tuple[int, dict]:
    """Settings that disagree (a run that could not put everything back): the channel settings, the profile and the saved
    settings follow the one of their two owners Novsky's admin chose, as a transfer writes them, copies first, when
    access.json already names him an administrator. The rest (persona, helpers) follows him with the next «Оновити кит»."""
    names = {"OWNER_NAME": "", "OWNER_TG_USERNAME": ""}
    value = lambda path, name: as_agent(a, [PY, MERGE, "--value", path, name]).stdout
    if chosen == saved.get("OWNER_CHAT_ID"):
        names = {name: saved.get(name, "") for name in names}
    else:
        names["OWNER_NAME"] = value(a.state / ".env", "OWNER_NAME")
        if value(a.home / ".agent-profile.env", "OWNER_CHAT_ID") == chosen:
            names["OWNER_TG_USERNAME"] = value(a.home / ".agent-profile.env", "OWNER_TG_USERNAME")
    if not names["OWNER_NAME"]:
        refuse("Для вибраного власника на сервері немає імені: узгодити налаштування не вийшло")
    # «Оновити кит» keeps the administrators access.json has (access-update preserve-admins) and refuses an owner who is
    # not one of them: settings that follow anyone else would leave the agent stuck in its next update.
    try:
        access = json.loads(as_agent(a, ["cat", "--", a.state / "access.json"]).stdout)
        admins = [str(item) for item in access.get("admins", [])] if isinstance(access, dict) else []
    except ValueError:
        admins = []
    if chosen not in admins:
        refuse(f"У файлі доступу агента (~/.claude/channels/telegram/access.json) людини з ID {chosen} немає серед "
               "адміністраторів: з таким власником наступне «Оновити кит» не пройде. Вибери другого з двох або покажи це підтримці.")
    folder = backup_folder(a, free_stamp(a))
    folder.mkdir(mode=0o700, parents=True)
    backup(a, folder, [], {"user": a.user, "unit": a.unit, "settle": chosen, "channel": live, "saved": saved.get("OWNER_CHAT_ID", "")})
    owner = {"OWNER_CHAT_ID": chosen, "OWNER_NAME": names["OWNER_NAME"]}
    try:
        merge_agent_file(a, a.state / ".env", owner, "налаштування каналу")
        merge_agent_file(a, a.home / ".agent-profile.env", {**owner, "OWNER_TG_USERNAME": names["OWNER_TG_USERNAME"]}, "профіль агента")
        merge_root_file(a.config, {**owner, "OWNER_TG_USERNAME": names["OWNER_TG_USERNAME"]}, "збережені налаштування")
    except Failed as error:
        return 4, {"reason": f"налаштування не узгоджено ({error}); копії в {folder}", "restored": False, "backup": str(folder)}
    return 0, {"owner": {"chatId": chosen, "name": names["OWNER_NAME"], "username": names["OWNER_TG_USERNAME"]},
               "repaired": True, "backup": str(folder)}


def backup_folder(a: Agent, stamp: str) -> Path:
    return ROOT / "root/backups" / f"owner-transfer-{stamp}-{a.user}"


def free_stamp(a: Agent) -> str:
    """The run's own stamp (its copies, the previous owner's files): a second run within the same second gets a suffix."""
    base = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(float(TEST_NOW) if TEST_NOW else None))
    stamp, count = base, 1
    while os.path.lexists(backup_folder(a, stamp)):
        count += 1
        stamp = f"{base}-{count}"
    return stamp


def locked(a: Agent, uid: int, r: dict, old: str, values: dict[str, str], skills: tuple[list[str], list[str]],
           stamp: str, at: int, record: dict) -> tuple[int, dict]:
    """Everything that changes the agent, under its lifecycle lock: the agent is brought back whatever happened."""
    folder = backup_folder(a, stamp)
    created = [".claude/memory/USER.md", f".claude/memory/USER.previous-owner-{stamp}.md",
               f".novsky/client-context.previous-owner-{stamp}.md", f".novsky/onboarding.previous-owner-{stamp}.json",
               ".claude/fresh-start.flag", f"{REMINDERS}/{at}-memory-review.rem", ".agent-profile.env",
               "logs/access-grants.log", *skills[1]]
    names: list[str] = []
    problems: list[str] = []
    touched = changed = False
    for name in SIGNALS:
        signal.signal(name, interrupted)
    try:
        try:
            folder.mkdir(mode=0o700, parents=True)
            hold(a)
            suspend_cron(a, folder)
            busy = quiet(a, uid)
            if busy:
                outcome = (3, f"Агент щойно взявся до роботи ({busy}): передачу не почато. Повтори, коли він закінчить")
            else:
                touched = True  # from here the service is started again, whatever its state
                stop(a.unit)
                left = leftovers(uid)
                if left:
                    outcome = (3, f"Після зупинки служби в агента лишилися процеси ({left}): передачу не почато. Повтори, коли вони завершаться")
                else:
                    personal_ties(a, r, old)  # again with the agent stopped: what it set up meanwhile counts too
                    names = backup(a, folder, skills[0], record)
                    changed = True  # from here a failure puts the copies back
                    change(a, r, old, values, stamp, at)
                    outcome = (0, "")
        except Refused as refusal:
            for name in SIGNALS:
                signal.signal(name, signal.SIG_IGN)
            outcome = (refusal.code, refusal.reason)
        except Exception as error:  # noqa: BLE001 — whatever stopped the change, the agent comes back as it was
            for name in SIGNALS:  # the way back is not interrupted
                signal.signal(name, signal.SIG_IGN)
            outcome = (1, str(error) if isinstance(error, Failed) else f"помилка {type(error).__name__}")
            if changed:
                problems += put_back(a, folder, names, created)
        for name in SIGNALS:  # from here the agent is only brought up: nothing interrupts that
            signal.signal(name, signal.SIG_IGN)
        problems += release(a)  # before the start: the drop-in starts nothing while the hold is there
        if touched:
            try:
                start(a.unit)
            except Failed as error:
                if outcome[0] == 0:  # the change is in, the agent does not come up with it: everything goes back
                    outcome = (1, str(error))
                    try:
                        hold(a)  # held down again while its files go back
                    except Exception:  # noqa: BLE001 — the way back runs regardless
                        problems.append("утримання служби")
                    problems += put_back(a, folder, names, created)
                    problems += release(a)
                    try:
                        start(a.unit)
                    except Failed:
                        problems.append("служба")
                else:
                    problems.append("служба")
        logout, notes = "", []
        if outcome[0] == 0 and r["logout"]:
            logout, notes = sign_out(a, uid, folder)
    finally:
        if not restore_cron(a, folder):
            problems.append(f"розклад агента (копія {folder}/crontab.json)")
        for name in SIGNALS:
            signal.signal(name, signal.SIG_DFL)
    code, reason = outcome
    if code == 0:
        warnings = [f"не прибрано: {item}" for item in problems] + notes
        fields = {"owner": {"chatId": r["owner"], "name": r["name"], "username": r["username"]},
                  "previous": {"chatId": old, "role": "superadmin" if r["previous"] == "superadmin" else "removed"},
                  "backup": str(folder), "service": state_of(a.unit) or "unknown", **({"claudeLogout": logout} if logout else {})}
        return 0, {**fields, **({"warnings": warnings} if warnings else {})}
    if problems:
        return 4, {"reason": f"{reason}; не повернуто: {', '.join(problems)}. Копії в {folder}", "restored": False,
                   "backup": str(folder)}
    if code in (2, 3):
        return code, {"reason": reason}
    return 1, {"reason": f"{reason}; {'попередній стан повернуто' if changed else 'нічого не змінено'}", "restored": True,
               "backup": str(folder)}


def transfer(r: dict) -> tuple[int, dict]:
    a = Agent(r["user"])
    try:
        account = pwd.getpwnam(a.user)
    except KeyError:
        refuse("Користувача агента на цьому сервері немає")
    if account.pw_uid == 0:
        refuse("Некоректний користувач агента")
    if codex_agent(a.user):
        refuse("Агента на рушії Codex поки не можна передати іншому власнику: зараз змінюємо лише агентів Claude Code")
    merge = kit_module("merge_env", "assets/lib/merge-env.py")
    saved_settings(a, merge)
    if not os.path.lexists(a.state / ".env"):
        refuse("Це не агент Claude Code цього кита: немає налаштувань його Telegram-каналу")
    # The lock first: a run that changes the agent holds it until the agent is back, so neither the owner it reports nor
    # anything it checks is read in the middle of another run's change.
    lock = lifecycle_lock(a, account.pw_uid)
    try:
        return under_lock(a, account.pw_uid, r, saved_settings(a, merge))
    finally:
        os.close(lock)


def under_lock(a: Agent, uid: int, r: dict, saved: dict[str, str]) -> tuple[int, dict]:
    old = as_agent(a, [PY, MERGE, "--value", a.state / ".env", "OWNER_CHAT_ID"]).stdout
    if not OWNER_ID.fullmatch(old) or saved.get("OWNER_CHAT_ID") != old:
        if r.get("status") and r.get("settle") in (old, saved.get("OWNER_CHAT_ID")):
            return settle_owner(a, saved, old, r["settle"])
        refuse(f"Власник у налаштуваннях каналу агента ({old or 'немає'}) не збігається зі збереженим "
               f"({saved.get('OWNER_CHAT_ID') or 'немає'}): вибери, кого з них записати власником, або спершу онови кит")
    owner = {"chatId": old, "name": saved.get("OWNER_NAME", ""), "username": saved.get("OWNER_TG_USERNAME", "")}
    if r.get("status"):
        return 0, {"owner": owner}
    if r["owner"] == old:
        # Already this person's agent (a transfer whose answer was lost, a change made by hand): nothing changes, and the
        # owner the server has is reported so that Novsky can record him.
        return 0, {"owner": owner, "previous": None, "already": True}
    # The person the agent is made for («Для кого агент», PRINCIPAL_CHAT_ID; absent on kits before it) cannot be its owner:
    # install-core refuses an owner equal to him, and every update would stop there.
    principal = {saved.get("PRINCIPAL_CHAT_ID", ""), as_agent(a, [PY, MERGE, "--value", a.home / ".agent-profile.env", "PRINCIPAL_CHAT_ID"]).stdout}
    if r["owner"] in principal:
        refuse("Ця людина — та, для кого зроблено агента («Для кого агент»): власником вона бути не може. Щоб зробити її "
               "власником, спершу прибери її з «Для кого агент», потім повтори передачу.")
    held = [f"~/{HOLD}"] if os.path.lexists(a.home / HOLD) else []
    held += [name for name in FOREIGN_HOLDS if os.path.lexists(ROOT / "etc/systemd/system" / f"{a.unit}.d" / name)]
    if held:
        refuse(f"Перезапуски агента зараз придержано ({', '.join(held)}): триває оновлення або власник призупинив агента. "
               "Передачу не почато; повтори, коли це закінчиться", 3)
    if r["logout"]:
        keys = [name for name in ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")
                if as_agent(a, [PY, MERGE, "--value", a.state / ".env", name]).stdout]
        if keys:
            refuse(f"Claude у цього агента підключено ключем у налаштуваннях каналу ({', '.join(keys)}), а не входом: вихід із "
                   "підписки його не вимкне. Прибери ключ з ~/.claude/channels/telegram/.env агента або зніми «Новий власник "
                   "увійде у свою підписку Claude», потім повтори передачу.")
        # A key from apiKeyHelper (a Nooman agent), or settings that cannot be read: signing out would change nothing, and
        # the kit's watchdog sends no login link to an agent that runs on a key.
        access = as_agent(a, [PY, "-c", API_KEY, KIT / "assets/bin/agent_notice_locale.py", a.home]).stdout.strip()
        if access != "False":
            refuse(("Claude у цього агента працює з ключем API (apiKeyHelper у ~/.claude/settings.json), а не з підпискою: "
                    if access == "True" else "Налаштування Claude цього агента (~/.claude/settings.json) не читаються: ")
                   + "вихід із підписки нічого не змінить, а посилання для входу новому власнику не прийде. Зніми «Новий власник "
                   "увійде у свою підписку Claude» (агент лишиться на тому самому доступі до Claude), потім повтори передачу.")
    for setting, module in (("MODULE_INSTAGRAM_DM", "Instagram"), ("MODULE_YOUTUBE_COMMENTS", "YouTube")):
        if saved.get(setting) == "1":
            refuse(f"Модуль {module} шле звіти власнику зі своїх налаштувань, і передача їх не змінює: передачу не почато")
    if r["previous"] == "superadmin" and not os.path.lexists(a.state / "corporate-isolation-activated"):
        refuse("Роль суперадміністратора працює лише в корпоративному режимі агента: вимкни «Попередній власник лишається "
               "суперадміном» або спершу ввімкни корпоративний режим")
    personal_ties(a, r, old)
    values = template_values(a, saved, r)
    skills = preflight(a, values)
    if state_of(a.unit) != "active":
        refuse("Агент зараз не працює: запусти його й повтори передачу")
    stamp, at = free_stamp(a), int(time.time()) + 900
    record = {"user": a.user, "unit": a.unit, "from": old, "to": r["owner"], "previous": r["previous"], "at": stamp}
    return locked(a, uid, r, old, values, skills, stamp, at, record)


def main() -> int:
    os.umask(0o077)
    sys.dont_write_bytecode = True  # the kit folder is root's; no bytecode is left in it
    try:
        if os.geteuid() != 0 and ROOT == Path("/"):
            refuse("Передачу власника запускає root")
        code, fields = transfer(request_of(sys.stdin.read(64 * 1024)))
        return answer(code, **fields)
    except Refused as refusal:
        return answer(refusal.code, reason=refusal.reason)


if __name__ == "__main__":
    raise SystemExit(main())
