#!/usr/bin/env python3
"""Plan customization-safe updates for source-managed runtime files."""

from __future__ import annotations

from dataclasses import dataclass
import base64
import codecs
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import shlex
import stat
import subprocess
import tempfile
import warnings
import zlib


PRODUCT_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
MANAGED_PATH = re.compile(r"^bin/[a-z0-9][a-z0-9.-]*$")
RENDER_PLACEHOLDERS = (
    "AGENT_NAME",
    "OWNER_NAME",
    "OWNER_TG_USERNAME",
    "OWNER_CHAT_ID",
    "BOT_USERNAME",
    "TIMEZONE",
    "CALENDAR_EMAIL",
    "DEPLOY_DATE",
    "AGENT_HOME",
    "AGENT_SERVICE",
    "AGENT_USER",
)
PROFILE_KEYS = (
    "AGENT_NAME",
    "OWNER_NAME",
    "OWNER_TG_USERNAME",
    "OWNER_CHAT_ID",
    "ADDITIONAL_ADMIN_CHAT_IDS",
    "ALERT_COPY_CHAT_IDS",
    "OWNER_EMAIL",
    "BOT_USERNAME",
    "TIMEZONE",
    "CALENDAR_EMAIL",
    "VAULT_LOCALE",
    "TG_DROP_PENDING_ON_BOOT",
)
MAX_LEGACY_TEMPLATE_BYTES = 1024 * 1024
ANSI_C_VALUE = re.compile(r"^\$'(?:[^'\\]|\\.)*'$", re.DOTALL)


class BaselineError(ValueError):
    pass


class UpdateError(ValueError):
    pass


@dataclass(frozen=True)
class FileState:
    digest: str | None
    kind: str
    mode: int | None


@dataclass(frozen=True)
class Decision:
    path: str
    action: str
    reason: str


@dataclass(frozen=True)
class UpdatePlan:
    product_id: str
    source_revision: str
    decisions: tuple[Decision, ...]
    baseline: dict[str, object]


def decide(
    path: str,
    baseline: FileState | None,
    live: FileState,
    target: FileState,
) -> Decision:
    if baseline is None:
        if live == target:
            return Decision(path, "accept", "already-target")
        if live.digest is None and target.digest is not None:
            return Decision(path, "install", "new-path")
        return Decision(path, "unclassified", "missing-baseline")
    if live == target:
        return Decision(path, "accept", "already-target")
    if live == baseline:
        return Decision(
            path,
            "remove" if target.digest is None else "install",
            "clean-live",
        )
    if target == baseline:
        return Decision(
            path,
            "preserve-absence" if live.digest is None else "preserve",
            "owner-only-change",
        )
    if target.digest is None:
        return Decision(path, "retain-unmanaged", "customized-removed-path")
    return Decision(path, "conflict", "owner-and-target-changed")


