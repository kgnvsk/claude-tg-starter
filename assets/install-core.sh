#!/usr/bin/env bash
# Deterministic, non-destructive core install for Ubuntu VPS deployments.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: install-core потрібно запускати від root" >&2; exit 1; }
# BEGIN owner freeze preflight
# The owner froze kit updates on this server: refuse before any licence call,
# package work or managed write. A symlink (even a dangling one) or any other
# non-regular marker refuses unopened; a regular one shows its first 2000 bytes.
UPDATES_FROZEN=/etc/claude-tg-starter/updates-frozen
if [ -L "$UPDATES_FROZEN" ] || [ -e "$UPDATES_FROZEN" ]; then
  FROZEN_REASON=""
  if [ ! -L "$UPDATES_FROZEN" ] && [ -f "$UPDATES_FROZEN" ]; then
    FROZEN_REASON="$(head -c 2000 -- "$UPDATES_FROZEN" 2>/dev/null || true)"
  fi
  echo "FATAL: оновлення кита на цьому сервері заморожено власником${FROZEN_REASON:+: $FROZEN_REASON}" >&2
  exit 3
fi
# END owner freeze preflight
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCT_CONFIG="$KIT/assets/lib/product-config.py"
CLAUDE_UPDATE_MAINTENANCE="${CLAUDE_UPDATE_MAINTENANCE:-0}"
case "$CLAUDE_UPDATE_MAINTENANCE" in
  0|1) ;;
  *)
    echo "FATAL: CLAUDE_UPDATE_MAINTENANCE має дорівнювати 0 або 1" >&2
    exit 1
    ;;
esac
export CLAUDE_UPDATE_MAINTENANCE

product_has_feature() {
  local status=0
  python3 "$PRODUCT_CONFIG" has-feature "$1" || status=$?
  if [ "$status" -eq 2 ]; then
    echo "FATAL: конфігурація продукту некоректна" >&2
    exit 2
  fi
  return "$status"
}

# Instance identity. AGENT_USER=claude (default) is the primary agent with the
# historical unit name; any other value installs an ADDITIONAL instance on the
# same box (own unix user, home, crontab, unit claude-telegram@<user>.service) —
# this is how a team runs N parallel bots on one server.
AGENT_USER="${AGENT_USER:-claude}"
printf '%s' "$AGENT_USER" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' \
  || { echo "FATAL: некоректне значення AGENT_USER '$AGENT_USER'" >&2; exit 1; }
case "$AGENT_USER" in
  root|claude-browser|streampost)
    echo "FATAL: значення AGENT_USER '$AGENT_USER' зарезервовано" >&2; exit 1 ;;
esac
H=/home/$AGENT_USER
NOVSKY_ALLOW_PINNED_LEGACY_SHARED_CONTEXT="${NOVSKY_ALLOW_PINNED_LEGACY_SHARED_CONTEXT:-0}"
case "$NOVSKY_ALLOW_PINNED_LEGACY_SHARED_CONTEXT" in
  0|1) ;;
  *) echo "FATAL: некоректний режим резервного контексту" >&2; exit 1 ;;
esac
legacy_context_args=()
if [ "$NOVSKY_ALLOW_PINNED_LEGACY_SHARED_CONTEXT" = 1 ]; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ] || [ "$AGENT_USER" != "claude-8709793308" ]; then
    echo "FATAL: старий спільний контекст дозволено лише для обслуговування тестового агента" >&2
    exit 1
  fi
  legacy_context_args+=(--allow-pinned-legacy-shared-context)
fi
CONFIG_DIR=/etc/claude-tg-starter
if [ "$AGENT_USER" = claude ]; then
  AGENT_SERVICE=claude-telegram.service
  CONFIG_FILE=$CONFIG_DIR/agent.env
  SUDOERS_FILE=/etc/sudoers.d/claude-telegram-heal
else
  AGENT_SERVICE="claude-telegram@$AGENT_USER.service"
  CONFIG_FILE=$CONFIG_DIR/agent-$AGENT_USER.env
  SUDOERS_FILE=/etc/sudoers.d/claude-telegram-heal-$AGENT_USER
fi

# The owner's Telegram username is informational only: rights come from the numeric
# ID, and not every owner has a username at all. It may be empty.
for name in AGENT_NAME OWNER_NAME OWNER_CHAT_ID BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN; do
  [ -n "${!name:-}" ] || { echo "FATAL: обов’язкову змінну середовища $name не задано" >&2; exit 1; }
done

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
MEMORY_EMBEDDINGS_OPENAI_INPUT="${MEMORY_EMBEDDINGS_OPENAI:-}"
MEMORY_EMBEDDINGS_OPENAI="${MEMORY_EMBEDDINGS_OPENAI:-disabled}"
RECALL_API_KEY="${RECALL_API_KEY:-}"
RECALL_REGION_INPUT="${RECALL_REGION:-}"   # explicit operator value this run, if any
RECALL_REGION="${RECALL_REGION:-eu-central-1}"
TG_DELIVERY_AUTHORITY_INPUT="${TG_DELIVERY_AUTHORITY:-}"   # explicit operator value this run, if any
TG_DELIVERY_AUTHORITY="${TG_DELIVERY_AUTHORITY:-guard}"
CALENDAR_EMAIL="${CALENDAR_EMAIL:-}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
VAULT_LOCALE="${VAULT_LOCALE:-en-US}"
OWNER_NOTICE_LOCALE="${OWNER_NOTICE_LOCALE:-uk}"
case "$OWNER_NOTICE_LOCALE" in
  uk|ru) ;;
  *) echo "FATAL: OWNER_NOTICE_LOCALE має бути uk або ru" >&2; exit 1 ;;
esac
if [ -z "${VOICE_SETUP_STATUS:-}" ]; then
  if [ -n "$OPENAI_API_KEY" ]; then
    VOICE_SETUP_STATUS=configured
  else
    VOICE_SETUP_STATUS=deferred
  fi
fi
ADDITIONAL_ADMIN_CHAT_IDS="${ADDITIONAL_ADMIN_CHAT_IDS:-}"
ALERT_COPY_CHAT_IDS="${ALERT_COPY_CHAT_IDS:-}"
if [[ -n "$ALERT_COPY_CHAT_IDS" && ! "$ALERT_COPY_CHAT_IDS" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; then
  echo "FATAL: ALERT_COPY_CHAT_IDS має містити Telegram chat ID через кому" >&2
  exit 1
fi
TG_DROP_PENDING_ON_BOOT="${TG_DROP_PENDING_ON_BOOT:-0}"
TG_CORPORATE_SESSIONS="${TG_CORPORATE_SESSIONS:-0}"
case "$TG_CORPORATE_SESSIONS" in
  0|1) ;;
  *)
    echo "FATAL: TG_CORPORATE_SESSIONS має бути 0 або 1" >&2
    exit 1
    ;;
esac
MODULE_DESIGN_PACK="${MODULE_DESIGN_PACK:-0}"
MODULE_CHANNEL_PUBLISH="${MODULE_CHANNEL_PUBLISH:-0}"
MODULE_SOCIAL_BROWSER="${MODULE_SOCIAL_BROWSER:-0}"
MODULE_TRANSPORT_DAEMON="${MODULE_TRANSPORT_DAEMON:-0}"
MODULE_VAULT_WEB="${MODULE_VAULT_WEB:-0}"
MODULE_INSTAGRAM_DM="${MODULE_INSTAGRAM_DM:-0}"
MODULE_YOUTUBE_COMMENTS="${MODULE_YOUTUBE_COMMENTS:-0}"
# Corporate sessions are part of the product, so the module is on by default.
# 0 keeps an installation that never activated corporate routing on a host
# that cannot give the agent user namespaces; once activated it cannot be skipped.
MODULE_TELEGRAM_CORPORATE="${MODULE_TELEGRAM_CORPORATE:-1}"
CHANNEL_ID="${CHANNEL_ID:-}"
SITE_PASSWORD="${SITE_PASSWORD:-}"
DEPLOY_DATE="$(date +%F)"

if [ "$MODULE_INSTAGRAM_DM" = 1 ] && ! product_has_feature instagram-dm; then
  echo "INFO: модуль Instagram DM недоступний у цьому продукті; вимикаю його"
  MODULE_INSTAGRAM_DM=0
fi
if [ "$MODULE_CHANNEL_PUBLISH" = 1 ] && ! product_has_feature channel-publishing; then
  echo "INFO: публікація в канал недоступна в цьому продукті; вимикаю її"
  MODULE_CHANNEL_PUBLISH=0
fi
if [ "$MODULE_YOUTUBE_COMMENTS" = 1 ] && ! product_has_feature youtube-comments; then
  echo "INFO: модуль коментарів YouTube недоступний у цьому продукті; вимикаю його"
  MODULE_YOUTUBE_COMMENTS=0
fi
if [ "$MODULE_TELEGRAM_CORPORATE" = 1 ] && ! product_has_feature telegram-corporate-sessions; then
  MODULE_TELEGRAM_CORPORATE=0
fi
if [ "$MODULE_TELEGRAM_CORPORATE" != 1 ] && product_has_feature telegram-corporate-sessions; then
  CORPORATE_ACTIVATION_MARKER="$H/.claude/channels/telegram/corporate-isolation-activated"
  if [ -e "$CORPORATE_ACTIVATION_MARKER" ] || [ -L "$CORPORATE_ACTIVATION_MARKER" ]; then
    echo "FATAL: корпоративну ізоляцію вже активовано — MODULE_TELEGRAM_CORPORATE=0 неприпустимий" >&2
    exit 1
  fi
  echo "INFO: MODULE_TELEGRAM_CORPORATE=0 — корпоративний модуль не встановлюється, корпоративний режим лишається вимкненим"
fi
if [ "$MODULE_CHANNEL_PUBLISH" = 1 ]; then
  [[ "$CHANNEL_ID" =~ ^-100[0-9]{6,}$ ]] || {
    echo "FATAL: для публікації CHANNEL_ID має виглядати як -100..." >&2
    exit 1
  }
