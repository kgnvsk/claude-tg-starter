#!/usr/bin/env bash
# update.sh — apply one already verified kit revision to an existing agent.
# Run as root from the staged kit selected by the maintenance transaction.
#
# Source-of-truth discipline: you fix things in the REPO, then run THIS to roll the
# fix onto the live agent. You never hand-edit the live agent's files (that recreates
# the drift this kit exists to kill — see README "Source of truth").
#
# What it does (all idempotent):
#   1. validate and use the already staged kit revision
#   2. update Claude Code and Codex with auth validation and rollback
#   3. re-run install-core with the SAME owner inputs (from the saved agent.env)
#   4. verify/update Telegram plugin 0.0.7 and reconcile the reviewed golden
#   5. leave claude-telegram stopped for the outer transaction to verify and start
#
# Usage: follow the stopped transaction in UPGRADING.md. The outer transaction
# creates restart-hold.until, drains every worker, and invokes this script with
# CLAUDE_UPDATE_MAINTENANCE=1. Direct execution is intentionally refused.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: цей скрипт потрібно запускати від root" >&2; exit 1; }
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H=/home/claude
ENV_SAVED=/etc/claude-tg-starter/agent.env
RESTART_HOLD="$H/logs/restart-hold.until"
CORPORATE_STATE_DIR="$H/.claude/channels/telegram"
CORPORATE_DB="$CORPORATE_STATE_DIR/messages.db"
CORPORATE_MARKER="$CORPORATE_STATE_DIR/corporate-isolation-activated"
CORPORATE_STOPPED_PREFLIGHT=/run/claude-corporate-stopped-preflight.json
CORPORATE_ISOLATION_ACTIVATED=0
TG_CORPORATE_SESSIONS_LIVE=""
CLAUDE_UPDATE_MAINTENANCE="${CLAUDE_UPDATE_MAINTENANCE:-0}"
case "$CLAUDE_UPDATE_MAINTENANCE" in
  0|1) ;;
  *)
    echo "FATAL: CLAUDE_UPDATE_MAINTENANCE має дорівнювати 0 або 1" >&2
    exit 1
    ;;
esac
export CLAUDE_UPDATE_MAINTENANCE

case "${1:-}" in
  ""|--license-preflight) ;;
  *) echo "FATAL: unknown update option" >&2; exit 1 ;;
esac
[ "$#" -le 1 ] || { echo "FATAL: unexpected update arguments" >&2; exit 1; }

require_primary_service_stopped() {
  local state status=0
  state="$(systemctl is-active claude-telegram.service 2>/dev/null)" || status=$?
  if [ "$status" -ne 3 ] || [ "$state" != inactive ]; then
    echo "FATAL: перед оновленням claude-telegram.service має бути зупинено" >&2
    return 1
  fi
}

require_valid_restart_hold() {
  local metadata now until
  if [ -L "$RESTART_HOLD" ] || [ ! -f "$RESTART_HOLD" ]; then
    echo "FATAL: перед оновленням потрібен звичайний файл $RESTART_HOLD" >&2
    return 1
  fi
  metadata="$(stat -c '%U:%G:%a' -- "$RESTART_HOLD" 2>/dev/null || true)"
  if [ "$metadata" != "claude:claude:600" ]; then
    echo "FATAL: $RESTART_HOLD має належати claude:claude і мати режим 600" >&2
    return 1
  fi
  until="$(cat -- "$RESTART_HOLD" 2>/dev/null || true)"
  if ! [[ "$until" =~ ^[0-9]{10,}$ ]]; then
    echo "FATAL: $RESTART_HOLD містить некоректний час завершення" >&2
    return 1
  fi
  now="$(date +%s)"
  if [ "$until" -le "$now" ] || [ "$until" -gt $((now + 86400)) ]; then
    echo "FATAL: $RESTART_HOLD має містити майбутній час не далі ніж на 24 години" >&2
    return 1
  fi
}

