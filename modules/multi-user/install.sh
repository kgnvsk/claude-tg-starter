#!/usr/bin/env bash
set -Eeuo pipefail

MOD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-enable}"
ROOT="${MULTI_USER_ROOT:-}"
CLAUDE_USER="${CLAUDE_USER:-claude}"
H="${MULTI_USER_HOME:-${ROOT}/home/claude}"
DEPLOY_DIR="${MULTI_USER_DEPLOY_DIR:-$H/multi-user}"
STATE_DIR="${STATE_DIR:-$DEPLOY_DIR/state}"
WORKSPACES_DIR="${WORKSPACES_DIR:-$STATE_DIR/workspaces}"
USER_UNIT_DIR="${MULTI_USER_UNIT_DIR:-$H/.config/systemd/user}"
ROOT_STATE_DIR="${MULTI_USER_ROOT_STATE_DIR:-${ROOT}/var/lib/claude-multi-user}"
LEGACY_STATE_FILE="$ROOT_STATE_DIR/previous-transport-state"
ENABLED_FILE="$STATE_DIR/enabled"
TRANSITIONING_FILE="$STATE_DIR/transitioning"
LIFECYCLE_LOCK="${LIFECYCLE_LOCK:-$H/logs/transport-lifecycle.lock}"
SYSTEMCTL="${SYSTEMCTL:-systemctl}"
LOGINCTL="${LOGINCTL:-loginctl}"
RUNUSER="${RUNUSER:-runuser}"
TIMEOUT="${TIMEOUT:-timeout}"
FLOCK="${FLOCK:-flock}"
BUN_EXECUTABLE="${BUN_EXECUTABLE:-$H/.bun/bin/bun}"
CLAUDE_EXECUTABLE="${CLAUDE_EXECUTABLE:-$H/.local/bin/claude}"

if [[ "${MULTI_USER_SKIP_ROOT_CHECK:-0}" != 1 && $EUID -ne 0 ]]; then
  echo "FATAL: multi-user installer must run as root" >&2
  exit 1
fi
if [[ "$ACTION" != enable && "$ACTION" != disable && "$ACTION" != status ]]; then
  echo "Usage: $0 enable|disable|status" >&2
  exit 2
fi

CLAUDE_UID_VALUE="${CLAUDE_UID:-$(id -u "$CLAUDE_USER")}"

userctl() {
  "$RUNUSER" -u "$CLAUDE_USER" -- env \
    XDG_RUNTIME_DIR="/run/user/$CLAUDE_UID_VALUE" \
    "$SYSTEMCTL" --user "$@"
}
active_system() { "$SYSTEMCTL" is-active --quiet claude-telegram.service; }
enabled_system() { "$SYSTEMCTL" is-enabled --quiet claude-telegram.service; }
active_user() { userctl is-active --quiet "$1"; }
enabled_user() { userctl is-enabled --quiet "$1"; }
bool_command() { if "$@"; then printf '1'; else printf '0'; fi; }

stop_multi() {
  for unit in claude-multi-user-dispatcher.service claude-multi-user-receiver.service; do
    if ! userctl disable --now "$unit" 2>/dev/null \
       && active_user "$unit"; then
      echo "FATAL: could not stop $unit" >&2
      return 1
    fi
  done
}

load_legacy_state() {
  [[ -f "$LEGACY_STATE_FILE" ]] || { echo "FATAL: legacy transport state is missing" >&2; return 1; }
  unset LEGACY_SYSTEM_ENABLED LEGACY_SYSTEM_ACTIVE LEGACY_USER_ENABLED LEGACY_USER_ACTIVE
  local seen_system_enabled=0 seen_system_active=0 seen_user_enabled=0 seen_user_active=0
  local key value extra count=0
  while IFS='=' read -r key value extra; do
    [[ -z "$extra" && "$value" =~ ^[01]$ ]] || {
      echo "FATAL: invalid legacy transport state" >&2; return 1;
    }
    case "$key" in
      LEGACY_SYSTEM_ENABLED) [[ "$seen_system_enabled" == 0 ]] || return 1; seen_system_enabled=1 ;;
      LEGACY_SYSTEM_ACTIVE) [[ "$seen_system_active" == 0 ]] || return 1; seen_system_active=1 ;;
      LEGACY_USER_ENABLED) [[ "$seen_user_enabled" == 0 ]] || return 1; seen_user_enabled=1 ;;
      LEGACY_USER_ACTIVE) [[ "$seen_user_active" == 0 ]] || return 1; seen_user_active=1 ;;
      *) echo "FATAL: invalid legacy transport state" >&2; return 1 ;;
    esac
    printf -v "$key" '%s' "$value"
    count=$((count + 1))
  done < "$LEGACY_STATE_FILE"
  [[ "$count" == 4 ]] \
    && [[ -n "${LEGACY_SYSTEM_ENABLED+x}" && -n "${LEGACY_SYSTEM_ACTIVE+x}" ]] \
    && [[ -n "${LEGACY_USER_ENABLED+x}" && -n "${LEGACY_USER_ACTIVE+x}" ]] || {
      echo "FATAL: invalid legacy transport state" >&2; return 1;
    }
}