fi
# BEGIN optional module maintenance guard
# These installers write outside managed-runtime.json and have no recorded
# previous-kit baseline. Replaying them would silently replace owner edits.
# Individual module migration needs its own reviewed comparison first.
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  for optional_name in MODULE_CHANNEL_PUBLISH MODULE_INSTAGRAM_DM MODULE_YOUTUBE_COMMENTS; do
    if [ "${!optional_name:-0}" = 1 ]; then
      echo "FATAL: $optional_name увімкнено; оновлення комплекту потребує окремої перевірки змін модуля" >&2
      exit 1
    fi
  done
fi
# END optional module maintenance guard
# The daemon transport is retired. On Claude Code 2.1.208+ the channel plugin no
# longer starts in that mode: the daemon keeps filing incoming updates and nothing
# ever drains them, so the bot answers nobody while sending (crons, alerts) still
# works — which reads as "alive" from every angle. It cost Cash an evening of
# unanswered messages on 2026-07-29, and the watchdog made it worse by restarting
# every four minutes. Refuse the flag instead of honouring it; update.sh removes
# the daemon, its unit and its drop-in from boxes that already have it.
if [ "$MODULE_TRANSPORT_DAEMON" = 1 ]; then
  echo "INFO: транспорт через daemon виведено з експлуатації (у Claude Code 2.1.208+"
  echo "      плагін каналу не запускається, а вхідні повідомлення не читаються)."
  echo "      Залишаю стандартний транспорт; додаткові дії не потрібні."
  MODULE_TRANSPORT_DAEMON=0
fi

export AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ALERT_COPY_CHAT_IDS BOT_USERNAME TIMEZONE CALENDAR_EMAIL DEPLOY_DATE AGENT_USER AGENT_SERVICE

validate_install_kit() {
  local foreign_owner linked_path own_kit
  [ "$(stat -c %U "$KIT")" = root ] || {
    echo "FATAL: комплект розгортання має належати root: $KIT" >&2
    return 1
  }
  foreign_owner="$(find "$KIT" -xdev ! -user root -print -quit)"
  [ -z "$foreign_owner" ] || {
    echo "FATAL: комплект розгортання містить шлях, що не належить root: $foreign_owner" >&2
    return 1
  }
  linked_path="$(find "$KIT" -xdev -type l -print -quit)"
  [ -z "$linked_path" ] || {
    echo "FATAL: комплект розгортання містить символічне посилання: $linked_path" >&2
    return 1
  }
  # One kit folder per agent: the primary runs /opt/claude-tg-starter and every
  # other agent /opt/claude-tg-starter@<user>, so no bot runs a neighbour's kit.
  own_kit=/opt/claude-tg-starter
  [ "$AGENT_USER" = claude ] || own_kit="$own_kit@$AGENT_USER"
  # /opt itself may be a symlink; the kit must be the real folder under it.
  [ "$(cd "$KIT" && pwd -P)" = "$(cd "${own_kit%/*}" && pwd -P)/${own_kit##*/}" ] || {
    echo "FATAL: комплект агента $AGENT_USER має запускатися з $own_kit; оновіть Novsky до останньої версії" >&2
    return 1
  }
}

validate_install_kit

render_template() {
  local source="$1" destination="$2"
  shift 2
  runuser -u "$AGENT_USER" -- env \
    AGENT_NAME="$AGENT_NAME" OWNER_NAME="$OWNER_NAME" \
    OWNER_TG_USERNAME="$OWNER_TG_USERNAME" OWNER_CHAT_ID="$OWNER_CHAT_ID" \
    BOT_USERNAME="$BOT_USERNAME" TIMEZONE="$TIMEZONE" \
    CALENDAR_EMAIL="$CALENDAR_EMAIL" DEPLOY_DATE="$DEPLOY_DATE" \
    AGENT_HOME="$H" AGENT_SERVICE="$AGENT_SERVICE" AGENT_USER="$AGENT_USER" \
    python3 "$KIT/assets/lib/render-template.py" "$@" "$source" "$destination"
}
source "$KIT/assets/lib/persona-baseline.sh"

# BEGIN instance persona preflight
# Keep separate hashes for rendered primary personas. A missing hash permits
# only an exact current-template match; a changed template needs proof that
# the installed copy is still the last accepted managed copy.
PERSONA_BASELINE_CLAUDE="$H/.claude/product/CLAUDE.premium.sha256"
PERSONA_BASELINE_PRODUCT="$H/.claude/product/CLAUDE.product.sha256"
PERSONA_EXISTING=0
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] \
    || [ -e "$H/.claude/CLAUDE.premium.md" ] || [ -L "$H/.claude/CLAUDE.premium.md" ] \
    || [ -e "$H/.claude/CLAUDE.product.md" ] || [ -L "$H/.claude/CLAUDE.product.md" ]; then
  PERSONA_EXISTING=1
fi
ROLE_PROFILE="$KIT/assets/product/ROLE.md"
if [ -n "${AGENT_ROLE:-}" ]; then
  ROLE_PROFILE="$KIT/assets/roles/$AGENT_ROLE/ROLE.md"
  [ -f "$ROLE_PROFILE" ] || {
    echo "FATAL: невідома роль агента; оновлення зупинено" >&2
    exit 1
  }
fi
if [ "$PERSONA_EXISTING" = 1 ]; then
  guard_managed_persona check "$KIT/assets/templates/CLAUDE.md.template" \
    "$H/.claude/CLAUDE.premium.md" "$PERSONA_BASELINE_CLAUDE"
  guard_managed_persona check "$ROLE_PROFILE" \
    "$H/.claude/CLAUDE.product.md" "$PERSONA_BASELINE_PRODUCT"
fi
# END instance persona preflight

# BEGIN shared browser helper preflight
# The helper and its state belong to the primary and serve every bot on the
# server. Another bot's update never writes them; it only warns when the host
# copy differs from its own kit's.
warn_shared_browser_helper() {
  [ -d /var/lib/claude-browser/recovery ] \
    && [ ! -L /var/lib/claude-browser/recovery ] \
    && [ -f /usr/local/sbin/claude-browser-recover ] \
    && [ ! -L /usr/local/sbin/claude-browser-recover ] \
    && cmp -s "${KIT}/assets/bin/claude-browser-recover" /usr/local/sbin/claude-browser-recover \
    || echo "WARN: спільний browser helper відрізняється від комплекту агента $AGENT_USER; ним керує основний агент, оновлення триває" >&2
}
if product_has_feature browser; then
  [ ! -L /var/lib/claude-browser/recovery ] || {
    echo "FATAL: каталог стану відновлення браузера не може бути символічним посиланням" >&2
    exit 1
  }
fi
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] && [ "$AGENT_USER" != claude ] \
    && product_has_feature browser; then
  warn_shared_browser_helper
fi
# END shared browser helper preflight

# BEGIN instance system context preflight
SYSTEMD_DIR=/etc/systemd/system
INSTANCE_UNIT_TARGET="$SYSTEMD_DIR/$AGENT_SERVICE"
INSTANCE_LOGROTATE_TARGET="/etc/logrotate.d/cash-$AGENT_USER"
verify_instance_system_context() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] && [ "$AGENT_USER" != claude ] || return 0
  local fragment candidate
  candidate="$KIT/assets/systemd/claude-telegram@.service"
  fragment="$(systemctl show "$AGENT_SERVICE" --property=FragmentPath --value --no-pager 2>/dev/null)" || return 1
  case "$fragment" in
    "$SYSTEMD_DIR/claude-telegram@.service"|"$INSTANCE_UNIT_TARGET") ;;
    *) echo "FATAL: служба instance має неочікуване джерело" >&2; return 1 ;;
  esac
  if [ ! -f "$fragment" ] || [ -L "$fragment" ] || ! cmp -s "$candidate" "$fragment"; then
    echo "FATAL: unit instance відрізняється від комплекту; потрібне ручне узгодження" >&2
    return 1
  fi
  if [ -e "$INSTANCE_UNIT_TARGET" ] || [ -L "$INSTANCE_UNIT_TARGET" ]; then
    if [ ! -f "$INSTANCE_UNIT_TARGET" ] || [ -L "$INSTANCE_UNIT_TARGET" ] \
        || ! cmp -s "$candidate" "$INSTANCE_UNIT_TARGET"; then
      echo "FATAL: налаштування unit instance змінено; перезапис заборонено" >&2
      return 1
    fi
  fi
  if [ -e "$INSTANCE_LOGROTATE_TARGET" ] || [ -L "$INSTANCE_LOGROTATE_TARGET" ]; then
    if [ ! -f "$INSTANCE_LOGROTATE_TARGET" ] || [ -L "$INSTANCE_LOGROTATE_TARGET" ] \
        || ! sed "s|/home/claude|$H|g" "$KIT/assets/systemd/logrotate-cash" \
             | cmp -s - "$INSTANCE_LOGROTATE_TARGET"; then
      echo "FATAL: налаштування logrotate instance змінено; перезапис заборонено" >&2
      return 1
    fi
  fi
}
verify_instance_system_context
# END instance system context preflight

# Maintenance cannot rewrite the shared root backup context: those paths are
# outside the agent-home rollback. Fail before this installer writes anything.
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  python3 -B "$KIT/assets/lib/install-backup-context.py" --check-current \
    --allow-maintenance-hold "${legacy_context_args[@]}" --home "$H" --user "$AGENT_USER" \
    --unit "$AGENT_SERVICE" --engine claude >/dev/null || {
      echo "FATAL: backup context needs a reviewed migration before kit maintenance" >&2
      exit 2
    }
fi

# Check the installed runtime identity before writing templates, credentials or
# cron entries. A wizard may already have replaced the root input agent.env.
_installed_token="$(python3 "$KIT/assets/lib/merge-env.py" --value "$H/.claude/channels/telegram/.env" TELEGRAM_BOT_TOKEN)"
if [ -n "$_installed_token" ] && [ "${_installed_token%%:*}" != "${TELEGRAM_BOT_TOKEN%%:*}" ]; then
  echo "FATAL: каталог $H належить іншому Telegram-боту; для нового агента задай окремий AGENT_USER" >&2
  exit 1
