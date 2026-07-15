#!/usr/bin/env bash
set -Eeuo pipefail

[[ "${1:-}" == reconcile ]] || { echo "Usage: $0 reconcile" >&2; exit 2; }
ROOT="${MULTI_USER_ROOT:-}"
H="${ROOT}/home/claude"
STATE_DIR="$H/multi-user/state"
ROOT_STATE_DIR="${ROOT}/var/lib/claude-multi-user"
METADATA="$ROOT_STATE_DIR/previous-transport-state"
TRANSITION="$STATE_DIR/transitioning"
ENABLED="$STATE_DIR/enabled"
LOCK="$H/logs/transport-lifecycle.lock"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
RUNUSER="${RUNUSER:-runuser}"
CLAUDE_UID_VALUE="${CLAUDE_UID:-$(id -u claude)}"

userctl() {
  "$RUNUSER" -u claude -- env XDG_RUNTIME_DIR="/run/user/$CLAUDE_UID_VALUE" \
    "$SYSTEMCTL" --user "$@"
}

load_transition() {
  local key value extra count=0
  local seen_direction=0 seen_started_at=0
  unset direction started_at
  [[ -f "$TRANSITION" ]] || return 1
  while IFS='=' read -r key value extra; do
    [[ -z "$extra" ]] || return 1
    case "$key" in
      direction) [[ "$seen_direction" == 0 && ( "$value" == enabling || "$value" == disabling ) ]] || return 1; seen_direction=1 ;;
      started_at) [[ "$seen_started_at" == 0 && "$value" =~ ^[0-9]+$ ]] || return 1; seen_started_at=1 ;;
      *) return 1 ;;
    esac
    printf -v "$key" '%s' "$value"; count=$((count + 1))
  done < "$TRANSITION"
  [[ "$count" == 2 && -n "${direction+x}" && -n "${started_at+x}" ]]
}

load_metadata() {
  local key value extra count=0
  local seen_system_enabled=0 seen_system_active=0 seen_user_enabled=0 seen_user_active=0
  unset LEGACY_SYSTEM_ENABLED LEGACY_SYSTEM_ACTIVE LEGACY_USER_ENABLED LEGACY_USER_ACTIVE
  [[ -f "$METADATA" ]] || return 1
  while IFS='=' read -r key value extra; do
    [[ -z "$extra" && "$value" =~ ^[01]$ ]] || return 1
    case "$key" in
      LEGACY_SYSTEM_ENABLED) [[ "$seen_system_enabled" == 0 ]] || return 1; seen_system_enabled=1 ;;
      LEGACY_SYSTEM_ACTIVE) [[ "$seen_system_active" == 0 ]] || return 1; seen_system_active=1 ;;
      LEGACY_USER_ENABLED) [[ "$seen_user_enabled" == 0 ]] || return 1; seen_user_enabled=1 ;;
      LEGACY_USER_ACTIVE) [[ "$seen_user_active" == 0 ]] || return 1; seen_user_active=1 ;;
      *) return 1 ;;
    esac
    printf -v "$key" '%s' "$value"; count=$((count + 1))
  done < "$METADATA"
  [[ "$count" == 4 && -n "${LEGACY_SYSTEM_ENABLED+x}" \
    && -n "${LEGACY_SYSTEM_ACTIVE+x}" && -n "${LEGACY_USER_ENABLED+x}" \
    && -n "${LEGACY_USER_ACTIVE+x}" ]]
}

stop_multi() {
  userctl disable --now claude-multi-user-dispatcher.service 2>/dev/null || true
  userctl disable --now claude-multi-user-receiver.service 2>/dev/null || true
}

mkdir -p "$(dirname "$LOCK")"
touch "$LOCK"; chmod 0600 "$LOCK"
exec 9>"$LOCK"
flock -x 9
load_transition || { echo "FATAL: invalid transition marker" >&2; exit 1; }
load_metadata || { echo "FATAL: invalid legacy transport state" >&2; exit 1; }

if [[ "$direction" == enabling ]]; then
  "$SYSTEMCTL" disable --now claude-telegram.service
  userctl disable --now cash-tg-receiver.service 2>/dev/null || true
  userctl daemon-reload
  userctl enable --now claude-multi-user-receiver.service
  userctl enable --now claude-multi-user-dispatcher.service
  temporary="$STATE_DIR/.enabled.$$"
  printf '1\n' > "$temporary"; chmod 0600 "$temporary"; mv -f "$temporary" "$ENABLED"
  [[ -n "$ROOT" ]] || chown claude:claude "$ENABLED"
  rm -f "$TRANSITION"
  exit 0
fi

stop_multi
if [[ "$LEGACY_SYSTEM_ENABLED" == 1 ]]; then
  "$SYSTEMCTL" enable claude-telegram.service
else
  "$SYSTEMCTL" disable claude-telegram.service 2>/dev/null || true
fi
if [[ "$LEGACY_USER_ENABLED" == 1 ]]; then
  userctl enable cash-tg-receiver.service
else
  userctl disable cash-tg-receiver.service 2>/dev/null || true
fi
if [[ "$LEGACY_SYSTEM_ACTIVE" == 1 ]]; then
  "$SYSTEMCTL" start claude-telegram.service
else
  "$SYSTEMCTL" stop claude-telegram.service 2>/dev/null || true
fi
if [[ "$LEGACY_USER_ACTIVE" == 1 ]]; then
  userctl start cash-tg-receiver.service
else
  userctl stop cash-tg-receiver.service 2>/dev/null || true
fi
rm -f "$ENABLED" "$TRANSITION" "$METADATA"