write_transition() {
  local direction="$1" temporary="$STATE_DIR/.transitioning.$$"
  [[ "$direction" == enabling || "$direction" == disabling ]] || return 1
  printf 'direction=%s\nstarted_at=%s\n' "$direction" "$(date +%s)" > "$temporary"
  chmod 0600 "$temporary"
  if [[ -z "$ROOT" ]]; then chown "$CLAUDE_USER:$CLAUDE_USER" "$temporary"; fi
  mv -f "$temporary" "$TRANSITIONING_FILE"
}

restore_legacy_state() {
  load_legacy_state || return 1
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

  [[ "$LEGACY_SYSTEM_ACTIVE" == 1 ]] || "$SYSTEMCTL" stop claude-telegram.service 2>/dev/null || true
  [[ "$LEGACY_USER_ACTIVE" == 1 ]] || userctl stop cash-tg-receiver.service 2>/dev/null || true
  # The system service is either the owner poller or the transport-daemon drain.
  # Start it before the user receiver so transport-daemon rollback has no two-poller window.
  [[ "$LEGACY_SYSTEM_ACTIVE" == 0 ]] || "$SYSTEMCTL" start claude-telegram.service
  [[ "$LEGACY_USER_ACTIVE" == 0 ]] || userctl start cash-tg-receiver.service
}

if [[ "$ACTION" == status ]]; then
  if [[ -f "$ENABLED_FILE" ]]; then
    echo "multi-user: enabled"
  elif [[ -f "$TRANSITIONING_FILE" ]]; then
    echo "multi-user: transitioning"
  else
    echo "multi-user: disabled"
  fi
  if [[ -f "$LEGACY_STATE_FILE" ]]; then
    echo "captured legacy state:"
    sed 's/^/  /' "$LEGACY_STATE_FILE"
  else
    echo "captured legacy state: none"
  fi
  for unit in claude-multi-user-receiver.service claude-multi-user-dispatcher.service; do
    if active_user "$unit"; then echo "$unit: active"; else echo "$unit: inactive"; fi
  done
  if active_system; then echo "claude-telegram.service: active"; else echo "claude-telegram.service: inactive"; fi
  if active_user cash-tg-receiver.service; then echo "cash-tg-receiver.service: active"; else echo "cash-tg-receiver.service: inactive"; fi
  exit 0
fi

mkdir -p "$(dirname "$LIFECYCLE_LOCK")"
touch "$LIFECYCLE_LOCK"
chmod 0600 "$LIFECYCLE_LOCK"
if [[ -z "$ROOT" ]]; then chown "$CLAUDE_USER:$CLAUDE_USER" "$LIFECYCLE_LOCK"; fi
exec 9>"$LIFECYCLE_LOCK"
"$FLOCK" -x 9

mkdir -p "$STATE_DIR" "$WORKSPACES_DIR" "$USER_UNIT_DIR" "$ROOT_STATE_DIR"
chmod 0700 "$STATE_DIR" "$WORKSPACES_DIR"
chmod 0700 "$ROOT_STATE_DIR"

if [[ "$ACTION" == disable ]]; then
  if [[ ! -f "$ENABLED_FILE" && ! -f "$TRANSITIONING_FILE" && ! -f "$LEGACY_STATE_FILE" ]]; then
    echo "multi-user already disabled"
    exit 0
  fi
  load_legacy_state
  write_transition disabling
  stop_multi
  restore_legacy_state
  rm -f "$ENABLED_FILE" "$TRANSITIONING_FILE" "$LEGACY_STATE_FILE"
  echo "multi-user disabled; exact legacy service state restored"
  exit 0
fi

if [[ "${MODULE_TRANSPORT_DAEMON:-0}" == 1 ]]; then
  echo "FATAL: MODULE_TRANSPORT_DAEMON=1 conflicts with MODULE_MULTI_USER=1" >&2
  exit 1
fi

ADMIN_CHAT_IDS="${ADMIN_CHAT_IDS:-${OWNER_CHAT_ID:-}}"
if [[ ! "$ADMIN_CHAT_IDS" =~ ^[[:space:]]*-?[0-9]+[[:space:]]*(,[[:space:]]*-?[0-9]+[[:space:]]*)*$ ]]; then
  echo "FATAL: ADMIN_CHAT_IDS must contain numeric Telegram IDs (defaults from OWNER_CHAT_ID)" >&2
  exit 1