fi
unset _installed_token
# Every paid install and retry verifies this bot before package or runtime writes.
NOVSKY_LICENSE_KEY="${NOVSKY_LICENSE_KEY:-$(python3 "$KIT/assets/lib/merge-env.py" --value "$CONFIG_FILE" NOVSKY_LICENSE_KEY)}"
export NOVSKY_LICENSE_KEY
python3 "$KIT/assets/lib/agent-license.py" --saved-env "$CONFIG_FILE"
# The late corporate-module check also guards a restart during installation;
# this early check prevents partial overwrites even for non-corporate kits.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$AGENT_SERVICE" 2>/dev/null; then
  echo "FATAL: перед зміною ядра зупини $AGENT_SERVICE через maintenance-оновлення (UPGRADING.md)" >&2
  exit 1
fi

# BEGIN Vercel maintenance preflight
# A kit update preserves the owner's installed CLI. Check it before package or
# runtime writes; replacing a missing/broken executable is a separate operation.
verify_preserved_vercel_cli() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] || return 0
  local feature_status=0 version cli="$H/.npm-global/bin/vercel"
  if product_has_feature vercel; then
    :
  else
    feature_status=$?
    [ "$feature_status" -eq 1 ] && return 0
    return "$feature_status"
  fi
  [ -x "$cli" ] || {
    echo "FATAL: встановлений Vercel CLI відсутній або не виконується; оновлення комплекту зупинено" >&2
    return 1
  }
  version="$(runuser -u "$AGENT_USER" -- env HOME="$H" \
    VERCEL_TELEMETRY_DISABLED=1 NO_UPDATE_NOTIFIER=1 \
    /usr/bin/timeout --foreground 30s "$cli" --version 2>/dev/null)" || {
      echo "FATAL: встановлений Vercel CLI не відповідає; оновлення комплекту зупинено" >&2
      return 1
    }
  [[ "$version" =~ [0-9]+\.[0-9]+\.[0-9]+ ]] || {
    echo "FATAL: версію встановленого Vercel CLI не вдалося перевірити" >&2
    return 1
  }
}
verify_preserved_vercel_cli
# END Vercel maintenance preflight

# BEGIN maintenance dependency preflight
# Maintenance keeps the owner's installed tools. A missing dependency is a
# separate repair, not a reason to fetch a moving package halfway through an
# agent update. Run this before any runtime or configuration writes.
maintenance_require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "FATAL: для оновлення відсутня команда $1; віднови її окремо і повтори" >&2
    return 1
  }
}
maintenance_require_python() {
  local name="$1" import_check="$2" python="$H/.venvs/$1/bin/python"
  [ -x "$python" ] || {
    echo "FATAL: для оновлення відсутнє середовище $name; віднови його окремо і повтори" >&2
    return 1
  }
  runuser -u "$AGENT_USER" -- "$python" -I -B -c "$import_check" >/dev/null 2>&1 || {
    echo "FATAL: середовище $name не працює; оновлення комплекту зупинено" >&2
    return 1
  }
}
verify_maintenance_dependencies() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] || return 0
  maintenance_require_command gh || return 1
  maintenance_require_command sqlite3 || return 1
  /usr/bin/python3 -B -c 'import numpy, markdown' >/dev/null 2>&1 || {
    echo "FATAL: системні Python-залежності пам’яті відсутні; оновлення комплекту зупинено" >&2
    return 1
  }
  if product_has_feature telegram-corporate-sessions; then
    maintenance_require_python heif 'from PIL import Image; from pillow_heif import register_heif_opener' || return 1
    if [ "$MODULE_TELEGRAM_CORPORATE" = 1 ]; then
      maintenance_require_command bwrap || return 1
      maintenance_require_command socat || return 1
    fi
  fi
  if product_has_feature sql-readonly; then
    maintenance_require_python bigquery 'from google.cloud import bigquery' || return 1
  fi
  if product_has_feature finance-data; then
    maintenance_require_python finance 'import yfinance' || return 1
  fi
  if product_has_feature spreadsheets; then
    maintenance_require_python spreadsheets 'import openpyxl, xlsxwriter' || return 1
  fi
  if product_has_feature media-downloads; then
    [ -x "$H/.local/bin/yt-dlp" ] && [ -x "$H/.local/bin/deno" ] || {
      echo "FATAL: yt-dlp або Deno відсутній; оновлення комплекту зупинено" >&2
      return 1
    }
  fi
  if [ "$MODULE_INSTAGRAM_DM" = 1 ]; then
    maintenance_require_python instagram-dm 'import fastapi, uvicorn' || return 1
  fi
  if product_has_feature video-edit; then
    AGENT_USER="$AGENT_USER" CLAUDE_UPDATE_MAINTENANCE=1 \
      bash "$KIT/scripts/install-video-edit.sh" --preflight-maintenance || return 1
  fi
}
verify_maintenance_dependencies
# END maintenance dependency preflight

# BEGIN external side-effect maintenance preflight
# The retired Graphify extension may contain owner data, and a missing gog
# would make the installer download into /usr/local/bin. Neither action belongs
# to a kit update. Decide before package, runtime, or configuration writes.
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  if [ -e /opt/claude-graphify ] || [ -L /opt/claude-graphify ]; then
    echo "FATAL: Graphify вже встановлено; перевір його дані окремо перед оновленням комплекту" >&2
    exit 1
  fi
  if product_has_feature google-workspace && ! command -v gog >/dev/null 2>&1; then
    echo "FATAL: gog відсутній; віднови Google CLI окремо перед оновленням комплекту" >&2
    exit 1
  fi
fi
# END external side-effect maintenance preflight

# BEGIN Starter foundation preflight
STARTER_FOUNDATION_REQUIRED=0
validate_starter_foundation() {
  local product_id
  product_id="$(python3 "$PRODUCT_CONFIG" get productId)" || return 2
  [ "$product_id" = starter ] || return 0
  # A completed existing agent keeps its deliberate feature settings. Retrying
  # an interrupted first install must still pass the new-agent foundation.
  if [ ! -e "$H/.claude/product/starter-foundation-pending" ] && {
    [ -e "$H/.claude/product/runtime.json" ] ||
    [ -e "$H/.claude/channels/telegram/.env" ] || [ -e "$H/CLAUDE.md" ];
  }; then
    return 0
  fi
  if [ -z "${OPENAI_API_KEY//[[:space:]]/}" ]; then
    echo "FATAL: Novsky Starter потребує OpenAI API key для голосових і векторної пам’яті. Додай ключ у Novsky та повтори встановлення." >&2
    return 1
  fi
  if [ "$MEMORY_EMBEDDINGS_OPENAI" != enabled ]; then
    echo "FATAL: Novsky Starter потребує ввімкненої векторної пам’яті. Підтвердь її налаштування в Novsky (MEMORY_EMBEDDINGS_OPENAI=enabled)." >&2
    return 1
  fi
  STARTER_FOUNDATION_REQUIRED=1
}
# END Starter foundation preflight
validate_starter_foundation

# The stuck-turn watchdog queries the message log through the sqlite3 CLI and is
# silently inert without it. onboard.sh installs no system packages, so a bare
# check would dead-end a customer install; take the package ourselves (we are
# root here) and only fail when it is still unavailable afterwards.
if ! command -v gh >/dev/null 2>&1; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 update -qq
    DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y -q gh
  fi
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q sqlite3 >/dev/null 2>&1 || true
  fi
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "FATAL: sqlite3 відсутній, і його не вдалося встановити; виконай apt-get install -y sqlite3" >&2
    exit 1
  }
fi

# Native corporate sessions use Claude Code's OS sandbox. Provision ordinary
# runtime packages for those kits only; host security policy is not changed here.
if product_has_feature telegram-corporate-sessions && [ "$MODULE_TELEGRAM_CORPORATE" = 1 ]; then
  if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap socat >/dev/null 2>&1 || true
    fi
  fi
  for dependency in bwrap socat; do
    command -v "$dependency" >/dev/null 2>&1 || {
      echo "FATAL: bubblewrap/socat відсутні, і їх не вдалося встановити; виконай apt-get install -y bubblewrap socat" >&2
      exit 1
    }
  done
  # The module installer repeats this probe, but by then ~/bin and the crontab
  # are already rewritten (18.09.2026). Prove the host policy while nothing has
  # been touched. On a first install the agent user does not exist yet; the
  # installer's own probe still guards the module swap there.
  if id "$AGENT_USER" >/dev/null 2>&1 \
    && ! runuser -u "$AGENT_USER" -- env HOME="$H" bwrap --unshare-user --unshare-pid --unshare-net \
      --ro-bind / / --proc /proc --dev /dev -- /usr/bin/true >/dev/null 2>&1; then
    echo "FATAL: перевірка Linux user namespaces для $AGENT_USER не пройшла — корпоративний модуль не встановиться. Адміністратор має погодити профіль modules/telegram-corporate/native-bwrap.apparmor для /usr/bin/bwrap (UPGRADING.md); не вимикай захист хоста. Інсталяцію не змінено." >&2
    exit 1
  fi
fi

# Semantic memory runs from the system Python. install-base provisions numpy on
# guided clean installs; this convergence path also covers direct product
# installs and upgrades from releases that predate vector search.
if ! /usr/bin/python3 -c 'import numpy' >/dev/null 2>&1; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-numpy >/dev/null 2>&1 || true
  fi
fi
/usr/bin/python3 -c 'import numpy' >/dev/null 2>&1 || {
  echo "FATAL: python3-numpy відсутній, і його не вдалося встановити" >&2
  exit 1
}