def validate_baseline(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != {
        "schemaVersion",
        "productId",
        "sourceRevision",
        "files",
    }:
        raise BaselineError("baseline has unexpected top-level fields")
    if isinstance(value["schemaVersion"], bool) or value["schemaVersion"] != 1:
        raise BaselineError("unsupported baseline schema")
    product_id = value["productId"]
    if not isinstance(product_id, str) or not PRODUCT_ID.fullmatch(product_id):
        raise BaselineError("invalid baseline product ID")
    revision = value["sourceRevision"]
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise BaselineError("invalid baseline source revision")
    files = value["files"]
    if not isinstance(files, dict) or len(files) > 512:
        raise BaselineError("invalid baseline file table")
    normalized: dict[str, dict[str, object]] = {}
    for relative, metadata in files.items():
        if (
            not isinstance(relative, str)
            or not MANAGED_PATH.fullmatch(relative)
            or PurePosixPath(relative).is_absolute()
            or ".." in PurePosixPath(relative).parts
        ):
            raise BaselineError("invalid managed baseline path")
        if not isinstance(metadata, dict) or set(metadata) != {
            "sha256",
            "kind",
            "mode",
        }:
            raise BaselineError(f"invalid baseline metadata: {relative}")
        digest = metadata["sha256"]
        mode = metadata["mode"]
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise BaselineError(f"invalid baseline digest: {relative}")
        if metadata["kind"] != "file":
            raise BaselineError(f"unsupported baseline file kind: {relative}")
        if isinstance(mode, bool) or not isinstance(mode, int) or not 0 <= mode <= 0o777:
            raise BaselineError(f"invalid baseline mode: {relative}")
        normalized[relative] = {
            "sha256": digest,
            "kind": "file",
            "mode": mode,
        }
    return {
        "schemaVersion": 1,
        "productId": product_id,
        "sourceRevision": revision,
        "files": normalized,
    }


def load_baseline(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BaselineError("cannot read managed runtime baseline") from error
    return validate_baseline(value)


def write_baseline(
    path: Path,
    value: dict[str, object],
    uid: int | None = None,
    gid: int | None = None,
) -> None:
    normalized = validate_baseline(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(normalized, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        if uid is not None and gid is not None:
            os.chown(temporary, uid, gid)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def hash_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def render_context(
    home: Path,
    *,
    include_environment: bool = True,
) -> dict[str, str]:
    """Return the non-secret values used by the installer's template renderer."""
    values: dict[str, str] = {}
    profile = home / ".agent-profile.env"
    try:
        metadata = profile.lstat()
    except FileNotFoundError:
        metadata = None
    except OSError as error:
        raise UpdateError("cannot inspect agent profile") from error
    if metadata is not None:
        try:
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
                raise UpdateError("agent profile is unsafe")
            payload = profile.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise UpdateError("cannot read agent profile") from error
        if len(payload.encode("utf-8")) > 64 * 1024:
            raise UpdateError("agent profile is too large")
        for number, line in enumerate(payload.splitlines(), 1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            name, separator, raw = line.partition("=")
            if not separator:
                raise UpdateError(f"invalid agent profile line: {number}")
            if name not in PROFILE_KEYS:
                continue
            if name in values:
                raise UpdateError(f"invalid agent profile value: {name}")
            if raw == "":
                values[name] = ""
                continue
            if raw.startswith("$'"):
                if ANSI_C_VALUE.fullmatch(raw) is None:
                    raise UpdateError(f"invalid agent profile value: {name}")
                try:
                    with warnings.catch_warnings():
                        warnings.simplefilter("error", DeprecationWarning)
                        decoded = codecs.escape_decode(
                            raw[2:-1].encode("utf-8")
                        )[0]
                    if b"\0" in decoded:
                        raise ValueError
                    values[name] = decoded.decode("utf-8")
                except (UnicodeError, ValueError, DeprecationWarning) as error:
                    raise UpdateError(
                        f"invalid agent profile value: {name}"
                    ) from error
                continue
            try:
                tokens = shlex.split(raw, posix=True)
            except ValueError as error:
                raise UpdateError(f"invalid agent profile value: {name}") from error
            if len(tokens) != 1 or "\0" in tokens[0]:
                raise UpdateError(f"invalid agent profile value: {name}")
            values[name] = tokens[0]

    agent_user = home.name
    values.setdefault("AGENT_HOME", str(home))
    values.setdefault("AGENT_USER", agent_user)
    values.setdefault(
        "AGENT_SERVICE",
        "claude-telegram.service"
        if agent_user == "claude"
        else f"claude-telegram@{agent_user}.service",
    )
    if include_environment:
        for name in RENDER_PLACEHOLDERS:
            if name in os.environ:
                values[name] = os.environ[name]
    return values


def render_template_bytes(
    payload: bytes,
    context: dict[str, str],
    relative: str,
) -> bytes:
    if b"{{" not in payload:
        return payload
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise UpdateError(f"managed template is not UTF-8: {relative}") from error
    for name in RENDER_PLACEHOLDERS:
        text = text.replace("{{" + name + "}}", context.get(name, ""))
    return text.encode("utf-8")


def rendered_target_bytes(
    home: Path,
    kit: Path,
    relative: str,
    values: dict[str, str] | None = None,
) -> bytes:
    source = kit / "assets/bin" / PurePosixPath(relative).name
    try:
        metadata = source.lstat()
        payload = source.read_bytes()
    except OSError as error:
        raise UpdateError(f"managed target is missing: {relative}") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise UpdateError(f"managed target is unsafe: {relative}")
    context = values if values is not None else render_context(home)
    return render_template_bytes(payload, context, relative)


def load_legacy_templates(kit: Path) -> dict[str, dict[str, bytes]]:
    """Load the finite bridge for releases that hashed raw templates."""
    path = kit / "assets/product/managed-runtime-legacy.json"
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise UpdateError("cannot inspect legacy template bridge") from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_size > 512 * 1024
    ):
        raise UpdateError("legacy template bridge is unsafe")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpdateError("cannot read legacy template bridge") from error
    if (
        not isinstance(document, dict)
        or set(document) != {"schemaVersion", "templates"}
        or document["schemaVersion"] != 1
        or not isinstance(document["templates"], dict)
    ):
        raise UpdateError("legacy template bridge has an invalid schema")

    decoded: dict[str, dict[str, bytes]] = {}
    for relative, variants in document["templates"].items():
        if (
            not isinstance(relative, str)
            or not MANAGED_PATH.fullmatch(relative)
            or not isinstance(variants, dict)
            or len(variants) > 16
        ):
            raise UpdateError("legacy template bridge has an invalid path")
        decoded_variants: dict[str, bytes] = {}
        for digest, encoded in variants.items():
            if (
                not isinstance(digest, str)
                or not DIGEST.fullmatch(digest)
                or not isinstance(encoded, str)
            ):
                raise UpdateError("legacy template bridge has invalid metadata")
            try:
                compressed = base64.b64decode(encoded, validate=True)
                inflater = zlib.decompressobj()
                payload = inflater.decompress(
                    compressed,
                    MAX_LEGACY_TEMPLATE_BYTES + 1,
                )
                payload += inflater.flush(
                    max(0, MAX_LEGACY_TEMPLATE_BYTES + 1 - len(payload))
                )
            except (ValueError, zlib.error) as error:
                raise UpdateError("legacy template bridge is corrupt") from error
            if (
                len(payload) > MAX_LEGACY_TEMPLATE_BYTES
                or not inflater.eof
                or inflater.unused_data
                or inflater.unconsumed_tail
                or hashlib.sha256(payload).hexdigest() != digest
            ):
                raise UpdateError("legacy template bridge is corrupt")
            decoded_variants[digest] = payload
        decoded[relative] = decoded_variants
    return decoded


def selected_bin_paths(policy_path: Path) -> list[str]:
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpdateError("cannot read managed runtime policy") from error
    if not isinstance(policy, dict) or set(policy) != {
        "schemaVersion",
        "selected",
        "managed",
    }:
        raise UpdateError("managed runtime policy has unexpected fields")
    if policy["schemaVersion"] != 2:
        raise UpdateError("managed runtime policy must use schema 2")
    selected = policy["selected"]
    managed = policy["managed"]
    if (
        not isinstance(selected, list)
        or not isinstance(managed, list)
        or any(not isinstance(value, str) for value in (*selected, *managed))
        or len(selected) != len(set(selected))
        or len(managed) != len(set(managed))
        or not set(selected).issubset(set(managed))
    ):
        raise UpdateError("managed runtime policy contains invalid path lists")
    paths = sorted(value for value in selected if value.startswith("bin/"))
    if any(not MANAGED_PATH.fullmatch(value) for value in paths):
        raise UpdateError("managed runtime policy contains an unsafe bin path")
    return paths


def source_identity(kit: Path) -> tuple[str, str]:
    try:
        runtime = json.loads(
            (kit / "assets/product/runtime.json").read_text(encoding="utf-8")
        )
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UpdateError("cannot read product identity") from error
    product_id = runtime.get("productId") if isinstance(runtime, dict) else None
    if not isinstance(product_id, str) or not PRODUCT_ID.fullmatch(product_id):
        raise UpdateError("invalid product identity")
    release_path = kit / "RELEASE.json"
    revision: object = None
    if release_path.is_file():
        try:
            release = json.loads(release_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise UpdateError("cannot read release identity") from error
        revision = release.get("sourceKitRevision") if isinstance(release, dict) else None
    elif (kit / ".git").exists() or (kit / ".git").is_file():
        result = subprocess.run(
            ["git", "-C", str(kit), "rev-parse", "HEAD"],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            revision = result.stdout.strip()
    if not isinstance(revision, str) or not REVISION.fullmatch(revision):
        raise UpdateError("invalid or missing source revision")
    return product_id, revision


def target_state(
    home: Path,
    kit: Path,
    relative: str,
    values: dict[str, str] | None = None,
) -> FileState:
    payload = rendered_target_bytes(home, kit, relative, values)
    return FileState(hashlib.sha256(payload).hexdigest(), "file", 0o755)


def live_path(home: Path, relative: str) -> Path:
    if home.is_symlink():
        raise UpdateError("managed home is a symlink")
    current = home
    parts = PurePosixPath(relative).parts
    for part in parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise UpdateError(f"managed path parent is a symlink: {relative}")
    return home.joinpath(*parts)


def validate_baseline_location(home: Path, baseline_path: Path) -> None:
    expected = home / ".claude/product/managed-runtime-baseline.json"
    if Path(os.path.abspath(baseline_path)) != Path(os.path.abspath(expected)):
        raise UpdateError("managed baseline path is not the approved home path")
    current = home
    if current.is_symlink():
        raise UpdateError("managed home is a symlink")
    for part in (".claude", "product"):
        current = current / part
        if current.is_symlink():
            raise UpdateError("managed baseline parent is a symlink")
        if current.exists() and not current.is_dir():
            raise UpdateError("managed baseline parent is not a directory")


def inspect_live(home: Path, relative: str) -> FileState:
    path = live_path(home, relative)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return FileState(None, "absent", None)
    except OSError as error:
        raise UpdateError(f"cannot inspect managed live path: {relative}") from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise UpdateError(f"managed live path is unsafe: {relative}")
    return FileState(hash_file(path), "file", stat.S_IMODE(metadata.st_mode))


def metadata_state(value: dict[str, object]) -> FileState:
    return FileState(
        value["sha256"],
        value["kind"],
        value["mode"],
    )


def build_plan(
    home: Path,
    kit: Path,
    policy_path: Path,
    baseline_path: Path,
) -> UpdatePlan:
    validate_baseline_location(home, baseline_path)
    product_id, revision = source_identity(kit)
    selected = selected_bin_paths(policy_path)
    values = render_context(home)
    legacy_values = render_context(home, include_environment=False)
    targets = {
        relative: target_state(home, kit, relative, values) for relative in selected
    }
    previous = None
    if baseline_path.exists():
        previous = load_baseline(baseline_path)
        if previous["productId"] != product_id:
            raise UpdateError("managed baseline belongs to another product")
    previous_files = previous["files"] if previous is not None else {}
    legacy_templates: dict[str, dict[str, bytes]] | None = None
    decisions = []
    for relative in sorted(set(previous_files) | set(targets)):
        live = inspect_live(home, relative)
        target = targets.get(relative, FileState(None, "absent", None))
        baseline_state = (
            metadata_state(previous_files[relative])
            if relative in previous_files
            else None
        )
        if (
            previous is None
            and baseline_state is None
            and live.digest is not None
            and live != target
        ):
            if legacy_templates is None:
                legacy_templates = load_legacy_templates(kit)
            for legacy_payload in legacy_templates.get(relative, {}).values():
                rendered_digest = hashlib.sha256(
                    render_template_bytes(
                        legacy_payload,
                        legacy_values,
                        relative,
                    )
                ).hexdigest()
                candidate = FileState(rendered_digest, "file", 0o755)
                if live == candidate:
                    baseline_state = candidate
                    break
        elif baseline_state is not None and live != baseline_state:
            if legacy_templates is None:
                legacy_templates = load_legacy_templates(kit)
            legacy_payload = legacy_templates.get(relative, {}).get(
                str(baseline_state.digest)
            )
            if legacy_payload is not None:
                baseline_state = FileState(
                    hashlib.sha256(
                        render_template_bytes(
                            legacy_payload,
                            legacy_values,
                            relative,
                        )
                    ).hexdigest(),
                    "file",
                    baseline_state.mode,
                )
        decisions.append(
            decide(relative, baseline_state, live, target)
        )
    files = {
        relative: {
            "sha256": target.digest,
            "kind": target.kind,
            "mode": target.mode,
        }
        for relative, target in targets.items()
    }
    baseline = {
        "schemaVersion": 1,
        "productId": product_id,
        "sourceRevision": revision,
        "files": files,
    }
    return UpdatePlan(product_id, revision, tuple(decisions), baseline)


def atomic_install(
    source: Path,
    target: Path,
    mode: int = 0o755,
    uid: int | None = None,
    gid: int | None = None,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        dir=target.parent,
    )
    temporary = Path(temporary_name)
    try:
        with source.open("rb") as input_handle, os.fdopen(descriptor, "wb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        os.chmod(temporary, mode)
        if uid is not None and gid is not None:
            os.chown(temporary, uid, gid)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_install_bytes(
    payload: bytes,
    target: Path,
    mode: int = 0o755,
    uid: int | None = None,
    gid: int | None = None,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.",
        dir=target.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as output_handle:
            output_handle.write(payload)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        os.chmod(temporary, mode)
        if uid is not None and gid is not None:
            os.chown(temporary, uid, gid)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def apply_plan(
    home: Path,
    kit: Path,
    baseline_path: Path,
    plan: UpdatePlan,
    uid: int | None = None,
    gid: int | None = None,
    defer_baseline: bool = False,
) -> None:
    validate_baseline_location(home, baseline_path)
    blocked = {"conflict", "unclassified"}
    if any(decision.action in blocked for decision in plan.decisions):
        raise UpdateError("managed runtime update is blocked by owner changes")
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_existed = baseline_path.is_file()
    values = render_context(home)
    with tempfile.TemporaryDirectory(
        prefix=".managed-runtime-transaction.",
        dir=baseline_path.parent,
    ) as transaction_name:
        transaction = Path(transaction_name)
        preimages: dict[str, tuple[Path | None, int | None]] = {}
        for index, decision in enumerate(plan.decisions):
            if decision.action not in {"install", "remove"}:
                continue
            target = live_path(home, decision.path)
            if target.is_file():
                backup = transaction / f"{index}.preimage"
                shutil.copy2(target, backup, follow_symlinks=False)
                preimages[decision.path] = (
                    backup,
                    stat.S_IMODE(target.stat().st_mode),
                )
            else:
                preimages[decision.path] = (None, None)
        baseline_backup = transaction / "baseline.preimage"
        if baseline_existed:
            shutil.copy2(baseline_path, baseline_backup, follow_symlinks=False)
        try:
            for decision in plan.decisions:
                target = live_path(home, decision.path)
                if decision.action == "install":
                    payload = rendered_target_bytes(
                        home, kit, decision.path, values
                    )
                    expected = plan.baseline["files"][decision.path]["sha256"]
                    if hashlib.sha256(payload).hexdigest() != expected:
                        raise UpdateError("managed render context changed during apply")
                    atomic_install_bytes(payload, target, uid=uid, gid=gid)
                elif decision.action == "remove":
                    target.unlink(missing_ok=True)
            if not defer_baseline:
                write_baseline(baseline_path, plan.baseline, uid, gid)
        except Exception:
            try:
                for relative, (backup, mode) in reversed(tuple(preimages.items())):
                    target = live_path(home, relative)
                    if backup is None:
                        target.unlink(missing_ok=True)
                    else:
                        atomic_install(backup, target, mode or 0o755, uid, gid)
                if not defer_baseline:
                    if baseline_existed:
                        atomic_install(baseline_backup, baseline_path, 0o600, uid, gid)
                    else:
                        baseline_path.unlink(missing_ok=True)
            except Exception as rollback_error:
                raise UpdateError("managed runtime rollback failed") from rollback_error
            raise


def accept_plan(
    home: Path,
    baseline_path: Path,
    plan: UpdatePlan,
    uid: int | None = None,
    gid: int | None = None,
) -> None:
    validate_baseline_location(home, baseline_path)
    incomplete = {"install", "remove", "conflict", "unclassified"}
    if any(decision.action in incomplete for decision in plan.decisions):
        raise UpdateError("managed runtime target has not passed final acceptance")
    write_baseline(baseline_path, plan.baseline, uid, gid)


def seed_baseline(
    home: Path,
    kit: Path,
    policy_path: Path,
    baseline_path: Path,
    uid: int | None = None,
    gid: int | None = None,
) -> dict:
    validate_baseline_location(home, baseline_path)
    if baseline_path.exists() or baseline_path.is_symlink():
        raise UpdateError("managed runtime baseline already exists")
    product_id, revision = source_identity(kit)
    files = {}
    values = render_context(home)
    for relative in selected_bin_paths(policy_path):
        target = target_state(home, kit, relative, values)
        files[relative] = {
            "sha256": target.digest,
            "kind": target.kind,
            "mode": target.mode,
        }
    baseline = {
        "schemaVersion": 1,
        "productId": product_id,
        "sourceRevision": revision,
        "files": files,
    }
    write_baseline(baseline_path, baseline, uid, gid)
    return baseline
