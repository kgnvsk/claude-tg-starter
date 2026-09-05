#!/usr/bin/env bash
set -euo pipefail

[ "$(id -u)" -eq 0 ] || {
  echo "FATAL: restore must run as root after reviewing a dry run" >&2
  exit 1
}
exec python3 "$(dirname "${BASH_SOURCE[0]}")/restore-agent-backup.py" "$@"