# Веб-звіт рендерить нотатки вольта в HTML. Системний Python на 24.04 зовнішньо
# керований, тому пакет ставимо тут, а не pip-ом під час першого запуску.
if ! /usr/bin/python3 -c 'import markdown' >/dev/null 2>&1; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-markdown >/dev/null 2>&1 || true
  fi
fi
/usr/bin/python3 -c 'import markdown' >/dev/null 2>&1 || {
  echo "FATAL: python3-markdown відсутній, і його не вдалося встановити" >&2
  exit 1
}

write_shell_value() {
  local file="$1" name="$2"
  printf '%s=%q\n' "$name" "${!name-}" >> "$file"
}

read_channel_value() {
  local file="$1" name="$2"
  [ -r "$file" ] || return 0
  python3 "$KIT/assets/lib/merge-env.py" --value "$file" "$name"
}

copy_tree_no_clobber() {
  local source="$1" destination="$2"
  if cp --help 2>&1 | grep -q -- '--update='; then
    runuser -u "$AGENT_USER" -- cp -r --no-preserve=ownership --preserve=mode,timestamps \
      --update=none "$source/." "$destination/"
  else
    runuser -u "$AGENT_USER" -- cp -rn --no-preserve=ownership "$source/." "$destination/"
  fi
}


# BEGIN limit recovery initialization helpers
# Absorb a short scheduler-boundary overlap, but never let installation advance
# to the managed cron block unless initialize returns canonical success.
LIMIT_RECOVERY_INITIALIZE_ATTEMPTS=5
LIMIT_RECOVERY_INITIALIZE_RETRY_SECONDS=1

initialize_limit_recovery_mode() {
  local mode="$1" attempt status=75
  for ((attempt = 1; attempt <= LIMIT_RECOVERY_INITIALIZE_ATTEMPTS; attempt++)); do
    status=0
    runuser -u "$AGENT_USER" -- env \
      HOME="$H" CLAUDE_TELEGRAM_SERVICE="$AGENT_SERVICE" \
      TG_DROP_PENDING_ON_BOOT="$TG_DROP_PENDING_ON_BOOT" \
      "$H/bin/claude-limit-recovery" "$mode" || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$status" -ne 75 ]; then
      echo "FATAL: не вдалося ініціалізувати відновлення після ліміту Claude (статус $status)" >&2
      return "$status"
    fi
    if [ "$attempt" -lt "$LIMIT_RECOVERY_INITIALIZE_ATTEMPTS" ]; then
      sleep "$LIMIT_RECOVERY_INITIALIZE_RETRY_SECONDS"
    fi
  done
  echo "FATAL: блокування ініціалізації відновлення після ліміту Claude залишилося зайнятим" >&2
  return 1
}

initialize_limit_recovery_state() {
  initialize_limit_recovery_mode --initialize || return $?
  initialize_limit_recovery_mode --initialize-notices
}
# END limit recovery initialization helpers

echo "[1/7] користувач і каталоги"
id "$AGENT_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$AGENT_USER"
install -d -o "$AGENT_USER" -g "$AGENT_USER" "$H/bin" "$H/obsidian-vault" \
  "$H/.claude" "$H/.claude/skills" "$H/.claude/agents" \
  "$H/.claude/channels/telegram" "$H/.claude/product"
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 700 \
  "$H/logs" "$H/.claude/memory" "$H/.claude/goals" "$H/.claude/projects" "$H/backups" \
  "$H/telegram-outbox" \
  "$H/.cache" "$H/.cache/codex-image" "$H/.cache/codex-image/prompts" \
  "$H/.cache/video-edit" \
  "$H/obsidian-vault/learning/pending" "$H/obsidian-vault/learning/history"
install -d -m 700 "$CONFIG_DIR"
if [ "$PERSONA_EXISTING" = 1 ]; then
  # Preflight proved both files before the first managed runtime write. Seed
  # hashes only from an exact former kit render, then let the normal guard
  # reconcile them with the candidate template.
  guard_managed_persona seed "$KIT/assets/templates/CLAUDE.md.template" \
    "$H/.claude/CLAUDE.premium.md" "$PERSONA_BASELINE_CLAUDE"
  guard_managed_persona seed "$ROLE_PROFILE" \
    "$H/.claude/CLAUDE.product.md" "$PERSONA_BASELINE_PRODUCT"
fi
if [ "$STARTER_FOUNDATION_REQUIRED" = 1 ]; then
  install -m 600 /dev/null "$H/.claude/product/starter-foundation-pending"
fi

# Agent runtimes, installed into the account's OWN prefix. bun must resolve from
# $H/.local/bin: Claude spawns MCP servers with a trimmed PATH that excludes
# /usr/local/bin, and a bun that lives only there fails to launch the Telegram
# poller with no useful error. Both installs are idempotent.
if [ ! -x "$H/.local/bin/bun" ]; then
  echo "  встановлюю середовище виконання bun"
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    npm install -g --prefix "$H/.local" bun >/dev/null
fi
if [ ! -x "$H/.local/bin/claude" ]; then
  echo "  встановлюю Claude Code CLI"
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    npm install -g --prefix "$H/.local" @anthropic-ai/claude-code >/dev/null
fi
# The --prefix flag above applies to that one command and is never written to
# config, so `npm config get prefix` stayed at the system default the agent user
# cannot write to. Claude Code's self-updater targets that prefix, so every
# attempt failed and installs froze on whatever version shipped that day — one
# customer sat 11 releases behind for 19 days and only saw it as a UI warning.
if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
  runuser -u "$AGENT_USER" -- env HOME="$H" npm config set prefix "$H/.local" >/dev/null
fi

for runtime in bun claude; do
  [ -x "$H/.local/bin/$runtime" ] || {
    echo "FATAL: $runtime не встановлено в $H/.local/bin" >&2
    exit 1
  }
done

echo "[2/7] керовані ресурси; дані власника зберігаються"
python3 "$KIT/assets/bin/update-safety-check" apply \
  --home "$H" \
  --kit "$KIT" \
  --policy "$KIT/assets/product/managed-runtime.json" \
  --baseline "$H/.claude/product/managed-runtime-baseline.json" \
  --owner "$AGENT_USER" \
  --defer-baseline
# BEGIN browser helper install
if product_has_feature browser; then
  # Only the primary writes the shared helper; another bot keeps its sudoers line.
  if [ "$AGENT_USER" = claude ]; then
    install -d -m 700 -o root -g root /var/lib/claude-browser/recovery
    install -m 755 -o root -g root "${KIT}/assets/bin/claude-browser-recover" /usr/local/sbin/claude-browser-recover
  fi
fi
# END browser helper install
python3 "$KIT/assets/lib/reconcile-managed-runtime.py" \
  "$H" "$KIT/assets/product/managed-runtime.json" \
  "$H/.claude/product/managed-runtime.json"
rm -f "$H/bin/cash-thread-capture" \
  "$H/bin/tg-thread-snapshot" \
  "$H/bin/vault-index" \
  "$H/bin/cash-research-deep" \
  "$H/bin/cash-health-evening" \
  "$H/bin/pm-digest"

# Retire the removed optional graph-memory extension from existing installs.
# A maintenance update must never purge an existing owner's graph data;
# keep this compatibility tombstone on fresh installs only.
if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
  if [ -x /opt/claude-graphify/bin/graphify ]; then
    (
      cd "$H/obsidian-vault"
      runuser -u "$AGENT_USER" -- env HOME="$H" \
        /opt/claude-graphify/bin/graphify uninstall --platform claude --purge
    ) >/dev/null 2>&1 || true
  fi
  rm -rf "$H/bin/graphify-vault" \
    "$H/.claude/skills/graphify" \
    "$H/obsidian-vault/graphify-out"
  # The extension itself is shared by the server; only the primary removes it.
  [ "$AGENT_USER" != claude ] || rm -rf /opt/claude-graphify
  python3 "$KIT/assets/lib/remove-markdown-section.py" \
    "$H/.claude/CLAUDE.md" "## graphify"
fi

install -m 644 -o "$AGENT_USER" -g "$AGENT_USER" "$KIT/assets/telegram-server-fixed.ts" "$H/telegram-server-fixed.ts"
install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$KIT/assets/product/telegram-plugin-compat.json" \
  "$H/.claude/product/telegram-plugin-compat.json"
# BEGIN selected agent systemd unit
# A concrete instance unit keeps a targeted install from changing the shared
# template used by every other secondary agent on this host.
verify_instance_system_context
if [ "$AGENT_USER" = claude ]; then
  install -m 644 "$KIT/assets/systemd/claude-telegram.service" "/etc/systemd/system/$AGENT_SERVICE"
else
  install -m 644 "$KIT/assets/systemd/claude-telegram@.service" "/etc/systemd/system/$AGENT_SERVICE"
fi
# END selected agent systemd unit
systemctl daemon-reload 2>/dev/null || true
sed "s|/home/claude|$H|g" "$KIT/assets/systemd/logrotate-cash" > "/etc/logrotate.d/cash-$AGENT_USER"
chmod 644 "/etc/logrotate.d/cash-$AGENT_USER"
# BEGIN managed skill installation
# Render the candidate before comparing it to the installed checksum. Copying
# or rendering again below would bypass owner-edit preservation.
env AGENT_NAME="$AGENT_NAME" OWNER_NAME="$OWNER_NAME" \
  OWNER_TG_USERNAME="$OWNER_TG_USERNAME" OWNER_CHAT_ID="$OWNER_CHAT_ID" \
  BOT_USERNAME="$BOT_USERNAME" TIMEZONE="$TIMEZONE" \
  CALENDAR_EMAIL="$CALENDAR_EMAIL" DEPLOY_DATE="$DEPLOY_DATE" \
  AGENT_HOME="$H" AGENT_SERVICE="$AGENT_SERVICE" AGENT_USER="$AGENT_USER" \
  python3 "$KIT/assets/lib/reconcile-managed-skills.py" \
  "$H/.claude/skills" "$KIT/assets/product/managed-skills.json" \
  "$H/.claude/product/managed-skills.json" \
  --source "$KIT/assets/skills" \
  --external-source "$KIT/assets/external-skills" \
  --baseline "$H/.claude/product/managed-skills-baseline.json"
