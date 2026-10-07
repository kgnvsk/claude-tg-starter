#!/usr/bin/env bash
# Existing agents may predate accepted persona hashes. Trust their previous
# root-owned kit only when its source matches a published artifact and renders
# the live file byte-for-byte.

previous_persona_source() {
  local source="$1"
  python3 - "$KIT" "${NOVSKY_PREVIOUS_KIT_DIR:-}" "$source" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

candidate, previous_name, source_name = sys.argv[1:]
try:
    candidate = Path(candidate).resolve(strict=True)
    previous = Path(previous_name)
    source = Path(source_name)
    if not previous.is_absolute() or previous.resolve(strict=True) != previous:
        raise ValueError("previous kit path is missing or indirect")
    if previous == candidate:
        raise ValueError("previous kit is the candidate kit")
    if (not source.is_absolute() or source.resolve(strict=True) != source
            or ".." in source.parts):
        raise ValueError("persona source is indirect")
    relative = source.relative_to(candidate)
    if (not relative.parts or relative.parts[0] != "assets"
            or ".." in relative.parts):
        raise ValueError("persona source is outside the candidate kit")

    def trusted(path: Path, directory: bool = False) -> None:
        info = path.lstat()
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise ValueError("previous kit is writable or has another owner")
        if directory:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("previous kit directory is indirect")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("previous kit file is indirect")

    trusted(previous, directory=True)
    for part in relative.parts[:-1]:
        previous = previous / part
        trusted(previous, directory=True)
    old_source = previous / relative.name
    trusted(old_source)
    prior_root = Path(previous_name)
    prior_release = prior_root / "RELEASE.json"
    trusted(prior_release)
    release = json.loads(prior_release.read_text(encoding="utf-8"))
    runtime = json.loads(
        (candidate / "assets/product/runtime.json").read_text(encoding="utf-8")
    )
    if (release.get("schema") != "claude-kit-release/v1"
            or not re.fullmatch(r"[0-9a-f]{40}", release.get("sourceKitRevision", ""))
            or release.get("productId") != runtime.get("productId")):
        raise ValueError("previous kit release identity does not match")
    # RELEASE.json identifies the old product, but a locally edited old kit can
    # retain that identity. Accept only bytes pinned from published artifacts.
    catalog_path = candidate / "assets/product/legacy-persona-hashes.json"
    if catalog_path.resolve(strict=True) != catalog_path:
        raise ValueError("persona provenance catalog is indirect")
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    if catalog.get("schema") != "novsky-legacy-persona-hashes/v1":
        raise ValueError("persona provenance catalog is invalid")
    digest = hashlib.sha256(old_source.read_bytes()).hexdigest()
    if release["sourceKitRevision"] in catalog["revisions"]:
        expected = (
            catalog["revisions"][release["sourceKitRevision"]]
            [release["productId"]][relative.as_posix()]
        )
        if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError("persona provenance digest is invalid")
        if digest != expected:
            raise ValueError("previous persona source differs from its published artifact")
    else:
        # A premium kit built from a revision no pin names (archives were also
        # built by hand for buyers outside the store) is trusted only with the
        # exact bytes of a version this file has had in the kit's history:
        # premium ships these sources as they are (Святослав, 07.10.2026).
        history = catalog["premiumHistory"][relative.as_posix()]
        if (release["productId"] != "premium" or not isinstance(history, list)
                or not all(isinstance(item, str) and re.fullmatch(r"[0-9a-f]{64}", item)
                           for item in history)
                or digest not in history):
            raise ValueError("previous persona source is not a published kit version")
    current_release = candidate / "RELEASE.json"
    if current_release.is_file():
        current = json.loads(current_release.read_text(encoding="utf-8"))
        if release["sourceKitRevision"] == current.get("sourceKitRevision"):
            raise ValueError("previous kit has the candidate revision")
    print(old_source)
except (OSError, UnicodeError, ValueError, TypeError, KeyError, AttributeError,
        json.JSONDecodeError):
    raise SystemExit("FATAL: managed persona needs a reviewed migration; previous kit source is not verified") from None
PY
}

guard_managed_persona() {
  local action="$1" source="$2" destination="$3" baseline="$4" old_source
  case "$action" in check|seed) ;; *) return 2 ;; esac
  if [ -e "$baseline" ] || [ -L "$baseline" ]; then
    render_template "$source" "$destination" --check-baseline "$baseline"
    return
  fi
  if render_template "$source" "$destination" --check-unchanged >/dev/null 2>&1; then
    return
  fi
  old_source="$(previous_persona_source "$source")" || return 1
  render_template "$old_source" "$destination" --check-unchanged || return 1
  if [ "$action" = seed ]; then
    render_template "$old_source" "$destination" --accept-baseline "$baseline"
  fi
}