fi
ADMIN_CHAT_IDS="${ADMIN_CHAT_IDS//[[:space:]]/}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [[ -z "$TELEGRAM_BOT_TOKEN" && -r "$H/.claude/channels/telegram/.env" ]]; then
  TELEGRAM_BOT_TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$H/.claude/channels/telegram/.env" | head -n1)"
fi
[[ -n "$TELEGRAM_BOT_TOKEN" ]] || { echo "FATAL: TELEGRAM_BOT_TOKEN is required" >&2; exit 1; }
for value in "$TELEGRAM_BOT_TOKEN" "$ADMIN_CHAT_IDS" "${OWNER_CWD:-$H}" \
  "$STATE_DIR" "$WORKSPACES_DIR" "$CLAUDE_EXECUTABLE"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    echo "FATAL: multi-user environment values may not contain newlines" >&2; exit 1;
  }
done
[[ "${GUEST_ACCESS_MODE:-public}" == public || "${GUEST_ACCESS_MODE:-public}" == invite ]] || {
  echo "FATAL: GUEST_ACCESS_MODE must be public or invite" >&2; exit 1;
}
for value in "${MAX_WORKERS:-4}" "${WORKER_TIMEOUT_MS:-300000}" "${MAX_ATTEMPTS:-3}" \
  "${GUEST_RETENTION_DAYS:-7}" "${RETENTION_CLEANUP_INTERVAL_MS:-21600000}"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || { echo "FATAL: invalid numeric multi-user setting" >&2; exit 1; }
done

# Non-destructive preflight only. A live authenticated request belongs in VERIFY.md.
[[ -x "$BUN_EXECUTABLE" ]] || { echo "FATAL: Bun executable not found: $BUN_EXECUTABLE" >&2; exit 1; }
[[ -x "$CLAUDE_EXECUTABLE" ]] || { echo "FATAL: Claude executable not found: $CLAUDE_EXECUTABLE" >&2; exit 1; }
[[ -f "$MOD/guest-system-prompt.md" ]] || { echo "FATAL: guest prompt is missing" >&2; exit 1; }
[[ -f "$MOD/transport-reconcile.sh" ]] || { echo "FATAL: transport reconciler is missing" >&2; exit 1; }
for source in \
  admin config dispatcher dispatcher-main policy receiver receiver-main \
  runtime runtime-config store telegram types worker; do
  [[ -f "$MOD/src/$source.ts" ]] || { echo "FATAL: required source is missing: $source.ts" >&2; exit 1; }
done
"$TIMEOUT" 20 "$RUNUSER" -u "$CLAUDE_USER" -- "$BUN_EXECUTABLE" --version >/dev/null
"$TIMEOUT" 20 "$RUNUSER" -u "$CLAUDE_USER" -- "$CLAUDE_EXECUTABLE" --version >/dev/null
AUTH_STATUS="$("$TIMEOUT" 20 "$RUNUSER" -u "$CLAUDE_USER" -- "$CLAUDE_EXECUTABLE" auth status 2>&1)"
if ! grep -Eq '"loggedIn"[[:space:]]*:[[:space:]]*true|Logged in' <<<"$AUTH_STATUS"; then
  echo "FATAL: Claude is not authenticated; run claude auth status/login first" >&2
  exit 1
fi