require_corporate_stopped_preflight() {
  local receipt_digest
  receipt_digest="$(python3 - "$CORPORATE_STOPPED_PREFLIGHT" <<'PY'
import json
import os
import re
import stat
import sys


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate JSON key')
        value[key] = item
    return value


def reject_nonfinite(_value):
    raise ValueError('non-finite JSON number')


path = sys.argv[1]
descriptor = None
try:
    descriptor = os.open(
        path,
        os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != 0
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size > 1_048_576
    ):
        raise ValueError('unsafe receipt')
    with os.fdopen(descriptor, encoding='utf-8') as stream:
        descriptor = None
        value = json.load(
            stream,
            object_pairs_hook=unique_object,
            parse_constant=reject_nonfinite,
        )
    if not isinstance(value, dict):
        raise ValueError('receipt must be an object')
    if type(value.get('schemaVersion')) is not int or value['schemaVersion'] != 1:
        raise ValueError('unsupported receipt schema')
    if value.get('safeToMaintain') is not True:
        raise ValueError('unsafe maintenance receipt')
    if value.get('digestMatches') is not True:
        raise ValueError('unmatched maintenance receipt')
    digest = value.get('digest')
    if not isinstance(digest, str) or re.fullmatch(r'[a-f0-9]{64}', digest) is None:
        raise ValueError('invalid maintenance digest')
    plan = value.get('plan')
    runtime = plan.get('runtime') if isinstance(plan, dict) else None
    if not isinstance(runtime, dict):
        raise ValueError('missing corporate runtime plan')
    if runtime.get('isolationActivated') is not True:
        raise ValueError('corporate isolation is not active')
    if runtime.get('phase2Enabled') is not True:
        raise ValueError('corporate phase two is not active')
    if runtime.get('admissionState') != 'paused':
        raise ValueError('corporate admission is not paused')
    print(digest)
except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
    raise SystemExit(2)
finally:
    if descriptor is not None:
        os.close(descriptor)
PY
)" || {
    echo "FATAL: відсутній або некоректний stopped-preflight receipt" >&2
    return 1
  }

  [ -x "$KIT/modules/telegram-corporate/bin/corporate-control" ] || {
    echo "FATAL: комплект оновлення не має corporate-control" >&2
    return 1
  }
  runuser -u claude -- env HOME="$H" \
    TELEGRAM_STATE_DIR="$CORPORATE_STATE_DIR" \
    CORPORATE_MODULE_DIR="$KIT/modules/telegram-corporate" \
    PATH="$H/.local/bin:$H/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "$KIT/modules/telegram-corporate/bin/corporate-control" \
    preflight --json --expect-digest "$receipt_digest" --expect-paused \
    >/dev/null || {
      echo "FATAL: stopped-preflight receipt більше не відповідає live-стану" >&2
      return 1
    }
}

validate_kit_checkout() {
  local foreign_owner origin status
  [ "$(stat -c %U "$KIT")" = root ] || {
    echo "FATAL: відмовляюся запускати комплект оновлення, що не належить root: $KIT" >&2
    return 1
  }
  foreign_owner="$(find "$KIT" -xdev ! -user root -print -quit)"
  [ -z "$foreign_owner" ] || {
    echo "FATAL: комплект містить шлях, що не належить root: $foreign_owner" >&2
    return 1
  }
  git -C "$KIT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
  origin="$(git -C "$KIT" remote get-url origin 2>/dev/null || true)"
  # What must match is the repository path, not how the host is spelled. A
  # deployer who pins the checkout to a deploy key clones through an ssh alias
  # (git@github-kit:kgnvsk/claude-premium.git); three literal URLs left that
  # person unable to update at all, with no workaround short of editing an ssh
  # config shared with unrelated repositories.
  case "${origin%.git}" in
    */kgnvsk/claude-tg-starter|*:kgnvsk/claude-tg-starter) ;;
    *) echo "FATAL: неочікуваний origin комплекту: ${origin:-відсутній}" >&2; return 1 ;;
  esac
  git -C "$KIT" diff --quiet -- || {
    echo "FATAL: комплект містить змінені відстежувані файли" >&2; return 1;
  }
  git -C "$KIT" diff --cached --quiet -- || {
    echo "FATAL: комплект містить підготовлені до коміту зміни" >&2; return 1;
  }
  status="$(git -C "$KIT" status --porcelain --untracked-files=all)"
  [ -z "$status" ] || {
    echo "FATAL: робоча копія комплекту не чиста" >&2; return 1;
  }
}

validate_kit_checkout
# Wrappers call --license-preflight while the agent is still running. Applying
# an update always verifies again, including retries on existing installations.
python3 "$KIT/assets/lib/agent-license.py" --saved-env "$ENV_SAVED" \
  --bot-env "$H/.claude/channels/telegram/.env"
if [ "${1:-}" = --license-preflight ]; then
  exit 0