# END managed skill installation
install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$KIT/assets/product/runtime.json" "$H/.claude/product/runtime.json"
install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$KIT/assets/product/managed-plugins.json" \
  "$H/.claude/product/managed-plugins.json"
install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$KIT/assets/product/plugin-contract.json" \
  "$H/.claude/product/plugin-contract.json"
# The same checksum applicator protects base and role subagents. It installs
# selected role files directly, without copying/deleting the raw role folder.
chown -R "$AGENT_USER:$AGENT_USER" "$H/.claude/skills" "$H/.claude/agents"
bash "$KIT/assets/lib/activate-role-subagents.sh" "$KIT" "$H" "$AGENT_USER" "${ACTIVE_ROLES:-}"

if product_has_feature telegram-corporate-sessions; then
  if [ ! -x "$H/.venvs/heif/bin/python" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- python3 -m venv "$H/.venvs/heif" || {
        echo "FATAL: для HEIF-конвертера потрібен python3-venv" >&2
        exit 1
      }
    fi
  fi
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    runuser -u "$AGENT_USER" -- "$H/.venvs/heif/bin/python" -m pip \
      install -q --requirement "$KIT/assets/requirements/heif.txt"
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/heif/bin/python" -I \
    -c 'from PIL import Image; from pillow_heif import register_heif_opener; register_heif_opener(thumbnails=False)'
fi

if product_has_feature sql-readonly; then
  if [ ! -x "$H/.venvs/bigquery/bin/python" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- python3 -m venv "$H/.venvs/bigquery" || {
        echo "FATAL: для sql-readonly потрібен python3-venv" >&2
        exit 1
      }
    fi
  fi
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    runuser -u "$AGENT_USER" -- "$H/.venvs/bigquery/bin/python" -m pip \
      install -q --requirement "$KIT/assets/requirements/bigquery.txt"
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/bigquery/bin/python" \
    -c 'from google.cloud import bigquery'
fi

if product_has_feature finance-data; then
  if [ ! -x "$H/.venvs/finance/bin/python" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- python3 -m venv --system-site-packages "$H/.venvs/finance" || {
        echo "FATAL: для finance-data потрібен python3-venv" >&2
        exit 1
      }
    fi
  fi
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    runuser -u "$AGENT_USER" -- "$H/.venvs/finance/bin/pip" install -q --upgrade yfinance
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/finance/bin/python" -c 'import yfinance'
fi

if product_has_feature spreadsheets; then
  if [ ! -x "$H/.venvs/spreadsheets/bin/python" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- python3 -m venv --system-site-packages \
        "$H/.venvs/spreadsheets" || {
          echo "FATAL: для spreadsheets потрібен python3-venv" >&2
          exit 1
        }
    fi
  fi
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    runuser -u "$AGENT_USER" -- "$H/.venvs/spreadsheets/bin/pip" \
      install -q --upgrade openpyxl xlsxwriter
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/spreadsheets/bin/python" \
    -c 'import openpyxl, xlsxwriter'
fi

SETTINGS_FILE="$H/.claude/settings.json"
if [ ! -e "$SETTINGS_FILE" ]; then
  render_template "$KIT/assets/templates/settings.json" "$SETTINGS_FILE"
fi
python3 "$KIT/assets/lib/migrate-settings.py" \
  "$SETTINGS_FILE" "$KIT/assets/templates/settings.json" \
  "$KIT/assets/product/managed-plugins.json"

for memory_file in MEMORY.md USER.md; do
  if [ ! -e "$H/.claude/memory/$memory_file" ]; then
    install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
      "$KIT/assets/templates/$memory_file" "$H/.claude/memory/$memory_file"
  fi
done

copy_tree_no_clobber "$KIT/assets/vault-skeleton" "$H/obsidian-vault"
if [ ! -e "$H/.claude/onboarding-state.json" ]; then
  install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" "$KIT/assets/templates/onboarding-state.json" "$H/.claude/onboarding-state.json"
  # The reminder helper spaces its first nudge from this stamp.
  runuser -u "$AGENT_USER" -- python3 - "$H/.claude/onboarding-state.json" <<'PY'
import json, sys, time
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    state = json.load(handle)
state.setdefault("installedAt", int(time.time()))
with open(path, "w", encoding="utf-8") as handle:
    json.dump(state, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
fi
LEGACY_THREAD="$H/obsidian-vault/wiki/active-thread.md"
if [ -f "$LEGACY_THREAD" ]; then
  install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 700 "$H/.claude/memory/quarantine"
  mv "$LEGACY_THREAD" \
    "$H/.claude/memory/quarantine/active-thread.$(date +%s).md"
  chmod 600 "$H/.claude/memory/quarantine/"active-thread.*.md
fi

cat > "$SUDOERS_FILE" <<SUDOERS
$AGENT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl is-active $AGENT_SERVICE, /usr/bin/systemctl start $AGENT_SERVICE, /usr/bin/systemctl restart $AGENT_SERVICE, /usr/bin/systemctl stop $AGENT_SERVICE, /usr/bin/systemctl reset-failed $AGENT_SERVICE
SUDOERS
if product_has_feature browser; then
  echo "$AGENT_USER ALL=(root) NOPASSWD: /usr/local/sbin/claude-browser-recover" >> "$SUDOERS_FILE"
fi
chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE" >/dev/null

echo "[3/7] формую керовані шаблони"
# BEGIN persona file mode preservation
set_managed_persona_mode() {
  local target="$1" current_mode
  if [ "$PERSONA_EXISTING" = 1 ]; then
    current_mode="$(stat -c '%a' -- "$target")" || return 1
    case "$current_mode" in
      600) return 0 ;; # Keep an existing private persona private.
      644) ;;
      *) echo "FATAL: неочікувані права на особистість агента" >&2; return 1 ;;
    esac
  fi
  runuser -u "$AGENT_USER" -- chmod 644 "$target"
}
# END persona file mode preservation
MANAGED_CLAUDE="$H/.claude/CLAUDE.premium.md"
MANAGED_IMPORT="@$H/.claude/CLAUDE.premium.md"
if [ "$PERSONA_EXISTING" = 1 ]; then
  render_template "$KIT/assets/templates/CLAUDE.md.template" "$MANAGED_CLAUDE" \
    --apply-baseline "$PERSONA_BASELINE_CLAUDE"
else
  render_template "$KIT/assets/templates/CLAUDE.md.template" "$MANAGED_CLAUDE"
fi
set_managed_persona_mode "$MANAGED_CLAUDE"
MANAGED_PRODUCT="$H/.claude/CLAUDE.product.md"
PRODUCT_IMPORT="@$H/.claude/CLAUDE.product.md"
# A second instance may be one of the kit's roles as its own bot
# (AGENT_ROLE=<slug> in its saved env): its persona is that role's profile.
if [ "$PERSONA_EXISTING" = 1 ]; then
  render_template "$ROLE_PROFILE" "$MANAGED_PRODUCT" \
    --apply-baseline "$PERSONA_BASELINE_PRODUCT"
else
  render_template "$ROLE_PROFILE" "$MANAGED_PRODUCT"
fi
set_managed_persona_mode "$MANAGED_PRODUCT"
runuser -u "$AGENT_USER" -- python3 "$KIT/assets/lib/sync-managed-claude.py" \
  "$H/CLAUDE.md" "$MANAGED_IMPORT" "$PRODUCT_IMPORT"
ACCESS_FILE="$H/.claude/channels/telegram/access.json"
if [ ! -e "$ACCESS_FILE" ]; then
  # The transport moves an unreadable access.json aside as access.json.corrupt-<ts>.
  # Rendering a fresh owner-only file over that gap silently drops every guest
  # and group; the owner must repair the moved file first.
  if compgen -G "$ACCESS_FILE.corrupt-*" >/dev/null; then
    echo "FATAL: access.json відсутній, але поруч лежить access.json.corrupt-*: транспорт відклав пошкоджений файл. Відновіть його (гості й групи) ДО встановлення, інакше вони мовчки випадуть із доступу." >&2
    exit 1
  fi
  render_template "$KIT/assets/templates/access.json.template" "$ACCESS_FILE"
fi
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  # Runtime-added admins are authoritative admission state. Keep them long
  # enough for the owner to review during the post-update migration plan.
  runuser -u "$AGENT_USER" -- python3 "$H/bin/access-update" preserve-admins \
    "$ACCESS_FILE" "$OWNER_CHAT_ID" "$ADDITIONAL_ADMIN_CHAT_IDS"
else
  runuser -u "$AGENT_USER" -- python3 "$H/bin/access-update" reconcile-admins \
    "$ACCESS_FILE" "$OWNER_CHAT_ID" "$ADDITIONAL_ADMIN_CHAT_IDS"
fi

MANAGED_RENDERED_FILES=("$H/CLAUDE.md" "$MANAGED_CLAUDE" "$MANAGED_PRODUCT" "$ACCESS_FILE")
while IFS= read -r -d '' source; do
  destination="$H/bin/$(basename "$source")"
  MANAGED_RENDERED_FILES+=("$destination")
  if grep -q '{{[A-Z_]*}}' "$source"; then
    render_template "$destination" "$destination"
  fi
  chmod 755 "$destination"
done < <(find "$KIT/assets/bin" -maxdepth 1 -type f -print0)
initialize_limit_recovery_state
# Managed skills are already rendered and checked by their applicator. Owner
# text retained there must not pass through the template renderer again.
if [ -f "$H/obsidian-vault/wiki/hot.md" ] && grep -q '{{[A-Z_]*}}' "$H/obsidian-vault/wiki/hot.md"; then
  render_template "$H/obsidian-vault/wiki/hot.md" "$H/obsidian-vault/wiki/hot.md"
fi
MANAGED_RENDERED_FILES+=("$H/obsidian-vault/wiki/hot.md")

echo "[4/7] зберігаю конфігурацію root і секрети середовища виконання"
CHANNEL_ENV="$H/.claude/channels/telegram/.env"
if [ -z "$OPENAI_API_KEY" ] && [ -r "$CHANNEL_ENV" ]; then
  OPENAI_API_KEY="$(read_channel_value "$CHANNEL_ENV" OPENAI_API_KEY)"
  [ -z "$OPENAI_API_KEY" ] || VOICE_SETUP_STATUS=configured
fi
OPENAI_API_KEY_FALLBACK="$(read_channel_value "$CHANNEL_ENV" OPENAI_API_KEY_FALLBACK)"
MEMORY_EMBEDDINGS_KEY_PRESENT=0
if [ -n "$OPENAI_API_KEY" ] || [ -n "$OPENAI_API_KEY_FALLBACK" ]; then
  MEMORY_EMBEDDINGS_KEY_PRESENT=1
fi
if [ -z "$MEMORY_EMBEDDINGS_OPENAI_INPUT" ] && [ -r "$CHANNEL_ENV" ]; then
  _existing_memory_embeddings="$(read_channel_value "$CHANNEL_ENV" MEMORY_EMBEDDINGS_OPENAI)"
  [ -z "$_existing_memory_embeddings" ] || MEMORY_EMBEDDINGS_OPENAI="$_existing_memory_embeddings"
fi
case "$MEMORY_EMBEDDINGS_OPENAI" in
  enabled|disabled) ;;
  *)
    echo "FATAL: MEMORY_EMBEDDINGS_OPENAI містить недопустиме значення" >&2
    exit 2
    ;;
