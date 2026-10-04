#!/usr/bin/env python3
"""Activate a paid kit for its verified Telegram bot. Credentials are never output."""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shlex
import stat
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request

ENDPOINT = "https://kgnvsk.dev/api/novsky/redeem"
BACKUPS = Path("/root/backups")
SSH_HOST_KEYS = tuple(Path("/etc/ssh") / ("ssh_host_" + kind + "_key.pub") for kind in ("ed25519", "ecdsa", "rsa"))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_key(key):
    if not isinstance(key, str) or not re.fullmatch(r"[^\s\x00-\x1f\x7f]{1,1024}", key.strip()):
        raise ValueError("A purchased license key is required for this paid kit; provide the key privately and retry.")
    return key.strip()


def machine_fingerprint():
    """Match the SHA256 SSH host-key fingerprint used by legacy Novsky orders."""
    for path in SSH_HOST_KEYS:
        try:
            key = base64.b64decode(path.read_text().split()[1], validate=True)
            return "SHA256:" + base64.b64encode(hashlib.sha256(key).digest()).decode().rstrip("=")
        except (OSError, ValueError, IndexError):
            continue
    return None


def activate(*, key, bot_token, product, machine=None):
    if product == "starter":
        return {"ok": True, "slug": "starter", "bound": False}
    # The purchase key is used once, at the bot's first installation, and kept nowhere (owner, 04.10.2026). Later
    # installs and updates of the same bot go without it: the store confirms the bot with Telegram and finds its purchase.
    key = validate_key(key) if isinstance(key, str) and key.strip() else None
    if not isinstance(bot_token, str) or not re.fullmatch(r"[1-9][0-9]{4,15}:[A-Za-z0-9_-]{20,100}", bot_token):
        raise ValueError("License activation needs a valid Telegram bot token supplied privately.")
    if not isinstance(product, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,50}", product):
        raise ValueError("License activation needs a valid product.")
    payload = {**({"key": key} if key else {}), "botToken": bot_token, "product": product, "download": False}
    machine = machine if machine is not None else machine_fingerprint()
    if machine:
        if not isinstance(machine, str) or not re.fullmatch(r"SHA256:[A-Za-z0-9+/=_-]{1,100}", machine):
            raise ValueError("License activation needs a valid SSH fingerprint.")
        payload["machine"] = machine
    request = urllib.request.Request(ENDPOINT, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
            raw = response.read(16385)
        if len(raw) > 16384:
            raise ValueError("oversized response")
        result = json.loads(raw)
    except urllib.error.HTTPError as error:
        messages = {
            400: "Check the Telegram token and activation inputs privately, then retry.",
            402: "Payment for this license has not been confirmed.",
            409: "The license has an existing binding. Use its Telegram bot; a legacy server-bound key must first activate on its original server.",
            428: "Update the installer to a version that submits the Telegram token and product for activation.",
            404: "The license key was not found. Check the private key and retry.",
            403: "The license is not authorized for this product or its order is not paid.",
            422: "Telegram could not verify this bot token. Check it privately and retry.",
            429: "The activation service is busy. Retry shortly.",
            503: "The activation service is unavailable. Check connectivity and retry with the same key and bot.",
        }
        if error.code == 404 and not key:
            raise ValueError("License activation refused. This bot is not activated yet: its first installation needs the purchase key, provided privately.") from None
        raise ValueError("License activation refused. " + messages.get(error.code, "Check the purchased product and key, then retry.")) from None
    except (OSError, ValueError, urllib.error.URLError):
        raise ValueError("License activation could not be verified. Check connectivity and retry with the same key and bot.") from None
    if (not isinstance(result, dict) or result.get("ok") is not True
            or result.get("botId") != bot_token.split(":", 1)[0]
            or result.get("slug") != product or type(result.get("bound")) is not bool):
        raise ValueError("License activation returned an invalid bot or product confirmation; installation was stopped.")
    return {name: result[name] for name in ("ok", "botId", "slug", "bound")}


def private_path(path):
    path = Path(path)
    if any(parent.is_symlink() for parent in (path, *path.parents)):
        raise ValueError("Unsafe license key path.")
    return path


def read_key(path):
    path = private_path(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return ""
    except OSError:
        raise ValueError("Cannot read the private license key; provide it privately again.") from None
    with os.fdopen(descriptor) as stream:
        metadata = os.fstat(stream.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_size > 1025):
            raise ValueError("The saved license key must be a private, installer-owned file with mode 0600.")
        try:
            return validate_key(stream.read())
        except UnicodeError:
            raise ValueError("The saved license key is invalid; provide it privately again.") from None


def _without_key(payload):
    return b"".join(line for line in payload.splitlines(keepends=True) if not line.startswith(b"NOVSKY_LICENSE_KEY="))


def _scrub_archive(archive, key_member, env_member):
    """Rewrite one archive without the key, every other member kept as it was. False when it holds none."""
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        def holds_key(member):
            if member.name == key_member:
                return True
            return member.name == env_member and member.isreg() and b"\nNOVSKY_LICENSE_KEY=" in b"\n" + source.extractfile(member).read()
        if not any(holds_key(member) for member in members):
            return False
        before = os.stat(archive, follow_symlinks=False)
        descriptor, temporary = tempfile.mkstemp(prefix=archive.name + ".", dir=archive.parent)
        try:
            raw = os.fdopen(descriptor, "wb")
            try:
                with tarfile.open(fileobj=raw, mode="w:gz") as target:
                    for member in members:
                        if member.name == key_member:
                            continue
                        if member.isreg() and member.name in (env_member, "novsky-rollback.json"):
                            payload = source.extractfile(member).read()
                            if member.name == env_member:
                                payload = _without_key(payload)
                            else:
                                # A rollback image records the key as absent: a restore removes it, never brings it back.
                                manifest = json.loads(payload)
                                if key_member in manifest.get("paths", {}):
                                    manifest["paths"][key_member] = None
                                payload = json.dumps(manifest, sort_keys=True).encode()
                            member = copy.copy(member)
                            member.size = len(payload)
                            target.addfile(member, io.BytesIO(payload))
                        else:
                            target.addfile(member, source.extractfile(member) if member.isreg() else None)
                raw.flush()
                os.fsync(raw.fileno())
            finally:
                raw.close()
            os.chown(temporary, before.st_uid, before.st_gid)
            os.chmod(temporary, stat.S_IMODE(before.st_mode))
            os.replace(temporary, archive)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return True


def scrub_backups(user, backups=BACKUPS):
    """The key is kept nowhere (owner, 04.10.2026): drop it from the archives older kits and installers made for this
    agent — its Codex backup and rollback images and an instance's record from its first own kit folder. Only those
    names are read; an archive is rewritten only when it holds a key. A marker skips later passes: once the live
    copies are gone, no new archive can hold one. Returns the number of archives rewritten."""
    if not re.fullmatch(r"[a-z][a-z0-9_-]{0,31}", user):
        raise ValueError("Invalid agent account")
    backups = Path(backups)
    if not backups.is_dir() or backups.is_symlink():
        return 0
    marker = backups / (".novsky-license-scrubbed-" + user)
    if marker.exists() or marker.is_symlink():
        return 0
    names = re.compile("novsky-codex-" + re.escape(user) + r"-[0-9TZ]+(?:\.rollback)?\.tar\.gz"
                       + "|novsky-before-own-kit-" + re.escape(user) + r"-[0-9TZ]+\.tar\.gz")
    key_member = "etc/novsky/codex/" + user + ".license-key"
    env_member = "etc/claude-tg-starter/agent-" + user + ".env"
    rewritten = 0
    for archive in sorted(backups.iterdir()):
        if names.fullmatch(archive.name) and not archive.is_symlink() and archive.is_file():
            rewritten += _scrub_archive(archive, key_member, env_member)
    os.close(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
    return rewritten


def saved_values(path):
    """Read only credential fields as shell-quoted data, never execute a file."""
    if path is None or not path.exists():
        return {}
    private_path(path)
    result = {}
    try:
        for line in path.read_text().splitlines():
            name, separator, raw = line.partition("=")
            if not separator or name not in ("TELEGRAM_BOT_TOKEN", "NOVSKY_LICENSE_KEY"):
                continue
            if name in result or raw.startswith("$'"):
                raise ValueError("invalid credential input")
            values = shlex.split(raw, comments=True)
            if len(values) > 1:
                raise ValueError("invalid credential input")
            result[name] = values[0] if values else ""
    except (OSError, UnicodeError, ValueError):
        raise ValueError("License activation could not read private installation credentials.") from None
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--product")
    parser.add_argument("--saved-env", type=Path)
    parser.add_argument("--bot-env", type=Path)
    parser.add_argument("--scrub-backups", metavar="USER")
    args = parser.parse_args()
    if args.scrub_backups:
        print(json.dumps({"rewritten": scrub_backups(args.scrub_backups)}))
        return
    product = args.product
    if product is None:
        try:
            product = json.loads((Path(__file__).resolve().parents[1] / "product/runtime.json").read_text())["productId"]
        except (OSError, ValueError, KeyError, TypeError):
            raise ValueError("License activation could not read the kit product.") from None
    if product == "starter":
        return
    saved = saved_values(args.saved_env)
    current = saved_values(args.bot_env)
    result = activate(key=os.environ.get("NOVSKY_LICENSE_KEY") or saved.get("NOVSKY_LICENSE_KEY", ""),
                      bot_token=os.environ.get("TELEGRAM_BOT_TOKEN") or current.get("TELEGRAM_BOT_TOKEN") or saved.get("TELEGRAM_BOT_TOKEN", ""),
                      product=product)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("License activation failed; retry with the same private key and bot.", file=sys.stderr)
        sys.exit(1)