fi
if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
  echo "FATAL: update.sh працює лише всередині перевіреного maintenance-вікна з UPGRADING.md" >&2
  exit 1
fi
require_valid_restart_hold
require_primary_service_stopped

# Corporate routing is irreversible once activated. The outer transaction must
# pause it while the service is still alive; this stopped updater only verifies
# the quiesced snapshot. It never performs a late pause or an automatic resume.
if [ -L "$CORPORATE_MARKER" ]; then
  echo "FATAL: marker корпоративної ізоляції не може бути символьним посиланням" >&2
  exit 2
elif [ -e "$CORPORATE_MARKER" ]; then
  [ -f "$CORPORATE_MARKER" ] || {
    echo "FATAL: marker корпоративної ізоляції має бути звичайним файлом" >&2
    exit 2
  }
  [ "$(stat -c '%a' -- "$CORPORATE_MARKER")" = 600 ] || {
    echo "FATAL: marker корпоративної ізоляції має режим 600" >&2
    exit 2
  }
  CORPORATE_ISOLATION_ACTIVATED=1
fi

if [ -L "$CORPORATE_DB" ]; then
  echo "FATAL: база Telegram не може бути символьним посиланням" >&2
  exit 2
elif [ -e "$CORPORATE_DB" ]; then
  [ -f "$CORPORATE_DB" ] || {
    echo "FATAL: база Telegram має бути звичайним файлом" >&2
    exit 2
  }
  corporate_tables="$(sqlite3 -readonly "$CORPORATE_DB" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('corporate_runtime_state','corporate_conversations','conversation_jobs','outbound_chunks','corporate_audit_events');")" || {
      echo "FATAL: не вдалося прочитати стан корпоративної ізоляції" >&2
      exit 2
    }
  case "$corporate_tables" in
    0) ;;
    1|2|3|4|5)
      runtime_table="$(sqlite3 -readonly "$CORPORATE_DB" \
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='corporate_runtime_state';")"
      [ "$runtime_table" = 1 ] || {
        echo "FATAL: неповна схема корпоративної ізоляції потребує ручного відновлення" >&2
        exit 2
      }
      corporate_latch="$(sqlite3 -readonly "$CORPORATE_DB" \
        "SELECT isolation_activated FROM corporate_runtime_state WHERE singleton=1;")" || {
          echo "FATAL: пошкоджений стан активації корпоративних сесій" >&2
          exit 2
        }
      case "$corporate_latch" in
        0) ;;
        1) CORPORATE_ISOLATION_ACTIVATED=1 ;;
        *)
          echo "FATAL: пошкоджений стан активації корпоративних сесій" >&2
          exit 2
          ;;
      esac
      ;;
    *)
      echo "FATAL: пошкоджена схема корпоративних сесій" >&2
      exit 2
      ;;
  esac

  owner_fifo_table="$(sqlite3 -readonly "$CORPORATE_DB" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='pending_inbound_deliveries';")"
  if [ "$owner_fifo_table" = 1 ]; then
    if sqlite3 -readonly "$CORPORATE_DB" "PRAGMA table_info(pending_inbound_deliveries);" \
        | cut -d'|' -f2 | grep -qx state; then
      owner_fifo_pending="$(sqlite3 -readonly "$CORPORATE_DB" \
        "SELECT COUNT(*) FROM pending_inbound_deliveries WHERE state IN ('started','recovering','queued','offered');")"
    else
      # A plugin older than the state column (delivery_id, payload, created_at)
      # keeps a row only while a message is undelivered; the query above made
      # sqlite fail and the whole update stop on such a box (Buhtych, 03.09).
      owner_fifo_pending="$(sqlite3 -readonly "$CORPORATE_DB" \
        "SELECT COUNT(*) FROM pending_inbound_deliveries;")"
    fi
    [ "$owner_fifo_pending" = 0 ] || {
      echo "FATAL: legacy owner FIFO ще не завершив усі вхідні повідомлення" >&2
      exit 2
    }
  fi
fi

if [ "$CORPORATE_ISOLATION_ACTIVATED" = 1 ]; then
  require_corporate_stopped_preflight || exit 2
  [ -x "$H/bin/corporate-control" ] || {
    echo "FATAL: активована корпоративна ізоляція не має corporate-control" >&2
    exit 2
  }
  corporate_status="$(runuser -u claude -- env HOME="$H" \
    PATH="$H/.local/bin:$H/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "$H/bin/corporate-control" status --json)" || {
      echo "FATAL: не вдалося перевірити корпоративну ізоляцію" >&2
      exit 2
    }
  printf '%s' "$corporate_status" | python3 -c '