esac
GOG_KEYRING_PASSWORD="$(read_channel_value "$CHANNEL_ENV" GOG_KEYRING_PASSWORD)"
[ -n "$GOG_KEYRING_PASSWORD" ] || GOG_KEYRING_PASSWORD="$(openssl rand -hex 16)"
GOG_KEYRING_BACKEND=file
# Recall.ai meeting-bot key (optional, meet-listen skill) — preserve on re-run
[ -z "$RECALL_API_KEY" ] && [ -r "$CHANNEL_ENV" ] && RECALL_API_KEY="$(read_channel_value "$CHANNEL_ENV" RECALL_API_KEY)"
# Recall keys are region-scoped: keep the region already configured in the channel
# .env on update (e.g. an us-west-2 account) unless the operator explicitly passed
# RECALL_REGION this run. Without this, the eu-central-1 default would silently
# overwrite an existing region and break that agent's meet-bot with a 401.
if [ -z "$RECALL_REGION_INPUT" ] && [ -r "$CHANNEL_ENV" ]; then
  _existing_region="$(read_channel_value "$CHANNEL_ENV" RECALL_REGION)"
  [ -n "$_existing_region" ] && RECALL_REGION="$_existing_region"
fi
# Who removes a delivered message from the queue (KTD8): keep the value the box
# runs with unless the operator passed one explicitly this run, and refuse a
# value the receiver would not understand. It lives in the channel file only —
# the poller records what it started with, the cron block never carries it, and
# the saved installer config does not either, so an update cannot roll a
# hand-switched box back to the value of its first install.
if [ -z "$TG_DELIVERY_AUTHORITY_INPUT" ] && [ -r "$CHANNEL_ENV" ]; then
  _existing_authority="$(read_channel_value "$CHANNEL_ENV" TG_DELIVERY_AUTHORITY)"
  [ -n "$_existing_authority" ] && TG_DELIVERY_AUTHORITY="$_existing_authority"
fi
case "$TG_DELIVERY_AUTHORITY" in
  guard|shadow|receiver) ;;
  *)
    echo "FATAL: TG_DELIVERY_AUTHORITY містить недопустиме значення «$TG_DELIVERY_AUTHORITY» (очікується guard, shadow або receiver)" >&2
    exit 2
    ;;
esac

# Restore it once the secrets are written. Left set, this umask follows the
# installer into everything that runs after — apt keyrings written under it come
# out 600 root:root, and apt verifies signatures as the _apt user, which then
# cannot read them.
secrets_umask="$(umask)"
umask 077
MANAGED_CHANNEL_ENV="$(mktemp)"
: > "$MANAGED_CHANNEL_ENV"
for name in TELEGRAM_BOT_TOKEN OPENAI_API_KEY MEMORY_EMBEDDINGS_OPENAI RECALL_API_KEY RECALL_REGION TG_DROP_PENDING_ON_BOOT \
  TG_DELIVERY_AUTHORITY OWNER_CHAT_ID TG_CORPORATE_SESSIONS GOG_KEYRING_BACKEND GOG_KEYRING_PASSWORD; do
  write_shell_value "$MANAGED_CHANNEL_ENV" "$name"
done
if ! python3 "$KIT/assets/lib/merge-env.py" \
    "$CHANNEL_ENV" "$MANAGED_CHANNEL_ENV" "$CHANNEL_ENV"; then
  rm -f "$MANAGED_CHANNEL_ENV"
  echo "FATAL: наявний файл середовища каналу містить небезпечні присвоєння" >&2
  exit 1
fi
rm -f "$MANAGED_CHANNEL_ENV"
chown "$AGENT_USER:$AGENT_USER" "$CHANNEL_ENV"
chmod 600 "$CHANNEL_ENV"

: > "$CONFIG_FILE"
for name in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS \
  OWNER_EMAIL BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN NOVSKY_LICENSE_KEY OPENAI_API_KEY VOICE_SETUP_STATUS \
  MEMORY_EMBEDDINGS_OPENAI \
  RECALL_API_KEY RECALL_REGION TG_DROP_PENDING_ON_BOOT TG_CORPORATE_SESSIONS \
  CALENDAR_EMAIL VAULT_LOCALE OWNER_NOTICE_LOCALE MODULE_DESIGN_PACK MODULE_CHANNEL_PUBLISH \
  MODULE_SOCIAL_BROWSER MODULE_TRANSPORT_DAEMON MODULE_VAULT_WEB \
  MODULE_INSTAGRAM_DM MODULE_YOUTUBE_COMMENTS MODULE_TELEGRAM_CORPORATE \
  CHANNEL_ID SITE_PASSWORD ACTIVE_ROLES AGENT_ROLE; do
  write_shell_value "$CONFIG_FILE" "$name"
done
chmod 600 "$CONFIG_FILE"

PROFILE_FILE="$H/.agent-profile.env"
: > "$PROFILE_FILE"
for name in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS \
  OWNER_EMAIL BOT_USERNAME TIMEZONE CALENDAR_EMAIL VAULT_LOCALE OWNER_NOTICE_LOCALE \
  TG_DROP_PENDING_ON_BOOT TG_CORPORATE_SESSIONS; do
  write_shell_value "$PROFILE_FILE" "$name"
done
chown "$AGENT_USER:$AGENT_USER" "$PROFILE_FILE"
chmod 600 "$PROFILE_FILE"
umask "${secrets_umask:-022}"
if [ "$AGENT_USER" = claude ]; then
  rm -f /home/claude/.cash-agent.env
fi

if [ -n "$RECALL_API_KEY" ]; then
  MEETING_SETUP_STATUS=configured
else
  MEETING_SETUP_STATUS=deferred
fi
python3 - "$H/.claude/onboarding-state.json" "$VOICE_SETUP_STATUS" \
  "$MEETING_SETUP_STATUS" \
  "$MEMORY_EMBEDDINGS_OPENAI" "$MEMORY_EMBEDDINGS_KEY_PRESENT" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
state = json.loads(path.read_text(encoding="utf-8"))
features = state.setdefault("optionalFeatures", {})
features.pop("graphify", None)
voice = features.setdefault("voice_transcription", {})
voice["status"] = sys.argv[2]
voice["model"] = "gpt-4o-mini-transcribe"
voice["remindAfterDays"] = 7
meeting = features.setdefault("meeting_secretary", {})
meeting["status"] = sys.argv[3]
meeting["remindAfterDays"] = 7
meeting.setdefault("lastReminderAt", None)
semantic = features.setdefault("memory_semantic_search", {})
semantic_status = "disabled"
if sys.argv[4] == "enabled":
    semantic_status = "configured" if sys.argv[5] == "1" else "needs-key"
semantic["status"] = semantic_status
semantic["provider"] = "openai" if sys.argv[4] == "enabled" else "local-keyword"
semantic["remindAfterDays"] = 0
path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY

# The agent's crontab, or nothing when it has none yet. Any other failure of the read stops the caller:
# a write after it would leave the owner's own schedule replaced by the kit's lines alone.
agent_crontab() {
  local listing problem status=0
  problem="$(mktemp)"
  listing="$(LC_ALL=C crontab -u "$AGENT_USER" -l 2>"$problem")" || status=$?
  if [ "$status" -ne 0 ] && ! grep -qi 'no crontab for' "$problem"; then
    echo "FATAL: розклад користувача $AGENT_USER не прочитано, тому не змінюю його: $(tr '\n' ' ' < "$problem")" >&2
    rm -f "$problem"
    return 1
  fi
  rm -f "$problem"
  [ "$status" -ne 0 ] || printf '%s\n' "$listing"
}