mkdir -p "$DEPLOY_DIR/src"
chmod 0700 "$DEPLOY_DIR" "$DEPLOY_DIR/src"
install -m 0600 "$MOD"/src/*.ts "$DEPLOY_DIR/src/"
install -m 0600 "$MOD/guest-system-prompt.md" "$DEPLOY_DIR/guest-system-prompt.md"
install -m 0600 "$MOD/systemd/claude-multi-user-receiver.service" "$USER_UNIT_DIR/claude-multi-user-receiver.service"
install -m 0600 "$MOD/systemd/claude-multi-user-dispatcher.service" "$USER_UNIT_DIR/claude-multi-user-dispatcher.service"
mkdir -p "${ROOT}/usr/local/sbin" "${ROOT}/etc/sudoers.d"
install -m 0755 "$MOD/transport-reconcile.sh" "${ROOT}/usr/local/sbin/claude-multi-user-reconcile"
SUDOERS_TMP="${ROOT}/etc/sudoers.d/.claude-multi-user-reconcile.$$"
cat > "$SUDOERS_TMP" <<'EOF'
claude ALL=(root) NOPASSWD: /usr/local/sbin/claude-multi-user-reconcile reconcile
EOF
chmod 0600 "$SUDOERS_TMP"
mv -f "$SUDOERS_TMP" "${ROOT}/etc/sudoers.d/claude-multi-user-reconcile"
chmod 0440 "${ROOT}/etc/sudoers.d/claude-multi-user-reconcile"

cat > "$DEPLOY_DIR/multi-user.env" <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
ADMIN_CHAT_IDS=$ADMIN_CHAT_IDS
GUEST_ACCESS_MODE=${GUEST_ACCESS_MODE:-public}
STATE_DIR=$STATE_DIR
WORKSPACES_DIR=$WORKSPACES_DIR
OWNER_CWD=${OWNER_CWD:-$H}
GUEST_SYSTEM_PROMPT_PATH=$DEPLOY_DIR/guest-system-prompt.md
CLAUDE_EXECUTABLE=$CLAUDE_EXECUTABLE
MAX_WORKERS=${MAX_WORKERS:-4}
WORKER_TIMEOUT_MS=${WORKER_TIMEOUT_MS:-300000}
JOB_LEASE_MS=${JOB_LEASE_MS:-60000}
JOB_RENEWAL_INTERVAL_MS=${JOB_RENEWAL_INTERVAL_MS:-20000}
DISPATCH_POLL_INTERVAL_MS=${DISPATCH_POLL_INTERVAL_MS:-250}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-3}
RETRY_INITIAL_MS=${RETRY_INITIAL_MS:-1000}
RETRY_MAX_MS=${RETRY_MAX_MS:-60000}
SHUTDOWN_TIMEOUT_MS=${SHUTDOWN_TIMEOUT_MS:-10000}
GUEST_RETENTION_DAYS=${GUEST_RETENTION_DAYS:-7}
RETENTION_CLEANUP_INTERVAL_MS=${RETENTION_CLEANUP_INTERVAL_MS:-21600000}
EOF
chmod 0600 "$DEPLOY_DIR/multi-user.env"
if [[ -z "$ROOT" ]]; then chown -R "$CLAUDE_USER:$CLAUDE_USER" "$DEPLOY_DIR" "$USER_UNIT_DIR"; fi

"$LOGINCTL" enable-linger "$CLAUDE_USER"
if [[ ! -f "$LEGACY_STATE_FILE" ]]; then
  LEGACY_STATE_TMP="$ROOT_STATE_DIR/.previous-transport-state.$$"
  {
    printf 'LEGACY_SYSTEM_ENABLED=%s\n' "$(bool_command enabled_system)"
    printf 'LEGACY_SYSTEM_ACTIVE=%s\n' "$(bool_command active_system)"
    printf 'LEGACY_USER_ENABLED=%s\n' "$(bool_command enabled_user cash-tg-receiver.service)"
    printf 'LEGACY_USER_ACTIVE=%s\n' "$(bool_command active_user cash-tg-receiver.service)"
  } > "$LEGACY_STATE_TMP"
  chmod 0600 "$LEGACY_STATE_TMP"
  mv -f "$LEGACY_STATE_TMP" "$LEGACY_STATE_FILE"
fi
load_legacy_state

enable_failed() {
  status=$?
  trap - ERR
  set +e
  rm -f "$ENABLED_FILE"
  if restore_legacy_state; then
    rm -f "$TRANSITIONING_FILE"
    rm -f "$LEGACY_STATE_FILE"
    echo "FATAL: multi-user enable failed; legacy service state restored" >&2
  else
    echo "FATAL: multi-user enable failed and rollback failed; recover with: $0 disable" >&2
  fi
  exit "$status"
}
trap enable_failed ERR

write_transition enabling
"$SYSTEMCTL" disable --now claude-telegram.service
if ! userctl disable --now cash-tg-receiver.service 2>/dev/null \
   && [[ "$LEGACY_USER_ENABLED" == 1 || "$LEGACY_USER_ACTIVE" == 1 ]]; then
  echo "FATAL: could not disable cash-tg-receiver.service" >&2
  false
fi
userctl daemon-reload
userctl enable --now claude-multi-user-receiver.service
userctl enable --now claude-multi-user-dispatcher.service
ENABLED_TMP="$STATE_DIR/.enabled.$$"
printf '1\n' > "$ENABLED_TMP"
chmod 0600 "$ENABLED_TMP"
mv -f "$ENABLED_TMP" "$ENABLED_FILE"
if [[ -z "$ROOT" ]]; then chown "$CLAUDE_USER:$CLAUDE_USER" "$ENABLED_FILE"; fi
rm -f "$TRANSITIONING_FILE"
trap - ERR
echo "multi-user enabled"