import json, sys
value = json.load(sys.stdin)
if value.get("isolationActivated") is not True:
    raise SystemExit(2)
if value.get("admissionState") != "paused":
    raise SystemExit(2)
for key in ("activeWorkers", "promptSubmitted", "sendingChunks"):
    if type(value.get(key)) is not int or value[key] != 0:
        raise SystemExit(2)
if value.get("ownerFifoStarted") is not False:
    raise SystemExit(2)
' || {
    echo "FATAL: корпоративні сесії не перебувають у безпечному paused-стані" >&2
    exit 2
  }

  [ -r "$CORPORATE_STATE_DIR/.env" ] || {
    echo "FATAL: активований корпоративний режим втратив live Telegram env" >&2
    exit 2
  }
  TG_CORPORATE_SESSIONS_LIVE="$(python3 "$KIT/assets/lib/merge-env.py" \
    --value "$CORPORATE_STATE_DIR/.env" TG_CORPORATE_SESSIONS)"
  [ "$TG_CORPORATE_SESSIONS_LIVE" = 1 ] || {
    echo "FATAL: активований корпоративний режим втратив TG_CORPORATE_SESSIONS=1" >&2
    exit 2
  }
else
  # A stale saved/profile flag is never activation authority. Legacy routing
  # stays legacy until the owner completes the explicit paused cutover.
  TG_CORPORATE_SESSIONS_LIVE=0
fi

# Keep one transaction-local, root-only SQLite recovery source before the first
# code/package replacement. The outer restore manifest remains authoritative.
if [ -f "$CORPORATE_DB" ]; then
  CORPORATE_BACKUP_DIR="/var/backups/claude-agent/update-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  install -d -m 700 -o root -g root "$CORPORATE_BACKUP_DIR"
  sqlite3 "$CORPORATE_DB" ".backup '$CORPORATE_BACKUP_DIR/messages.db'" || {
    echo "FATAL: не вдалося створити узгоджену резервну копію messages.db" >&2
    exit 2
  }
  chmod 600 "$CORPORATE_BACKUP_DIR/messages.db"
fi

echo "==> Оновлення з комплекту — $KIT"

# ---- 1. use the verified staged kit ----
echo "[1/5] режим обслуговування: використовую перевірену підготовлену ревізію"

echo "[2/5] оновлюю Claude Code і Codex"
env CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" bash "$KIT/assets/bin/update-agent-clis"

# Retire installed experimental multi-user transport before install-core can
# restart the stable poller. Existing deployments already have this root-owned
# reconciler; it validates and restores the exact captured service state. Fail
# closed if its rollback metadata is unavailable instead of risking two pollers.
LEGACY_MULTI_STATE_DIR="$H/multi-user/state"
LEGACY_MULTI_METADATA=/var/lib/claude-multi-user/previous-transport-state
LEGACY_RECONCILE=/usr/local/sbin/claude-multi-user-reconcile
if [[ -f "$LEGACY_MULTI_STATE_DIR/enabled" || -f "$LEGACY_MULTI_STATE_DIR/transitioning" ]]; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
    echo "FATAL: виведи експериментальний багатокористувацький транспорт з експлуатації перед обслуговуванням" >&2
    exit 1
  fi
  echo "      виводжу встановлений експериментальний багатокористувацький транспорт з експлуатації"
  [[ -x "$LEGACY_RECONCILE" ]] || {
    echo "FATAL: відсутній застарілий помічник відкату багатокористувацького режиму: $LEGACY_RECONCILE" >&2
    exit 1
  }
  [[ -r "$LEGACY_MULTI_METADATA" ]] || {
    echo "FATAL: відсутні застарілі метадані відкату багатокористувацького режиму: $LEGACY_MULTI_METADATA" >&2
    exit 1
  }
  transition_tmp="$LEGACY_MULTI_STATE_DIR/.transitioning.$$"
  printf 'direction=disabling\nstarted_at=%s\n' "$(date +%s)" > "$transition_tmp"
  chmod 0600 "$transition_tmp"
  chown claude:claude "$transition_tmp"
  mv -f "$transition_tmp" "$LEGACY_MULTI_STATE_DIR/transitioning"
  "$LEGACY_RECONCILE" reconcile
  if [[ -f "$LEGACY_MULTI_STATE_DIR/enabled" \
     || -f "$LEGACY_MULTI_STATE_DIR/transitioning" \
     || -f "$LEGACY_MULTI_METADATA" ]]; then
    echo "FATAL: точний попередній стан транспорту не відновлено" >&2
    exit 1
  fi