install_managed_crontab() {
  # Ubuntu cron ignores CRON_TZ: the header below only documents intent, the
  # schedule follows the system clock, so daily jobs on a UTC box fire hours
  # late (Yasha box, 2026-09-01). Align the box clock with the declared
  # timezone; primary install only — one box serves one wall clock.
  if [ "$AGENT_USER" = "claude" ] && [ -n "${TIMEZONE:-}" ] && command -v timedatectl >/dev/null 2>&1; then
    if [ "$(timedatectl show -p Timezone --value 2>/dev/null)" != "$TIMEZONE" ]; then
      if timedatectl set-timezone "$TIMEZONE" 2>/dev/null; then
        systemctl try-restart cron 2>/dev/null || true
      else
        echo "WARN: could not set system timezone to $TIMEZONE — daily cron jobs will follow the box clock" >&2
      fi
    fi
  fi
  local existing_crontab unmanaged_crontab
  existing_crontab="$(agent_crontab)" || return 1
  # Boxes installed before the managed markers existed still carry those same
  # entries outside the block, so rewriting the block leaves a second copy behind
  # and every job runs twice — Cash was firing reminders, the watchdog, vault-sync,
  # relogin-watch and the memory index twice over (found 2026-07-28). Drop any
  # unmanaged line that invokes a job this block owns.
  # Retired backup jobs use exact legacy lines in the shared filter below, so
  # an owner's manual backup cron is left alone.
  unmanaged_crontab="$(printf '%s\n' "$existing_crontab" | drop_retired_managed_jobs | awk \
    -v legacy_health="$H/bin/cash-health-evening" \
    -v owned="$H/bin/cash-reminder-tick $H/bin/cash-healthcheck $H/bin/claude-limit-recovery $H/bin/relogin-watch $H/bin/unstick-watch $H/bin/queue-settle-sweep $H/bin/telegram-inbox-prune $H/bin/memory-index $H/bin/learning-review $H/bin/onboarding-reminder $H/bin/skill-brief" '
    BEGIN { split(owned, jobs, " ") }
    $0 == "# BEGIN claude-tg-starter" { managed=1; next }
    $0 == "# END claude-tg-starter" { managed=0; next }
    index($0, legacy_health) { next }
    !managed {
      for (i in jobs) if (index($0, jobs[i])) next
      print
    }
  ')"
{
  printf '%s\n' "$unmanaged_crontab"
  managed_crontab_block
} | sed '/^[[:space:]]*$/N;/^\n$/D' | crontab -u "$AGENT_USER" -
}

# The lines this kit schedules, without the owner's own entries around them.
managed_crontab_block() {
  echo "# BEGIN claude-tg-starter"
  echo "CRON_TZ=$TIMEZONE"
  echo "TZ=$TIMEZONE"
  echo "CLAUDE_TELEGRAM_SERVICE=$AGENT_SERVICE"
  # Above the tick's own AGENT_TASK_TIMEOUT (900s): a RUN=1 task runs inside the
  # tick, so a one-minute cap used to kill it mid-work. Ticks never overlap —
  # the worker takes a file lock and a later tick exits at once.
  echo "* * * * * /usr/bin/timeout 960 $H/bin/cash-reminder-tick"
  echo "*/2 * * * * /usr/bin/timeout 110 $H/bin/cash-healthcheck"
  echo "* * * * * /usr/bin/timeout 55 $H/bin/claude-limit-recovery --active"
  echo "* * * * * /usr/bin/timeout 55 $H/bin/claude-limit-recovery --notify"
  echo "* * * * * /usr/bin/timeout 55 $H/bin/relogin-watch"
  echo "* * * * * /usr/bin/timeout 180 $H/bin/unstick-watch"
  # The Stop hook can fire before the transcript's last record lands, and then
  # nothing calls the guard again. This gives it a second chance over the
  # finished transcript; it decides nothing about delivery itself.
  echo "* * * * * /usr/bin/timeout 90 $H/bin/queue-settle-sweep"
  echo "17 4 * * * /usr/bin/timeout 30 $H/bin/telegram-inbox-prune"
  echo "23 4 * * * find $H/telegram-outbox -xdev -type f -mtime +7 -delete"
  # The prompt hook searches with --no-refresh to keep Telegram latency low, so
  # this recurring pass must include both vault notes and new Telegram history.
  echo "*/10 * * * * /usr/bin/timeout 60 $H/bin/memory-index index >/dev/null"
  # GitHub is handled by one root-provisioned hourly local check. Only its
  # 22:00 Europe/Lisbon slot selects one configured backend and sends data.
  # Daily tick; the helper spaces the nudges itself (a day after install, then weekly).
  echo "13 11 * * * /usr/bin/timeout 30 $H/bin/onboarding-reminder"
  echo "# END claude-tg-starter"
}

# Kept for an explicit, reviewed cron migration only. Routine maintenance below
# never calls this helper: even a missing kit job must not rewrite a paused or
# owner-customized crontab in the middle of an update transaction.
add_missing_managed_jobs() {
  local existing missing
  existing="$(agent_crontab)" || return 1
  if ! printf '%s\n' "$existing" | grep -Fxq '# BEGIN claude-tg-starter'; then
    echo "      керований блок знято на час обслуговування — crontab не змінюю"
    return 0
  fi
  # Match on the command, not on the whole line: a box where somebody scheduled
  # the same helper by hand outside the block would otherwise end up running it
  # twice a minute, and two copies racing for one queue head burn its retries at
  # double speed.
  missing="$(managed_crontab_block | awk '/^[*0-9]/' | while IFS= read -r line; do
    # The helper and its first option, without the schedule, the timeout cap or
    # a redirect: those differ between a hand-written line and this block, while
    # "--active" and "--notify" still count as two different jobs.
    key="$(printf '%s\n' "$line" | sed -E 's#^([^ ]+ +){5}##; s#^/usr/bin/timeout +[0-9]+ +##; s# *>+ *[^ ]+( +2>&1)? *$##')"
    printf '%s\n' "$existing" | grep -Fq "$key" || printf '%s\n' "$line"
  done)"
  if [ -z "$missing" ]; then
    echo "      керований crontab уже містить усі завдання комплекту"
    return 0
  fi
  printf '%s\n' "$existing" | awk -v add="$missing" '
    $0 == "# END claude-tg-starter" { print add }
    { print }
  ' | crontab -u "$AGENT_USER" -
  echo "      додано керованих завдань: $(printf '%s\n' "$missing" | grep -c .)"
}

# The cron lines this kit has retired. A complete line removes only that exact
# legacy entry; a helper key removes any matching managed entry, as before.
# An empty list changes nothing; a line the block still writes never belongs here.
retired_managed_jobs() {
  echo "*/5 * * * * /usr/bin/timeout 60 $H/bin/vault-sync"
  echo "7 * * * * /usr/bin/timeout 300 $H/bin/agent-github-backup scheduled >/dev/null 2>&1"
}

# Prints the crontab on stdin without retired lines. A full cron line is
# removed only on exact match, including outside the block. Helper keys keep
# the older managed-job behavior: inside the block they match by substring;
# outside it only a key naming the kit's own path ($H/bin/…) does. Every
# other line outside the block is the owner's.
drop_retired_managed_jobs() {
  # Tab-joined: BSD awk refuses a newline inside a -v value, and no key holds a tab.
  awk -v retired="$(retired_managed_jobs | tr '\n' '\t')" -v own="$H/bin/" '
    BEGIN { n = split(retired, keys, "\t") }
    $0 == "# BEGIN claude-tg-starter" { managed=1 }
    $0 == "# END claude-tg-starter" { managed=0 }
    {
      for (i = 1; i <= n; i++) {
        if (keys[i] == "") continue
        if (keys[i] ~ /^[*0-9@]/) {
          if ($0 == keys[i]) next
        } else if (index($0, keys[i]) && (managed || index(keys[i], own) == 1)) next
      }
      print
    }
  '
}

# Also reserved for an explicit, reviewed cron migration. A normal maintenance
# run leaves retired lines untouched, even when the managed block is present.
remove_retired_managed_jobs() {
  local existing pruned
  existing="$(agent_crontab)" || return 1
  printf '%s\n' "$existing" | grep -Fxq '# BEGIN claude-tg-starter' || return 0
  pruned="$(printf '%s\n' "$existing" | drop_retired_managed_jobs)"
  [ "$pruned" != "$existing" ] || return 0
  printf '%s\n' "$pruned" | crontab -u "$AGENT_USER" -
  echo "      знято керованих завдань: $(( $(printf '%s\n' "$existing" | wc -l) - $(printf '%s\n' "$pruned" | wc -l) ))"
}

echo "[5/7] crontab"
if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
  python3 "$KIT/assets/lib/install-backup-context.py" \
    --home "$H" --user "$AGENT_USER" --unit "$AGENT_SERVICE" --engine claude
fi
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  echo "      режим обслуговування: crontab не змінюю"
else
  echo "      нова інсталяція: замінюю лише керований блок"
  install_managed_crontab
fi

# The command menu has to match what actually works, or the owner is guessing —
# Cash ran for months with an empty menu while /fix and /relogin existed.
if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
  runuser -u "$AGENT_USER" -- env HOME="$H" "$H/bin/set-tg-commands" || \
    echo "      WARN: не вдалося опублікувати меню команд Telegram (повтор: ~/bin/set-tg-commands)"
fi

echo "[6/7] необов’язкові інструменти"

if product_has_feature google-workspace && ! command -v gog >/dev/null 2>&1; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
    echo "FATAL: gog зник під час оновлення; не завантажую його автоматично" >&2
    exit 1
  fi
  bash "$KIT/scripts/install-gog.sh"
fi

# The kit ships the shared Novsky OAuth client, so "підключи Google" needs only the
# owner's consent click — no per-client Google Cloud project. An agent that already
# configured its own client keeps it: seeding only fills an empty config.
GOOGLE_OAUTH_CLIENT="$KIT/assets/product/google-oauth-client.json"
if product_has_feature google-workspace && command -v gog >/dev/null 2>&1 && \
   [ -s "$GOOGLE_OAUTH_CLIENT" ] && [ ! -s "$H/.local/share/gogcli/credentials.json" ]; then
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    "$H/bin/gog" auth credentials set "$GOOGLE_OAUTH_CLIENT" >/dev/null || \
    echo "      WARN: не вдалося записати спільний OAuth-клієнт Google (повтор: ~/bin/gog auth credentials set $KIT/assets/product/google-oauth-client.json)"
fi

