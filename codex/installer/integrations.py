#!/usr/bin/env python3
"""Owner-only stdio MCP for an installer-selected set of integration clients.

The host starts this process outside the worker's filesystem sandbox, as the
inventory's user. The root-owned inventory and the native profile's protection
of helper/dependency code are the trust boundary. This is not a guest broker,
a shell, a credential reader, or a replacement for native confirmation tools.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import pwd
import re
import selectors
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
import uuid


INVENTORY_OWNER_UID = 0
MAX_DOCUMENT_BYTES = 262144
MAX_ARGUMENT_BYTES = 65536
MAX_OUTPUT_BYTES = 1048576
MAX_TIMEOUT_SECONDS = 900
MEDIA_SUFFIXES = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v", ".mp3", ".wav", ".m4a", ".ogg", ".flac", ".png", ".jpg", ".jpeg", ".webp", ".gif"}
ACTORS = (
    "apify/facebook-posts-scraper", "apify/instagram-api-scraper",
    "apify/instagram-profile-scraper", "apify/instagram-scraper",
    "clockworks/tiktok-profile-scraper", "harvestapi/linkedin-post-search",
    "streamers/youtube-scraper",
)


class Denied(ValueError):
    """A static, credential-free explanation suitable for the MCP client."""


@dataclass(frozen=True)
class Command:
    positions: tuple[str, ...] = ()
    flags: dict[str, str | None] | None = None
    required: tuple[str, ...] = ()
    optional_positions: int = 0
    repeat: tuple[str, ...] = ()
    output: str | None = None


EXPORT = {"--limit": "int:1:500", "--output": "output"}
CONFIRM = {"--confirm": "confirmation"}
GOOGLE_FLAGS = {"--account": "email", "--json": None, "--readonly": None, "--no-input": None}
GOOGLE_WRITES = frozenset({('sheets', 'update'), ('sheets', 'append'), ('sheets', 'create'), ('sheets', 'clear'),
    ('docs', 'create'), ('docs', 'update'), ('calendar', 'create'), ('calendar', 'update'),
    ('tasks', 'add'), ('tasks', 'update'), ('gmail', 'send'), ('drive', 'upload')})


def commands() -> dict[str, dict[tuple[str, ...], Command]]:
    """These are reviewed CLI grammars, not flags supplied by the inventory."""
    result = {
        "apify-social": {
            ("actors",): Command(), ("doctor",): Command(),
            ("run",): Command(("enum:" + ",".join(ACTORS),), {
                "--input": "json-input", "--output": "output", "--max-items": "int:1:1000",
                "--max-charge-usd": "float:0.01:5", "--timeout": "int:10:300", "--confirm-cost": None,
            }, ("--input", "--confirm-cost"), output="--output"),
        },
        "asana-tasks": {
            ("doctor",): Command(),
            ("workspaces",): Command(flags={"--limit": "int:1:100"}),
            ("projects",): Command(flags={"--workspace": "number-id", "--limit": "int:1:100"}, required=("--workspace",)),
            ("tasks",): Command(flags={"--project": "number-id", "--limit": "int:1:100"}, required=("--project",)),
            ("task",): Command(("number-id",)),
            ("authorize-project",): Command(flags={"--workspace": "number-id", "--project": "number-id", **CONFIRM}, required=("--workspace", "--project")),
            ("create",): Command(flags={"--workspace": "number-id", "--project": "number-id", "--name": "text", "--notes": "text", "--due-on": "text", "--assignee": "number-id", **CONFIRM}, required=("--workspace", "--project", "--name")),
            ("update",): Command(("number-id",), {"--name": "text", "--notes": "text", "--due-on": "text", "--complete": None, "--reopen": None, **CONFIRM}),
        },
        "hubspot-crm": {
            ("doctor",): Command(),
            **{(name,): Command(flags=EXPORT, output="--output") for name in ("contacts", "companies", "deals", "tickets", "tasks", "notes")},
            ("activities",): Command(flags={**EXPORT, "--kind": "enum:calls,emails,meetings"}, required=("--kind",), output="--output"),
            ("create-note",): Command(flags={"--body": "text", "--timestamp": "text", "--associate-type": "enum:contacts,companies,deals,tickets", "--associate-id": "number-id", **CONFIRM}, required=("--body", "--timestamp", "--associate-type", "--associate-id")),
            ("create-record",): Command(("enum:contacts,companies,deals,tickets",), {"--properties": "json-data", **CONFIRM}, ("--properties",)),
            ("update-record",): Command(("enum:contacts,companies,deals,tickets", "number-id"), {"--properties": "json-data", **CONFIRM}, ("--properties",)),
            ("update-deal",): Command(("number-id",), {"--stage": "text", "--owner": "number-id", **CONFIRM}),
        },
        "meta-ads": {
            ("doctor",): Command(),
            **{(name,): Command(flags=EXPORT, output="--output") for name in ("accounts", "campaigns", "adsets", "ads", "creatives")},
            ("insights",): Command(flags={**EXPORT, "--since": "text", "--until": "text", "--level": "enum:account,campaign,adset,ad", "--time-increment": "enum:1,7,28"}, required=("--since", "--until"), output="--output"),
            ("set-status",): Command(("enum:campaign,adset,ad", "number-id"), {"--status": "enum:ACTIVE,PAUSED", **CONFIRM}, ("--status",)),
            ("set-budget",): Command(("enum:campaign,adset", "number-id"), {"--daily-budget-minor": "int:1:1000000000", **CONFIRM}, ("--daily-budget-minor",)),
            ("create-campaign",): Command(flags={"--name": "text", "--objective": "text", "--special-ad-category": "text", "--status": "enum:PAUSED", **CONFIRM}, required=("--name", "--objective"), repeat=("--special-ad-category",)),
            ("create-adset",): Command(flags={"--name": "text", "--campaign-id": "number-id", "--optimization-goal": "text", "--billing-event": "text", "--daily-budget-minor": "int:1:1000000000", "--targeting-json": "json-data", "--status": "enum:PAUSED", **CONFIRM}, required=("--name", "--campaign-id", "--optimization-goal", "--billing-event", "--daily-budget-minor", "--targeting-json")),
            ("create-creative",): Command(flags={"--name": "text", "--object-story-spec-json": "json-data", **CONFIRM}, required=("--name", "--object-story-spec-json")),
            ("create-ad",): Command(flags={"--name": "text", "--adset-id": "number-id", "--creative-id": "number-id", "--status": "enum:PAUSED", **CONFIRM}, required=("--name", "--adset-id", "--creative-id")),
        },
        "sql-readonly": {
            ("doctor",): Command(flags={"--project": "id"}),
            ("sqlite",): Command(flags={"--database": "database-input", "--query-file": "sql-input", "--max-rows": "int:1:10000", "--timeout": "int:1:120", "--output": "output"}, required=("--database", "--query-file"), output="--output"),
            ("bigquery",): Command(flags={"--query-file": "sql-input", "--max-rows": "int:1:10000", "--timeout": "int:1:600", "--output": "output", "--project": "id", "--maximum-bytes-billed": "int:1:100000000000"}, required=("--query-file", "--maximum-bytes-billed"), output="--output"),
        },
        "sec-edgar": {
            ("doctor",): Command(),
            **{(name,): Command(("number-id",), {"--output": "output"}, output="--output") for name in ("company", "facts")},
            ("filings",): Command(("number-id",), {"--forms": "text", "--limit": "int:1:200", "--output": "output"}, output="--output"),
            ("concept",): Command(("number-id", "id", "id"), {"--output": "output"}, output="--output"),
        },
        "findata": {(): Command(("ticker", "enum:info,income,balance,cashflow,prices,all"), optional_positions=1)},
        "cal-event-time": {(): Command(("timestamp",))},
        "growth-analytics-doctor": {(): Command(flags={"--account": "email"})},
        "media-dl": {(): Command(("url", "int:144:2160"), {"--max-height": "int:144:2160", "--max-filesize": "file-size", "--max-duration": "int:1:7200", "--output-dir": "output", "--start": "media-time", "--end": "media-time", "--subtitle-langs": "languages"}, optional_positions=1, output="--output-dir")},
        "yt-dl": {(): Command(("youtube-url", "int:144:2160"), optional_positions=1)},
        "threads-dl": {(): Command(("threads-url", "output-file"), optional_positions=1)},
        "scene-split": {(): Command(("media-input", "output", "float:0:1"), {"--threshold": "float:0:1", "--max-frames": "int:1:100", "--start": "media-time", "--end": "media-time", "--max-duration": "float:0.01:7200"}, optional_positions=1)},
        "video-ingest": {(): Command(("media-source",), {"--output": "output", "--start": "media-time", "--end": "media-time", "--max-frames": "int:1:100", "--max-bytes": "int:1:524288000", "--max-duration": "float:0.01:7200", "--transcribe": "enum:never", "--languages": "languages"}, output="--output")},
        "video-edit": {("validate",): Command(("edl-input",)), ("render",): Command(("edl-input",)), ("doctor",): Command()},
    }
    google = {
        ('sheets', 'update'): Command(('id', 'text'), {'--values-json': 'json-matrix', '--input': 'enum:RAW,USER_ENTERED'}, ('--values-json',)),
        ('sheets', 'append'): Command(('id', 'text'), {'--values-json': 'json-matrix', '--input': 'enum:RAW,USER_ENTERED', '--insert': 'enum:INSERT_ROWS,OVERWRITE'}, ('--values-json',)),
        ('sheets', 'create'): Command(('text',), {'--parent': 'id'}),
        ('sheets', 'clear'): Command(('id', 'text')),
        ('docs', 'create'): Command(('text',), {'--parent': 'id'}),
        ('docs', 'update'): Command(('id',), {'--text': 'text', '--index': 'int:1:10000000', '--replace-range': 'text', '--at': 'text', '--occurrence': 'int:1:10000', '--match-case': None, '--markdown': None}, ('--text',)),
        ('calendar', 'create'): Command(('id',), {'--summary': 'text', '--from': 'timestamp', '--to': 'timestamp', '--description': 'text', '--location': 'text', '--attendees': 'emails', '--send-updates': 'enum:all,externalOnly,none', '--with-meet': None}, ('--summary', '--from', '--to')),
        ('calendar', 'update'): Command(('id', 'id'), {'--summary': 'text', '--from': 'timestamp', '--to': 'timestamp', '--description': 'text', '--location': 'text', '--attendees': 'emails'}),
        ('tasks', 'add'): Command(('id',), {'--title': 'text', '--notes': 'text', '--due': 'text', '--parent': 'id'}, ('--title',)),
        ('tasks', 'update'): Command(('id', 'id'), {'--title': 'text', '--notes': 'text', '--due': 'text', '--status': 'enum:needsAction,completed'}),
        ('gmail', 'send'): Command(flags={'--to': 'emails', '--cc': 'emails', '--bcc': 'emails', '--subject': 'text', '--body': 'text', '--reply-to-message-id': 'id'}, required=('--to', '--subject', '--body')),
        ('drive', 'upload'): Command(('document-input',), {'--name': 'text', '--parent': 'id', '--convert-to': 'enum:doc,sheet,slides'}),
        ("gmail", "search"): Command(("text",), {"--max": "int:1:100", "--page": "text"}),
        ("gmail", "get"): Command(("id",), {"--format": "enum:full,metadata,minimal,raw", "--headers": "text"}),
        ("calendar", "events"): Command(("id",), {"--from": "text", "--to": "text", "--today": None, "--tomorrow": None, "--week": None, "--max": "int:1:100"}, optional_positions=1),
        ("calendar", "event"): Command(("id", "id")),
        ("calendar", "calendars"): Command(),
        ("drive", "ls"): Command(flags={"--max": "int:1:100", "--parent": "id", "--query": "text", "--page": "text"}),
        ("drive", "search"): Command(("text",), {"--max": "int:1:100", "--page": "text"}),
        ("drive", "get"): Command(("id",)),
        ("docs", "cat"): Command(("id",), {"--max-bytes": "int:1:1048576"}),
        ("sheets", "get"): Command(("id", "text")),
        ("sheets", "metadata"): Command(("id",)),
        ("sheets", "read-format"): Command(("id", "text"), {"--effective": None}),
        ("slides", "list-slides"): Command(("id",)),
        ("slides", "read-slide"): Command(("id", "id")),
        ("contacts", "search"): Command(("text",), {"--max": "int:1:100"}),
        ("contacts", "get"): Command(("id",)),
        ("tasks", "lists"): Command(flags={"--max": "int:1:100"}),
        ("tasks", "list"): Command(("id",), {"--max": "int:1:100", "--page": "text"}),
        ("tasks", "get"): Command(("id", "id")),
        ("analytics", "accounts"): Command(),
        ("analytics", "report"): Command(("id",), {"--from": "text", "--to": "text", "--start-date": "text", "--end-date": "text", "--dimensions": "text", "--metrics": "text", "--limit": "int:1:1000"}, ("--metrics",)),
        ("searchconsole", "sites", "list"): Command(),
        ("searchconsole", "query"): Command(("text",), {"--start": "text", "--end": "text", "--start-date": "text", "--end-date": "text", "--dimensions": "text", "--limit": "int:1:1000"}),
    }
    result["gog"] = {key: Command(spec.positions, {**GOOGLE_FLAGS, **(spec.flags or {})}, spec.required, spec.optional_positions) for key, spec in google.items()}
    return result


COMMANDS = commands()
SUPPORTED_PROGRAMS = frozenset(COMMANDS)


def strict_json(raw: str):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("nonfinite JSON")))


def absolute_path(raw: object) -> Path:
    if not isinstance(raw, str) or not raw or "\x00" in raw:
        raise Denied("An absolute managed path is required.")
    path = Path(raw)
    if not path.is_absolute() or ".." in path.parts or path != path.resolve():
        raise Denied("Symlinks and paths outside the managed location are unavailable.")
    return path


@dataclass(frozen=True)
class Inventory:
    home: Path
    workspace: Path
    programs: dict[str, dict[str, str]]
    timeout_seconds: float = 360
    output_bytes: int = 262144

    @classmethod
    def load(cls, path: Path) -> "Inventory":
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != INVENTORY_OWNER_UID or metadata.st_mode & 0o022:
                    raise Denied("Tool inventory must be a root-owned regular file without group or other write access.")
                raw = stream.read(MAX_DOCUMENT_BYTES + 1)
            if len(raw) > MAX_DOCUMENT_BYTES:
                raise Denied("Tool inventory exceeds its size limit.")
            document = strict_json(raw.decode("utf-8"))
            required = {"schema_version", "owner", "home", "workspace", "programs"}
            if not isinstance(document, dict) or not required <= document.keys() or document.keys() - required - {"limits"} or type(document["schema_version"]) is not int or document["schema_version"] != 1:
                raise Denied("Unsupported tool inventory schema.")
            if document["owner"] != pwd.getpwuid(os.geteuid()).pw_name:
                raise Denied("The integration process must run as the installed owner.")
            home = absolute_path(document["home"])
            workspace = absolute_path(document["workspace"])
            if home == workspace or not workspace.is_relative_to(home) or any(not p.is_dir() or p.stat().st_uid != os.geteuid() for p in (home, workspace)):
                raise Denied("The inventory must select the owner's existing home and workspace.")
            programs = document["programs"]
            if not isinstance(programs, dict) or not programs.keys() <= SUPPORTED_PROGRAMS:
                raise Denied("Inventory contains an unsupported integration program.")
            for name, entry in programs.items():
                if not isinstance(entry, dict) or set(entry) != {"path", "sha256"} or entry["path"] != str(home / "bin" / name) or not isinstance(entry["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]):
                    raise Denied("Inventory entries require the managed helper path and SHA256.")
            limits = document.get("limits", {})
            if not isinstance(limits, dict) or limits.keys() - {"timeout_seconds", "output_bytes"}:
                raise Denied("Unsupported integration limits.")
            timeout = limits.get("timeout_seconds", 360)
            output = limits.get("output_bytes", 262144)
            if type(timeout) not in (float, int) or not math.isfinite(timeout) or not 0.1 <= timeout <= MAX_TIMEOUT_SECONDS or type(output) is not int or not 1024 <= output <= MAX_OUTPUT_BYTES:
                raise Denied("Integration limits exceed the host maximum.")
            return cls(home, workspace, programs, float(timeout), output)
        except (OSError, ValueError, TypeError, KeyError) as error:
            if isinstance(error, Denied):
                raise
            raise Denied("Cannot read a valid trusted tool inventory.") from None

    def verify(self, program: str) -> Path:
        if program not in self.programs:
            raise Denied("This integration program is not installed for this product.")
        path = absolute_path(self.programs[program]["path"])
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022 or not metadata.st_mode & 0o111 or metadata.st_uid not in {0, os.geteuid()} or metadata.st_size > 4194304:
                    raise Denied("The installed helper is not a trusted executable file.")
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
                after = os.fstat(stream.fileno())
            current = path.stat()
            if (metadata.st_dev, metadata.st_ino, metadata.st_size, metadata.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or (after.st_dev, after.st_ino) != (current.st_dev, current.st_ino) or digest != self.programs[program]["sha256"]:
                raise Denied("The installed helper differs from its pinned SHA256; reinstall it before use.")
        except OSError:
            raise Denied("The pinned integration helper is unavailable.") from None
        return path


class Redactor:
    """Read only fixed credential locations, internally, to suppress their values."""
    secret_key = re.compile(r"token|password|secret|api.?key|private.?key|credential|authorization", re.I)
    patterns = (
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b",
        r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|apify_api_[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b",
        r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b",
        r"(?i)\bBearer\s+[A-Za-z0-9_./+=-]{8,}",
    )
    field_pattern = r'''(?i)(?<![A-Za-z])(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|client[_-]?secret|authorization|token)["']?\s*[:=]\s*)(["']?)[^\s,"'}]{8,}'''

    def __init__(self, home: Path):
        self.values: set[str] = set()
        env_file = home / ".codex/channels/telegram/.env"
        for line in self.read(env_file).splitlines():
            match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line)
            if match and self.secret_key.search(match[1]):
                try:
                    words = shlex.split(match[2], comments=True)
                    if len(words) == 1:
                        self.add(words[0])
                except ValueError:
                    self.add(match[2].strip().strip("\"'"))
        for name in ("apify-token", "asana-token", "hubspot-token", "vercel-token"):
            self.add(self.read(home / ".config" / name).strip())
        for name in ("meta-ads.json", "gogcli/credentials.json", "gog/credentials.json", "gcloud/application_default_credentials.json"):
            raw = self.read(home / ".config" / name)
            if raw:
                try:
                    self.json_values(strict_json(raw))
                except (ValueError, TypeError, RecursionError):
                    # Do not return helper output if a configured secret store
                    # cannot be parsed; it could otherwise escape redaction.
                    raise Denied("A configured credential file needs repair before integrations can run.") from None

    @staticmethod
    def read(path: Path) -> str:
        try:
            with path.open("rb") as stream:
                raw = stream.read(MAX_DOCUMENT_BYTES + 1)
            if len(raw) > MAX_DOCUMENT_BYTES:
                raise Denied("A credential file exceeds the supported size limit.")
            return raw.decode("utf-8")
        except FileNotFoundError:
            return ""
        except (OSError, UnicodeError):
            raise Denied("A configured credential file is not readable by its owner.") from None

    def add(self, value):
        if isinstance(value, str) and len(value) >= 4:
            self.values.add(value)

    def json_values(self, value):
        if isinstance(value, dict):
            for key, item in value.items():
                if self.secret_key.search(key):
                    self.add(item)
                self.json_values(item)
        elif isinstance(value, list):
            for item in value:
                self.json_values(item)

    def clean(self, text: str) -> str:
        for value in sorted(self.values, key=len, reverse=True):
            text = text.replace(value, "[REDACTED]")
            # JSON-escaped credentials can appear in structured helper errors.
            text = text.replace(json.dumps(value)[1:-1], "[REDACTED]")
        for pattern in self.patterns:
            text = re.sub(pattern, "[REDACTED]", text)
        text = re.sub(self.field_pattern, lambda match: match[1] + match[2] + "[REDACTED]", text)
        return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)


class Bridge:
    def __init__(self, inventory: Inventory):
        self.inventory = inventory
        self.output_paths: set[Path] = set()
        self.stage: Path | None = None
        self.path_map: dict[Path, Path] = {}
        self.output_map: dict[Path, Path] = {}

    @staticmethod
    def open_directory(path: Path, create=False) -> int:
        """Pin every ancestor; no follow-up path resolution after admission."""
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in path.parts[1:]:
                if create:
                    try: os.mkdir(part, 0o700, dir_fd=descriptor)
                    except FileExistsError: pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                os.close(descriptor); descriptor = child
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def snapshot(self, path: Path, maximum: int) -> Path:
        if path in self.path_map:
            return self.path_map[path]
        parent = self.open_directory(path.parent)
        try:
            descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
        with os.fdopen(descriptor, "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_uid != os.geteuid() or before.st_size > maximum:
                raise Denied("Integration input must be a bounded regular data file without links.")
            target = self.stage / (uuid.uuid4().hex + path.suffix)
            remaining = maximum
            with target.open("xb") as output:
                while chunk := source.read(min(65536, remaining + 1)):
                    remaining -= len(chunk)
                    if remaining < 0: raise Denied("Integration input exceeds its size limit.")
                    output.write(chunk)
            after = os.fstat(source.fileno())
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise Denied("Integration input changed while it was being copied; retry with a stable file.")
        self.path_map[path] = target
        return target

    def publish(self) -> None:
        """Publish new artifacts through pinned directory handles, never overwrite."""
        def metadata_paths(value, field=""):
            if isinstance(value, dict): return {key: metadata_paths(item, key) for key, item in value.items()}
            if isinstance(value, list): return [metadata_paths(item, field) for item in value]
            if isinstance(value, str) and field in {"path", "source", "video", "output", "src"}:
                for original, staged in {**self.path_map, **self.output_map}.items():
                    if value == str(staged) or value.startswith(str(staged) + "/"):
                        return str(original) + value[len(str(staged)):]
            return value
        def copy_file(source: Path, parent: int, name: str):
            with source.open("rb") as incoming:
                info = os.fstat(incoming.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise Denied("Integration returned an unsupported artifact link.")
                descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                with os.fdopen(descriptor, "wb") as output:
                    # Only known helper metadata is projected. Query rows and
                    # other user data must retain their exact original values.
                    if name in {"report.json", "manifest.json", "scenes.json"} and info.st_size <= 8 * 1024 * 1024:
                        raw = incoming.read()
                        try: raw = (json.dumps(metadata_paths(strict_json(raw.decode("utf-8"))), ensure_ascii=False, indent=2) + "\n").encode()
                        except (ValueError, UnicodeError, RecursionError): pass
                        output.write(raw)
                    else:
                        while chunk := incoming.read(65536): output.write(chunk)
        def copy_tree(source: Path, parent: int, name: str):
            if source.is_symlink(): raise Denied("Integration returned an artifact link.")
            if source.is_dir():
                os.mkdir(name, 0o700, dir_fd=parent)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                try:
                    for item in sorted(source.iterdir()): copy_tree(item, child, item.name)
                finally: os.close(child)
            else: copy_file(source, parent, name)
        for target, staged in self.output_map.items():
            if not staged.exists(): continue
            parent = self.open_directory(target.parent, create=True)
            try: copy_tree(staged, parent, target.name)
            finally: os.close(parent)

    def data_path(self, raw: str, kind: str) -> str:
        path = Path(raw)
        if raw.startswith("~/"):
            path = self.inventory.home / raw[2:]
        elif not path.is_absolute():
            path = self.inventory.workspace / path
        path = absolute_path(str(path))
        if kind.startswith("output"):
            roots = (self.inventory.workspace / "outbox",)
        else:
            roots = (self.inventory.workspace, self.inventory.home / ".codex/channels/telegram/inbox")
        root = next((root for root in roots if path != root and path.is_relative_to(root)), None)
        if root is None or any(part.startswith(".") for part in path.relative_to(root).parts):
            raise Denied("Integration inputs must be workspace/inbox data; outputs must be under workspace/outbox.")
        if kind.startswith("output"):
            if kind == "output-file" and path.suffix.lower() != ".mp4":
                raise Denied("The media output must be an MP4 under outbox.")
            if path.exists():
                raise Denied("Use a new output path; overwriting existing files is unavailable.")
            self.output_paths.add(path)
            if self.stage is not None:
                if path not in self.output_map:
                    self.output_map[path] = self.stage / (uuid.uuid4().hex + path.suffix)
                return str(self.output_map[path])
        else:
            suffixes = {"json-input": {".json"}, "edl-input": {".json"}, "sql-input": {".sql"}, "database-input": {".sqlite", ".sqlite3", ".db"}, "media-input": MEDIA_SUFFIXES,
                        'document-input': MEDIA_SUFFIXES | {'.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.tsv', '.md', '.txt', '.html'}}
            if not path.is_file() or path.suffix.lower() not in suffixes[kind] or path.stat().st_uid != os.geteuid():
                raise Denied("The input must be an owner-owned regular data file of the expected type.")
            if kind in {"json-input", "edl-input", "sql-input"} and path.stat().st_size > MAX_DOCUMENT_BYTES:
                raise Denied("The integration input exceeds its size limit.")
            if self.stage is not None:
                path = self.snapshot(path, MAX_DOCUMENT_BYTES if kind in {"json-input", "edl-input", "sql-input"} else 524288000)
        if kind == "edl-input":
            try:
                edl = strict_json(path.read_text(encoding="utf-8"))
                if not isinstance(edl, dict) or not isinstance(edl.get("clips"), list) or not isinstance(edl.get("overlays", []), list):
                    raise Denied("Video EDL clips and overlays must be arrays of objects.")
                edl["output"] = self.data_path(edl["output"], "output-file")
                for clip in edl["clips"]:
                    if not isinstance(clip, dict):
                        raise Denied("Video EDL clips must be objects.")
                    clip["src"] = self.data_path(clip["src"], "media-input")
                for overlay in edl.get("overlays", []):
                    if not isinstance(overlay, dict):
                        raise Denied("Video EDL overlays must be objects.")
                    if overlay.get("type") == "media":
                        overlay["src"] = self.data_path(overlay["src"], "media-input")
                if edl.get("music"):
                    edl["music"]["src"] = self.data_path(edl["music"]["src"], "media-input")
                if self.stage is not None: path.write_text(json.dumps(edl), encoding="utf-8")
            except (OSError, ValueError, TypeError, KeyError, RecursionError) as error:
                if isinstance(error, Denied):
                    raise
                raise Denied("Video editing requires a data-only EDL with allowed inputs and output.") from None
        return str(path)

    def value(self, raw: str, kind: str) -> str:
        if not raw or raw.startswith("-") or any(ord(c) < 32 and c not in "\n\t" for c in raw):
            raise Denied("Empty, option-like or control-character argument values are unavailable.")
        if kind.endswith("-input") or kind.startswith("output"):
            return self.data_path(raw, kind)
        if kind == "media-source":
            return self.value(raw, "url") if raw.startswith(("https://", "http://")) else self.data_path(raw, "media-input")
        if kind.startswith(("int:", "float:")):
            number_type, minimum, maximum = kind.split(":")
            try:
                value = int(raw) if number_type == "int" else float(raw)
                valid = math.isfinite(value) and float(minimum) <= value <= float(maximum)
            except ValueError:
                valid = False
        elif kind.startswith("enum:"):
            valid = raw in kind[5:].split(",")
        elif kind in {"url", "youtube-url", "threads-url"}:
            url = urlsplit(raw)
            host = (url.hostname or "").lower()
            valid = url.scheme in {"http", "https"} and bool(host) and url.username is None and url.password is None and not re.search(r"[\s\\]", raw)
            if kind == "youtube-url":
                valid = valid and host in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
            elif kind == "threads-url":
                valid = valid and host in {"threads.com", "www.threads.com", "threads.net", "www.threads.net"}
        elif kind == "json-data":
            try:
                valid = isinstance(strict_json(raw), dict)
            except (ValueError, RecursionError):
                valid = False
        elif kind == 'json-matrix':
            try:
                matrix = strict_json(raw)
                valid = isinstance(matrix, list) and 0 < len(matrix) <= 1000 and all(isinstance(row, list) and len(row) <= 1000 and all(cell is None or isinstance(cell, (str, int, float, bool)) for cell in row) for row in matrix)
            except (ValueError, RecursionError): valid = False
        elif kind == 'emails':
            try:
                addresses = raw.split(',')
                valid = 0 < len(addresses) <= 50 and all(self.value(address.strip(), 'email') for address in addresses)
            except Denied: valid = False
        elif kind == "timestamp":
            try:
                valid = "T" in raw and datetime.fromisoformat(raw.replace("Z", "+00:00")).tzinfo is not None
            except ValueError:
                valid = False
        else:
            patterns = {
                "number-id": r"\d{1,40}", "id": r"[A-Za-z0-9_@.+:/=-]{1,512}",
                "email": r"[^\s@<>,'\"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}",
                "confirmation": r"[a-f0-9]{32}\.[a-f0-9]{64}",
                "ticker": r"[A-Za-z0-9^][A-Za-z0-9.^=-]{0,29}",
                "languages": r"[A-Za-z*.,_-]{1,100}",
                "media-time": r"\d{1,5}(?::\d{1,2}){0,2}(?:\.\d{1,6})?",
                "file-size": r"(?:[1-9]\d{0,7}|[1-9]\d{0,2}[KkMm])", "text": r"[\s\S]{1,16384}",
            }
            valid = bool(re.fullmatch(patterns[kind], raw))
            if kind == "file-size" and valid:
                unit = raw[-1].upper()
                size = int(raw[:-1]) * (1024 if unit == "K" else 1048576) if unit in {"K", "M"} else int(raw)
                valid = size <= 524288000
        if not valid:
            raise Denied("An integration argument is outside the supported values or resource limits.")
        return raw

    def prepare(self, program: str, args: list[str]) -> tuple[list[str], bool]:
        grammar = COMMANDS[program]
        # Help is generated from this narrower grammar: legacy helpers such as
        # findata interpret --help as a ticker and would otherwise make a call.
        if args in (["--help"], ["-h"]):
            return args, True
        if args and args[-1] in {"--help", "-h"} and tuple(args[:-1]) in grammar:
            return args, True
        key = next((key for key in sorted(grammar, key=len, reverse=True) if tuple(args[:len(key)]) == key), None)
        if key is None:
            raise Denied("This integration operation is unavailable; use --help for the supported commands.")
        spec = grammar[key]
        flags = spec.flags or {}
        normalized = list(key)
        seen = set()
        position = 0
        upload_name = None
        index = len(key)
        while index < len(args):
            argument = args[index]
            if argument.startswith("-"):
                flag, equal, inline = argument.partition("=")
                if flag not in flags or (flag in seen and flag not in spec.repeat):
                    raise Denied("Unsupported or repeated integration flag.")
                kind = flags[flag]
                seen.add(flag)
                normalized.append(flag)
                if kind is None:
                    if equal:
                        raise Denied("Boolean integration guards cannot be overridden.")
                else:
                    if not equal:
                        index += 1
                        if index >= len(args):
                            raise Denied("Missing integration flag value.")
                        inline = args[index]
                    normalized.append(self.value(inline, kind))
            else:
                if position >= len(spec.positions):
                    raise Denied("Unexpected positional integration argument.")
                if program == 'gog' and key == ('drive', 'upload') and position == 0:
                    upload_name = self.value(Path(argument).name, 'text')
                normalized.append(self.value(argument, spec.positions[position]))
                position += 1
            index += 1
        if position < len(spec.positions) - spec.optional_positions or not set(spec.required) <= seen:
            raise Denied("Required integration arguments or explicit cost confirmation are missing.")
        if program == "gog":
            normalized = [f"--enable-commands-exact={'.'.join(key)}", *normalized]
            for flag in (("--no-input", "--json") if key in GOOGLE_WRITES else ("--readonly", "--no-input", "--json")):
                if flag not in seen:
                    normalized.insert(0, flag)
            if key in {('sheets', 'append'), ('sheets', 'update')} and '--input' not in seen:
                normalized.extend(['--input', 'RAW'])
            if key == ('drive', 'upload') and '--name' not in seen:
                normalized.extend(['--name', upload_name])
        if program == "video-ingest":
            self.inventory.verify("scene-split")
            if normalized[0].startswith(("http://", "https://")):
                self.inventory.verify("media-dl")
            if "--transcribe" not in seen:
                normalized.extend(["--transcribe", "never"])
        if program == "growth-analytics-doctor":
            self.inventory.verify("gog")
        if spec.output and spec.output not in seen:
            output = self.inventory.workspace / "outbox/integrations" / f"{program}-{uuid.uuid4().hex}"
            normalized += [spec.output, self.data_path(str(output), "output")]
        if program == "threads-dl" and position == 1:
            output = self.inventory.workspace / "outbox/integrations" / f"threads-{uuid.uuid4().hex}.mp4"
            normalized.append(self.data_path(str(output), "output-file"))
        return normalized, False

    @staticmethod
    def help(program: str) -> str:
        lines = [f"{program}: installed CLI grammar (availability does not prove account connection)."]
        for key, spec in COMMANDS[program].items():
            positions = " ".join("TICKER" if item == "ticker" else f"<{item}>" for item in spec.positions)
            flags = " ".join(flag + (" <value>" if kind is not None else "") for flag, kind in (spec.flags or {}).items())
            lines.append(" ".join(part for part in (program, " ".join(key), positions, flags) if part))
        return "\n".join(lines) + "\n"

    def tools(self):
        if not self.inventory.programs:
            return []
        return [{
            "name": "integration_run",
            "description": "Run one installed integration helper using a bounded argument vector. Start with [--help] for supported commands. Google reads are read-only; supported writes require the native owner's tool approval. Existing Asana/HubSpot/Meta previews and confirmation receipts remain required. An error or truncated result is not a receipt; never replay an uncertain write automatically. Inputs belong in the owner workspace or Telegram inbox; outputs use workspace/outbox. No shell, auth/config, memory or arbitrary code commands.",
            "inputSchema": {"type": "object", "additionalProperties": False, "required": ["program", "args"], "properties": {
                "program": {"type": "string", "enum": sorted(self.inventory.programs)},
                "args": {"type": "array", "maxItems": 64, "items": {"type": "string", "maxLength": 16384}},
            }},
            "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": False, "openWorldHint": True},
        }]

    def call(self, arguments) -> dict:
        # The native permission profile denies this host state tree to command
        # tools. Helpers receive stable snapshots here, never mutable workspace
        # paths while running outside the command sandbox.
        state = self.inventory.home / ".local/state/novsky-codex/integrations"
        try:
            descriptor = self.open_directory(state, create=True)
            os.close(descriptor)
            with tempfile.TemporaryDirectory(prefix="job-", dir=state) as temporary:
                self.stage = Path(temporary)
                self.path_map, self.output_map = {}, {}
                return self.call_staged(arguments)
        except (OSError, ValueError):
            return {"content": [{"type": "text", "text": json.dumps({"status": "denied", "exitCode": None, "stdout": "", "stderr": "Protected integration workspace is unavailable.", "outputTruncated": False})}], "isError": True}
        finally:
            self.stage = None

    def call_staged(self, arguments) -> dict:
        payload = {"status": "denied", "exitCode": None, "stdout": "", "stderr": "", "outputTruncated": False}
        self.output_paths = set()
        try:
            if not isinstance(arguments, dict) or set(arguments) != {"program", "args"}:
                raise Denied("Only program and args are accepted; identity and environment are fixed by the installer.")
            program, args = arguments["program"], arguments["args"]
            if not isinstance(program, str) or program not in SUPPORTED_PROGRAMS or program not in self.inventory.programs:
                raise Denied("This integration program is not installed for this product.")
            if not isinstance(args, list) or len(args) > 64 or any(not isinstance(item, str) or len(item) > 16384 or "\x00" in item for item in args) or sum(len(item.encode("utf-8")) for item in args) > MAX_ARGUMENT_BYTES:
                raise Denied("Integration args must be a bounded string array.")
            argv, help_only = self.prepare(program, args)
            executable = self.inventory.verify(program)
            if help_only:
                payload.update(status="help", exitCode=0, stdout=self.help(program))
            else:
                redactor = Redactor(self.inventory.home)
                result = self.run([str(executable), *argv])
                if result["status"] == "completed": self.publish()
                for original, staged in {**self.path_map, **self.output_map}.items():
                    for stream in ("stdout", "stderr"):
                        result[stream] = result[stream].replace(str(staged), str(original))
                result["stdout"] = redactor.clean(result["stdout"])
                result["stderr"] = redactor.clean(result["stderr"])
                if sum(len(result[name].encode("utf-8")) for name in ("stdout", "stderr")) > self.inventory.output_bytes:
                    result.update(status="output_limit", stdout="", stderr="Sanitized output exceeds the limit; no complete receipt is available.", outputTruncated=True)
                payload.update(result)
        except Denied as error:
            payload["stderr"] = str(error)
        except (OSError, ValueError, TypeError, KeyError, OverflowError, RecursionError):
            # Exception details can contain user input or credential paths.
            payload["stderr"] = "Integration failed safely before a verified result was available."
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}], "isError": payload["status"] not in {"completed", "help"}}

    def run(self, argv: list[str]) -> dict:
        home = self.inventory.home
        env = {"HOME": str(home), "CODEX_HOME": str(home / ".codex"), "NOVSKY_WORKSPACE": str(self.inventory.workspace), "PATH": f"{home}/.local/lib/novsky-node/bin:{home}/.local/lib/novsky-runtime/node_modules/.bin:{home}/.local/bin:{home}/.npm-global/bin:{home}/bin:/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC"}
        chunks = {"stdout": bytearray(), "stderr": bytearray()}
        size = 0
        status = "completed"
        # Some clients invoke Python with stdin, which implicitly imports from
        # cwd even when PATH is fixed. Never let workspace files become host code.
        # All admitted data paths are already absolute; these clients use HOME
        # for their private configuration and do not need a writable cwd.
        process = subprocess.Popen(argv, cwd="/", env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, close_fds=True)
        try:
            deadline = time.monotonic() + self.inventory.timeout_seconds
            with selectors.DefaultSelector() as selector:
                for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
                    os.set_blocking(stream.fileno(), False)
                    selector.register(stream, selectors.EVENT_READ, name)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        status = "timeout"
                        break
                    for key, _event in selector.select(min(remaining, 0.1)):
                        data = os.read(key.fileobj.fileno(), 16384)
                        if not data:
                            selector.unregister(key.fileobj)
                            continue
                        size += len(data)
                        if size > self.inventory.output_bytes:
                            status = "output_limit"
                            break
                        chunks[key.data].extend(data)
                    if status != "completed":
                        break
                if status == "completed":
                    try:
                        process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    except subprocess.TimeoutExpired:
                        status = "timeout"
        finally:
            # Kill descendants even when the entrypoint exited before them.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()
            process.stderr.close()
        if status == "completed" and process.returncode != 0:
            status = "failed"
        incomplete = status in {"timeout", "output_limit"}
        return {
            "status": status, "exitCode": process.returncode,
            # Incomplete streams can end in the middle of a credential. Suppress
            # them entirely instead of returning an unsanitizable token prefix.
            "stdout": "" if incomplete else chunks["stdout"].decode("utf-8", errors="replace"),
            "stderr": "The operation has no complete receipt. Check its state before any retry." if incomplete else chunks["stderr"].decode("utf-8", errors="replace"),
            "outputTruncated": status == "output_limit",
        }


def serve(bridge: Bridge, incoming, outgoing) -> None:
    def write(value):
        outgoing.write(json.dumps(value, ensure_ascii=False) + "\n")
        outgoing.flush()

    while True:
        line = incoming.readline(MAX_DOCUMENT_BYTES + 1)
        if not line:
            return
        if len(line.encode("utf-8")) > MAX_DOCUMENT_BYTES:
            while line and not line.endswith("\n"):
                line = incoming.readline(MAX_DOCUMENT_BYTES + 1)
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Request exceeds the size limit."}})
            continue
        try:
            request = strict_json(line)
        except (ValueError, RecursionError):
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON."}})
            continue
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0" or not isinstance(request.get("method"), str) or ("id" in request and type(request["id"]) not in {str, int, type(None)}):
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request."}})
            continue
        if "id" not in request:
            continue
        response = {"jsonrpc": "2.0", "id": request["id"]}
        method = request["method"]
        params = request.get("params", {})
        if not isinstance(params, dict):
            response["error"] = {"code": -32602, "message": "Invalid parameters."}
        elif method == "initialize":
            version = params.get("protocolVersion")
            versions = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
            response["result"] = {"protocolVersion": version if isinstance(version, str) and version in versions else "2024-11-05", "capabilities": {"tools": {"listChanged": False}}, "serverInfo": {"name": "novsky-integrations", "version": "1.0.0"}}
        elif method == "ping":
            response["result"] = {}
        elif method == "tools/list":
            response["result"] = {"tools": bridge.tools()}
        elif method == "tools/call":
            if params.get("name") != "integration_run" or params.keys() - {"name", "arguments", "_meta"}:
                response["error"] = {"code": -32602, "message": "Unknown integration tool or parameters."}
            else:
                response["result"] = bridge.call(params.get("arguments"))
        else:
            response["error"] = {"code": -32601, "message": "Method not found."}
        write(response)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--inventory", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        inventory = Inventory.load(args.inventory)
        serve(Bridge(inventory), sys.stdin, sys.stdout)
    except (Denied, OSError, UnicodeError, ValueError):
        print("novsky-integrations: trusted inventory or stdio transport unavailable", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