fi

# ---- 2. re-run install-core with the saved owner inputs ----
if [ ! -r "$ENV_SAVED" ]; then
  echo "FATAL: $ENV_SAVED не знайдено." >&2
  echo "  Перше розгортання має зберегти там заповнений agent.env (chmod 600), щоб оновлення" >&2
  echo "  могло повторно сформувати шаблони. Створи його з assets/templates/agent.env.example" >&2
  echo "  зі значеннями цього власника, а потім запусти оновлення ще раз." >&2
  exit 1
fi
echo "[3/5] повторно запускаю install-core зі збереженими значеннями (ідемпотентно)"
SAVED_EXPORTS="$(mktemp)"
cleanup_exports() {
  rm -f "$SAVED_EXPORTS"
}
trap cleanup_exports EXIT
python3 "$KIT/assets/bin/saved-env-export" "$ENV_SAVED" > "$SAVED_EXPORTS"
# Novsky can supply a new key privately when migrating an older saved config.
_requested_license_key="${NOVSKY_LICENSE_KEY:-}"
_requested_bot_token="${TELEGRAM_BOT_TOKEN:-$(python3 "$KIT/assets/lib/merge-env.py" --value "$H/.claude/channels/telegram/.env" TELEGRAM_BOT_TOKEN)}"
while IFS= read -r -d '' name && IFS= read -r -d '' value; do
  printf -v "$name" '%s' "$value"
  export "$name"
done < "$SAVED_EXPORTS"
[ -z "$_requested_license_key" ] || export NOVSKY_LICENSE_KEY="$_requested_license_key"
[ -z "$_requested_bot_token" ] || export TELEGRAM_BOT_TOKEN="$_requested_bot_token"
unset _requested_license_key _requested_bot_token
rm -f "$SAVED_EXPORTS"
SAVED_EXPORTS=""

# The live non-secret profile is the owner's current customization. Values
# changed after onboarding (name, admins, locale, and similar settings) must not
# be rolled back by the older root-saved installer input. Parse the profile as
# data (never source it), and overlay only fields that are explicitly present.
SAVED_EXPORTS="$(mktemp)"
python3 "$KIT/assets/bin/update-safety-check" profile-export \
  --home "$H" > "$SAVED_EXPORTS"
while IFS= read -r -d '' name && IFS= read -r -d '' value; do
  printf -v "$name" '%s' "$value"
  export "$name"
done < "$SAVED_EXPORTS"
rm -f "$SAVED_EXPORTS"
SAVED_EXPORTS=""

# The owner can change semantic-memory consent with a live helper after initial
# onboarding. That live toggle is authoritative during an update; otherwise the
# older root-saved agent.env would silently undo enable/disable on every rollout.
MEMORY_EMBEDDINGS_OPENAI_LIVE=""
if [ -r "$H/.claude/channels/telegram/.env" ]; then
  MEMORY_EMBEDDINGS_OPENAI_LIVE="$(python3 "$KIT/assets/lib/merge-env.py" --value "$H/.claude/channels/telegram/.env" MEMORY_EMBEDDINGS_OPENAI)"
fi
case "$MEMORY_EMBEDDINGS_OPENAI_LIVE" in
  enabled|disabled)
    export MEMORY_EMBEDDINGS_OPENAI="$MEMORY_EMBEDDINGS_OPENAI_LIVE"
    ;;
  "") ;;
  *)
    echo "FATAL: поточне MEMORY_EMBEDDINGS_OPENAI містить недопустиме значення" >&2
    exit 2
    ;;
esac

export TG_CORPORATE_SESSIONS="$TG_CORPORATE_SESSIONS_LIVE"

# Back-compat: boxes deployed before AGENT_NAME existed need either the current
# live profile above or the saved installer value. Never recover the name by
# grepping translated persona prose.
if [ -z "${AGENT_NAME:-}" ]; then
  echo "FATAL: AGENT_NAME не задано ані в поточному профілі, ані в $ENV_SAVED." >&2
  echo "       Заверши onboarding профілю агента й перезапусти оновлення." >&2
  exit 1