EXTERNAL_SKILLS="$KIT/assets/external-skills"
# Missing packaged sources already fail the common preflight. The final doctor
# verifies installed skills, including disabled copies and preserved removals.
if [ -d "$EXTERNAL_SKILLS" ]; then
  while IFS= read -r external_skill; do
    [ -n "$external_skill" ] || continue
    source="$EXTERNAL_SKILLS/$external_skill"
    [ -f "$source/SKILL.md" ] || {
      echo "FATAL: оголошена зовнішня навичка відсутня: $external_skill" >&2
      exit 1
    }
  done < <(python3 "$PRODUCT_CONFIG" list externalSkills)
  chown -R "$AGENT_USER:$AGENT_USER" "$H/.claude/skills"
fi
# All packaged skills were reconciled together above. The default-off list moves a
# skill aside on its first install, and whatever the owner switched off
# (Novsky → Скіли) stays off — the fresh copy goes to ~/.claude/skills.disabled/<name>,
# where switching back on is a move, not a reinstall.
# The default-off list is Premium's: a role kit whose job is video (creative
# producer) keeps its studio on; the owner's own switches apply everywhere.
SKILLS_DEFAULT_OFF="$KIT/assets/product/skills-default-off.json"
if [ "$(python3 "$PRODUCT_CONFIG" get productId)" != "premium" ]; then
  SKILLS_DEFAULT_OFF=/dev/null
fi
python3 "$KIT/assets/lib/apply-disabled-skills.py" "$H" "$SKILLS_DEFAULT_OFF"
if [ -d "$H/.claude/skills.disabled" ]; then
  chown -R "$AGENT_USER:$AGENT_USER" "$H/.claude/skills.disabled"
fi
chown "$AGENT_USER:$AGENT_USER" "$H/.claude/product/skills-default-off-applied.json"

if product_has_feature media-downloads || \
   product_has_feature vercel || \
   product_has_feature video-edit; then
  if ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1; then
    echo "FATAL: Node.js/npx відсутній; установи Node 22+ перед налаштуванням ядра" >&2
    exit 1
  fi
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$node_major" -lt 22 ]; then
    echo "FATAL: потрібен Node.js 22+; знайдено $(node --version)" >&2
    exit 1
  fi
fi

if product_has_feature media-downloads; then
  if [ ! -x "$H/.local/bin/yt-dlp" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- env HOME="$H" \
        PIPX_HOME="$H/.local/share/pipx" PIPX_BIN_DIR="$H/.local/bin" \
        pipx install yt-dlp >/dev/null
    fi
  fi
  [ -x "$H/.local/bin/yt-dlp" ] || {
    echo "FATAL: yt-dlp не встановлено" >&2
    exit 1
  }
  if [ ! -x "$H/.local/bin/deno" ]; then
    if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
      runuser -u "$AGENT_USER" -- env HOME="$H" \
        npm install -g --prefix "$H/.local" deno >/dev/null
    fi
  fi
  [ -x "$H/.local/bin/deno" ] || {
    echo "FATAL: Deno не встановлено" >&2
    exit 1
  }
fi

if product_has_feature vercel; then
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ]; then
    runuser -u "$AGENT_USER" -- env HOME="$H" \
      npm install -g --prefix "$H/.npm-global" vercel@latest >/dev/null
  fi
  [ -x "$H/.npm-global/bin/vercel" ] || {
    echo "FATAL: Vercel CLI не встановлено" >&2
    exit 1
  }
fi

if product_has_feature video-edit; then
  # Missing packaged skills fail the checksum preflight. A live marketplace
  # reinstall here would bypass it and overwrite owner changes with latest.
  for external_skill in hyperframes media-use talking-head-recut embedded-captions; do
    [ -f "$EXTERNAL_SKILLS/$external_skill/SKILL.md" ] || {
      echo "FATAL: відсутня зовнішня медіанавичка: $external_skill" >&2
      exit 1
    }
  done
fi

if product_has_feature video-edit; then
  bash "$KIT/scripts/install-video-edit.sh"
fi

if product_has_feature telegram-corporate-sessions && [ "$MODULE_TELEGRAM_CORPORATE" = 1 ]; then
  # The module swap is two renames with a window in which the module path does
  # not exist; a running poller caches that import failure until restart and
  # answers every employee "тимчасово недоступний". update.sh already requires a
  # stopped service; a plain re-run must not swap under a live bot.
  if [ "$CLAUDE_UPDATE_MAINTENANCE" != 1 ] && command -v systemctl >/dev/null 2>&1 \
    && systemctl is-active --quiet "$AGENT_SERVICE" 2>/dev/null; then
    echo "FATAL: корпоративний модуль замінюється лише при зупиненій службі $AGENT_SERVICE — зупини її або йди через maintenance-оновлення (UPGRADING.md)" >&2
    exit 1
  fi
  AGENT_USER="$AGENT_USER" H="$H" KIT="$KIT" \
    bash "$KIT/modules/telegram-corporate/install.sh"
  # Parallel sessions are as capable as the owner's: same skills, same
  # subagents, rendered copies. A trimmed worker package stops the install.
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    PATH="$H/.local/bin:$H/.bun/bin:/usr/local/bin:/usr/bin:/bin" \
    "$H/bin/corporate-control" parity --json >"$H/logs/corporate-parity.json" || {
    echo "FATAL: паралельні сесії не рівні головній — корпоративний воркер бачить не ті скіли чи субагентів, що агент (див. $H/logs/corporate-parity.json)" >&2
    exit 1
  }
fi

if [ "$MODULE_CHANNEL_PUBLISH" = 1 ]; then
  AGENT_USER="$AGENT_USER" CHANNEL_ID="$CHANNEL_ID" \
    CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" \
    bash "$KIT/modules/channel-publishing/install.sh"
fi
if [ "$AGENT_USER" != claude ] && { [ "$MODULE_INSTAGRAM_DM" = 1 ] || [ "$MODULE_YOUTUBE_COMMENTS" = 1 ]; }; then
  echo "FATAL: необов’язкові модулі встановлюються лише для основного агента (AGENT_USER=claude)" >&2
  exit 1
fi
if [ "$MODULE_INSTAGRAM_DM" = 1 ]; then
  OWNER_CHAT_ID="$OWNER_CHAT_ID" OWNER_NAME="$OWNER_NAME" TIMEZONE="$TIMEZONE" \
    CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" \
    bash "$KIT/modules/instagram-dm/install.sh"
fi
if [ "$MODULE_YOUTUBE_COMMENTS" = 1 ]; then
  OWNER_CHAT_ID="$OWNER_CHAT_ID" OWNER_NAME="$OWNER_NAME" TIMEZONE="$TIMEZONE" \
    CLAUDE_UPDATE_MAINTENANCE="$CLAUDE_UPDATE_MAINTENANCE" \
    bash "$KIT/modules/youtube-comments/install.sh"
fi

echo "[7/7] контрольна перевірка"
if grep -lE '\{\{[A-Z_]+\}\}' "${MANAGED_RENDERED_FILES[@]}" 2>/dev/null; then
  echo "FATAL: у наведених вище файлах залишився незаповнений шаблонний маркер" >&2
  exit 1
fi

# Preserve root-owned transport and operator-policy files below the home. The
# runtime account owns only its explicit data/configuration paths.
chown "$AGENT_USER:$AGENT_USER" "$H"
for owned_path in logs bin obsidian-vault .claude backups .venvs; do
  [ ! -e "$H/$owned_path" ] || chown -R "$AGENT_USER:$AGENT_USER" "$H/$owned_path"
done
for owned_file in CLAUDE.md telegram-server-fixed.ts .agent-profile.env; do
  [ ! -e "$H/$owned_file" ] || chown "$AGENT_USER:$AGENT_USER" "$H/$owned_file"
done
if [ ! -d "$H/obsidian-vault/.git" ]; then
  runuser -u "$AGENT_USER" -- git -C "$H/obsidian-vault" init -q
  runuser -u "$AGENT_USER" -- git -C "$H/obsidian-vault" config user.email "${OWNER_EMAIL:-claude@localhost}"
  runuser -u "$AGENT_USER" -- git -C "$H/obsidian-vault" config user.name "${AGENT_NAME:-Claude Agent}"
  runuser -u "$AGENT_USER" -- git -C "$H/obsidian-vault" add -A
  runuser -u "$AGENT_USER" -- git -C "$H/obsidian-vault" commit -q -m "init: vault skeleton" \
    || echo "  WARN: початковий коміт сховища не створено"
fi

runuser -u "$AGENT_USER" -- env HOME="$H" \
  "$H/bin/memory-index" index >/dev/null
runuser -u "$AGENT_USER" -- env HOME="$H" \
  "$H/bin/memory-doctor" >/dev/null
runuser -u "$AGENT_USER" -- env HOME="$H" \
  "$H/bin/skill-doctor" --root "$H/.claude/skills" >/dev/null
if [ "$STARTER_FOUNDATION_REQUIRED" = 1 ]; then
  # memory-index deliberately falls back to keyword search on provider errors.
  # That is useful at runtime, but a fresh Starter must have real vectors before
  # its baseline is accepted. Auth and Telegram are checked at later stages.
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    "$H/bin/onboarding-status" --foundation-only --strict || {
      echo "FATAL: базові можливості Novsky Starter ще не готові. Перевір OpenAI API key, доступ і баланс API та повідомлення перевірки вище; повтори встановлення." >&2
      exit 1
    }
  rm -f "$H/.claude/product/starter-foundation-pending"
fi
python3 "$KIT/assets/bin/update-safety-check" accept \
  --home "$H" \
  --kit "$KIT" \
  --policy "$KIT/assets/product/managed-runtime.json" \
  --baseline "$H/.claude/product/managed-runtime-baseline.json" \
  --owner "$AGENT_USER"
render_template "$KIT/assets/templates/CLAUDE.md.template" "$MANAGED_CLAUDE" \
  --accept-baseline "$PERSONA_BASELINE_CLAUDE"
render_template "$ROLE_PROFILE" "$MANAGED_PRODUCT" \
  --accept-baseline "$PERSONA_BASELINE_PRODUCT"

echo "✅ Ядро встановлено: керовані ресурси оновлено, дані власника збережено, перевірки пройдено."