fi

env CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" bash "$KIT/assets/install-core.sh"

if python3 "$KIT/assets/lib/product-config.py" \
    --file "$KIT/assets/product/runtime.json" \
    has-feature telegram-corporate-sessions; then
  [ -x "$H/bin/corporate-control" ] || {
    echo "FATAL: комплект вибрав корпоративні сесії, але corporate-control не встановлено" >&2
    exit 2
  }
  runuser -u claude -- env HOME="$H" \
    PATH="$H/.local/bin:$H/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "$H/bin/corporate-control" migrate --no-start || {
      echo "FATAL: не вдалося виконати інертну міграцію корпоративної схеми" >&2
      exit 2
    }
else
  corporate_feature_status=$?
  [ "$corporate_feature_status" -eq 1 ] || {
    echo "FATAL: не вдалося прочитати ознаку корпоративних сесій продукту" >&2
    exit 2
  }
fi

# install-core converges settings and the managed-plugin policy. Apply that
# policy through Claude CLI as well so stale kit-managed plugin caches and
# marketplaces are removed during Premium-to-role or role-to-role updates.
echo "      узгоджую керовані плагіни Claude"
runuser -u claude -- env HOME="$H" CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" "$H/bin/install-plugins"

# ---- 3. converge only the reviewed official Telegram 0.0.7 boundary ----
echo "[4/5] перевіряю Telegram plugin 0.0.7 і накладаю сумісний golden"
require_primary_service_stopped
run_telegram_plugin_cli() {
  local label="$1" status=0
  shift
  runuser -u claude -- env HOME="$H" \
    /usr/bin/timeout --foreground 120s "$@" || status=$?
  if [ "$status" -eq 124 ]; then
    echo "FATAL: $label перевищило 120 секунд; Telegram plugin не оновлено" >&2
    return 1
  fi
  if [ "$status" -ne 0 ]; then
    echo "FATAL: $label завершилося з кодом $status" >&2
    return 1
  fi
}
run_telegram_plugin_cli "оновлення marketplace Telegram" \
  "$H/.local/bin/claude" plugin marketplace update claude-plugins-official
runuser -u claude -- env HOME="$H" \
  "$H/bin/reconcile-telegram-plugin" --marketplace-source-check
run_telegram_plugin_cli "оновлення Telegram plugin" \
  "$H/.local/bin/claude" plugin update telegram@claude-plugins-official --scope user
TELEGRAM_RECONCILE_RECEIPT="$(
  runuser -u claude -- env HOME="$H" \
    "$H/bin/reconcile-telegram-plugin" --apply --json
)"
schema_relative="$(
  printf '%s' "$TELEGRAM_RECONCILE_RECEIPT" | python3 -c '
import json, sys
value = json.load(sys.stdin)
path = value.get("serverRelativePath")
if not isinstance(path, str):
    raise SystemExit(2)
print(path)
'
)"
case "$schema_relative" in
  .claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts) ;;
  *)
    echo "FATAL: reconciler Telegram повернув неочікуваний шлях server.ts" >&2
    exit 1
    ;;
esac
schema_server="$H/$schema_relative"

# Schema changes must be part of the upgrade itself. Claude Code may start a
# channel plugin lazily, so a service restart alone is not a deterministic
# migration boundary. Suppressed mode initializes messages.db but never polls
# Telegram; closed stdin then terminates the one-shot MCP process.
echo "      мігрую схему історії Telegram"
BUN="$H/.local/bin/bun"
if [ ! -x "$BUN" ]; then
  BUN="$H/.bun/bin/bun"
fi
[ -x "$BUN" ] || {
  echo "FATAL: середовище виконання Bun не знайдено в $H/.local/bin або $H/.bun/bin" >&2
  exit 1
}
runuser -u claude -- env HOME="$H" \
  CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" \
  ATARAX_SUPPRESS_TELEGRAM=1 \
  timeout 15s "$BUN" "$schema_server" </dev/null >/dev/null || {
    echo "FATAL: не вдалося мігрувати схему історії Telegram" >&2
    exit 1
  }

# Reconcile daemon transport against the product being installed. Premium
# artifacts select the module and refresh it. Role artifacts omit the feature,
# so an old Premium daemon must be stopped and removed before plugin polling is
# restored later by the outer maintenance transaction starting one poller.
reconcile_transport_daemon() {
  local agent_uid config runtime installer feature_status receiver_status stale_daemon
  local user_manager user_unit user_dropin daemon_code

  config="$KIT/assets/lib/product-config.py"
  runtime="$KIT/assets/product/runtime.json"
  installer="$KIT/modules/transport-daemon/install.sh"
  RECEIVER_DROPIN="${RECEIVER_DROPIN:-/etc/systemd/system/claude-telegram.service.d/transport-daemon.conf}"
  agent_uid="$(id -u claude)"
  user_manager="${RECEIVER_USER_MANAGER:-/run/user/$agent_uid/systemd/private}"
  user_unit="$H/.config/systemd/user/cash-tg-receiver.service"
  user_dropin="$H/.config/systemd/user/cash-tg-receiver.service.d/instance.conf"
  daemon_code="$H/.claude/channels/telegram/tg-receiver-daemon.ts"

  if python3 "$config" --file "$runtime" has-feature transport-daemon; then
    if [ "${CLAUDE_UPDATE_MAINTENANCE:-0}" = 1 ]; then
      echo "FATAL: у режимі обслуговування не можна ввімкнути transport-daemon" >&2
      return 1
    fi
    [ -f "$installer" ] || {
      echo "FATAL: transport-daemon вибрано, але інсталятор відсутній: $installer" >&2
      return 1
    }
    echo "      оновлюю вибраний daemon приймання Telegram"
    env CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" \
      bash "$installer" enable claude
    return
  else
    feature_status=$?
  fi
  [ "$feature_status" -eq 1 ] || {
    echo "FATAL: не вдалося прочитати ознаку transport-daemon продукту з $runtime" >&2
    return 1
  }

  stale_daemon=0
  for path in "$RECEIVER_DROPIN" "$user_unit" "$user_dropin" "$daemon_code"; do
    [ ! -e "$path" ] || stale_daemon=1
  done
  if [ -e "$user_manager" ]; then
    if runuser -u claude -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$agent_uid" \
        systemctl --user is-active --quiet cash-tg-receiver.service; then
      stale_daemon=1
    else
      receiver_status=$?
      case "$receiver_status" in
        3|4) ;;
        *)
          echo "FATAL: не вдалося перевірити стан daemon приймання Telegram" >&2
          return 1
          ;;
      esac
    fi
  fi
  [ "$stale_daemon" -eq 1 ] || return 0

  echo "      видаляю невибраний daemon приймання Telegram"
  if [ -e "$user_manager" ]; then
    runuser -u claude -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$agent_uid" \
      systemctl --user disable --now cash-tg-receiver.service >/dev/null 2>&1 || true
    if runuser -u claude -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$agent_uid" \
        systemctl --user is-active --quiet cash-tg-receiver.service; then
      echo "FATAL: невибраний daemon приймання Telegram досі активний" >&2
      return 1
    else
      receiver_status=$?
      case "$receiver_status" in
        3|4) ;;
        *)
          echo "FATAL: не вдалося підтвердити зупинку daemon приймання Telegram" >&2
          return 1
          ;;
      esac
    fi
  fi
  rm -f "$user_dropin" "$user_unit" "$daemon_code" "$RECEIVER_DROPIN"
  if [ -e "$user_manager" ]; then
    runuser -u claude -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$agent_uid" \
      systemctl --user daemon-reload
  fi
}

reconcile_transport_daemon

# Existing active corporate installations predate the restart nonce. Rotate it
# while admission is paused and the canonical poller is still stopped; the one
# poller started by the outer transaction must inherit this exact token before
# `resume` can reopen employee admission.
if [ "$CORPORATE_ISOLATION_ACTIVATED" = 1 ]; then
  runuser -u claude -- env HOME="$H" \
    PATH="$H/.local/bin:$H/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "$H/bin/corporate-control" live-enable || {
      echo "FATAL: не вдалося підготувати live corporate cutover token" >&2
      exit 2
    }
fi

systemctl daemon-reload || {
  echo "FATAL: не вдалося оновити systemd після узгодження unit-файлів" >&2
  exit 1
}

# ---- 4. leave activation to the outer maintenance transaction ----
require_primary_service_stopped
echo "[5/5] узгодження в режимі обслуговування завершено; основна служба залишається зупиненою"
echo "✅ Оновлення підготовлено в режимі обслуговування. Для контрольованої перевірки запусти лише один poller."
