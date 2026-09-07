#!/usr/bin/env bash
# Deterministic, non-destructive core install for Ubuntu VPS deployments.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: install-core потрібно запускати від root" >&2; exit 1; }
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

for name in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN; do
  [ -n "${!name:-}" ] || { echo "FATAL: обов’язкову змінну середовища $name не задано" >&2; exit 1; }
done

OPENAI_API_KEY="${OPENAI_API_KEY:-}"
MEMORY_EMBEDDINGS_OPENAI_INPUT="${MEMORY_EMBEDDINGS_OPENAI:-}"
MEMORY_EMBEDDINGS_OPENAI="${MEMORY_EMBEDDINGS_OPENAI:-disabled}"
RECALL_API_KEY="${RECALL_API_KEY:-}"
RECALL_REGION_INPUT="${RECALL_REGION:-}"   # explicit operator value this run, if any
RECALL_REGION="${RECALL_REGION:-eu-central-1}"
CALENDAR_EMAIL="${CALENDAR_EMAIL:-}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
VAULT_LOCALE="${VAULT_LOCALE:-en-US}"
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
if [ "$MODULE_CHANNEL_PUBLISH" = 1 ]; then
  [[ "$CHANNEL_ID" =~ ^-100[0-9]{6,}$ ]] || {
    echo "FATAL: для публікації CHANNEL_ID має виглядати як -100..." >&2
    exit 1
  }
fi
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
  local foreign_owner linked_path
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
}

validate_install_kit

# Check the installed runtime identity before writing templates, credentials or
# cron entries. A wizard may already have replaced the root input agent.env.
_installed_token="$(python3 "$KIT/assets/lib/merge-env.py" --value "$H/.claude/channels/telegram/.env" TELEGRAM_BOT_TOKEN)"
if [ -n "$_installed_token" ] && [ "${_installed_token%%:*}" != "${TELEGRAM_BOT_TOKEN%%:*}" ]; then
  echo "FATAL: каталог $H належить іншому Telegram-боту; для нового агента задай окремий AGENT_USER" >&2
  exit 1
fi
unset _installed_token
# The late corporate-module check also guards a restart during installation;
# this early check prevents partial overwrites even for non-corporate kits.
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$AGENT_SERVICE" 2>/dev/null; then
  echo "FATAL: перед зміною ядра зупини $AGENT_SERVICE через maintenance-оновлення (UPGRADING.md)" >&2
  exit 1
fi

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
if ! command -v sqlite3 >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q sqlite3 >/dev/null 2>&1 || true
  command -v sqlite3 >/dev/null 2>&1 || {
    echo "FATAL: sqlite3 відсутній, і його не вдалося встановити; виконай apt-get install -y sqlite3" >&2
    exit 1
  }
fi

# Native corporate sessions use Claude Code's OS sandbox. Provision ordinary
# runtime packages for those kits only; host security policy is not changed here.
if product_has_feature telegram-corporate-sessions; then
  if ! command -v bwrap >/dev/null 2>&1 || ! command -v socat >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap socat >/dev/null 2>&1 || true
  fi
  for dependency in bwrap socat; do
    command -v "$dependency" >/dev/null 2>&1 || {
      echo "FATAL: bubblewrap/socat відсутні, і їх не вдалося встановити; виконай apt-get install -y bubblewrap socat" >&2
      exit 1
    }
  done
fi

# Semantic memory runs from the system Python. install-base provisions numpy on
# guided clean installs; this convergence path also covers direct product
# installs and upgrades from releases that predate vector search.
if ! /usr/bin/python3 -c 'import numpy' >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-numpy >/dev/null 2>&1 || true
fi
/usr/bin/python3 -c 'import numpy' >/dev/null 2>&1 || {
  echo "FATAL: python3-numpy відсутній, і його не вдалося встановити" >&2
  exit 1
}

# Веб-звіт рендерить нотатки вольта в HTML. Системний Python на 24.04 зовнішньо
# керований, тому пакет ставимо тут, а не pip-ом під час першого запуску.
if ! /usr/bin/python3 -c 'import markdown' >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q python3-markdown >/dev/null 2>&1 || true
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

render_template() {
  local source="$1" destination="$2"
  runuser -u "$AGENT_USER" -- env \
    AGENT_NAME="$AGENT_NAME" OWNER_NAME="$OWNER_NAME" \
    OWNER_TG_USERNAME="$OWNER_TG_USERNAME" OWNER_CHAT_ID="$OWNER_CHAT_ID" \
    BOT_USERNAME="$BOT_USERNAME" TIMEZONE="$TIMEZONE" \
    CALENDAR_EMAIL="$CALENDAR_EMAIL" DEPLOY_DATE="$DEPLOY_DATE" \
    AGENT_HOME="$H" AGENT_SERVICE="$AGENT_SERVICE" AGENT_USER="$AGENT_USER" \
    python3 "$KIT/assets/lib/render-template.py" "$source" "$destination"
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
runuser -u "$AGENT_USER" -- env HOME="$H" npm config set prefix "$H/.local" >/dev/null

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
if product_has_feature browser; then
  [ ! -L /var/lib/claude-browser/recovery ] || {
    echo "FATAL: каталог стану відновлення браузера не може бути символічним посиланням" >&2
    exit 1
  }
  install -d -m 700 -o root -g root /var/lib/claude-browser/recovery
  install -m 755 -o root -g root "${KIT}/assets/bin/claude-browser-recover" /usr/local/sbin/claude-browser-recover
fi
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
# This compatibility tombstone can be deleted after all managed servers have
# upgraded beyond the release that removed the extension.
if [ -x /opt/claude-graphify/bin/graphify ]; then
  (
    cd "$H/obsidian-vault"
    runuser -u "$AGENT_USER" -- env HOME="$H" \
      /opt/claude-graphify/bin/graphify uninstall --platform claude --purge
  ) >/dev/null 2>&1 || true
fi
rm -rf /opt/claude-graphify \
  "$H/bin/graphify-vault" \
  "$H/.claude/skills/graphify" \
  "$H/obsidian-vault/graphify-out"
python3 "$KIT/assets/lib/remove-markdown-section.py" \
  "$H/.claude/CLAUDE.md" "## graphify"

install -m 644 -o "$AGENT_USER" -g "$AGENT_USER" "$KIT/assets/telegram-server-fixed.ts" "$H/telegram-server-fixed.ts"
install -m 600 -o "$AGENT_USER" -g "$AGENT_USER" \
  "$KIT/assets/product/telegram-plugin-compat.json" \
  "$H/.claude/product/telegram-plugin-compat.json"
# BEGIN selected agent systemd unit
# A concrete instance unit keeps a targeted install from changing the shared
# template used by every other secondary agent on this host.
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
    runuser -u "$AGENT_USER" -- python3 -m venv "$H/.venvs/heif" || {
      echo "FATAL: для HEIF-конвертера потрібен python3-venv" >&2
      exit 1
    }
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/heif/bin/python" -m pip \
    install -q --requirement "$KIT/assets/requirements/heif.txt"
  runuser -u "$AGENT_USER" -- "$H/.venvs/heif/bin/python" -I \
    -c 'from PIL import Image; from pillow_heif import register_heif_opener; register_heif_opener(thumbnails=False)'
fi

if product_has_feature sql-readonly; then
  if [ ! -x "$H/.venvs/bigquery/bin/python" ]; then
    runuser -u "$AGENT_USER" -- python3 -m venv "$H/.venvs/bigquery" || {
      echo "FATAL: для sql-readonly потрібен python3-venv" >&2
      exit 1
    }
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/bigquery/bin/python" -m pip \
    install -q --requirement "$KIT/assets/requirements/bigquery.txt"
  runuser -u "$AGENT_USER" -- "$H/.venvs/bigquery/bin/python" \
    -c 'from google.cloud import bigquery'
fi

if product_has_feature finance-data; then
  if [ ! -x "$H/.venvs/finance/bin/python" ]; then
    runuser -u "$AGENT_USER" -- python3 -m venv --system-site-packages "$H/.venvs/finance" || {
      echo "FATAL: для finance-data потрібен python3-venv" >&2
      exit 1
    }
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/finance/bin/pip" install -q --upgrade yfinance
  runuser -u "$AGENT_USER" -- "$H/.venvs/finance/bin/python" -c 'import yfinance'
fi

if product_has_feature spreadsheets; then
  if [ ! -x "$H/.venvs/spreadsheets/bin/python" ]; then
    runuser -u "$AGENT_USER" -- python3 -m venv --system-site-packages \
      "$H/.venvs/spreadsheets" || {
        echo "FATAL: для spreadsheets потрібен python3-venv" >&2
        exit 1
      }
  fi
  runuser -u "$AGENT_USER" -- "$H/.venvs/spreadsheets/bin/pip" \
    install -q --upgrade openpyxl xlsxwriter
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
MANAGED_CLAUDE="$H/.claude/CLAUDE.premium.md"
MANAGED_IMPORT="@$H/.claude/CLAUDE.premium.md"
render_template "$KIT/assets/templates/CLAUDE.md.template" "$MANAGED_CLAUDE"
runuser -u "$AGENT_USER" -- chmod 644 "$MANAGED_CLAUDE"
MANAGED_PRODUCT="$H/.claude/CLAUDE.product.md"
PRODUCT_IMPORT="@$H/.claude/CLAUDE.product.md"
# A second instance may be one of the kit's roles as its own bot
# (AGENT_ROLE=<slug> in its saved env): its persona is that role's profile.
ROLE_PROFILE="$KIT/assets/product/ROLE.md"
if [ -n "${AGENT_ROLE:-}" ]; then
  ROLE_PROFILE="$KIT/assets/roles/$AGENT_ROLE/ROLE.md"
  if [ ! -f "$ROLE_PROFILE" ]; then
    echo "FATAL: AGENT_ROLE=$AGENT_ROLE, але в комплекті немає assets/roles/$AGENT_ROLE/ROLE.md (роль як окремий бот є лише в повному комплекті)" >&2
    exit 1
  fi
fi
render_template "$ROLE_PROFILE" "$MANAGED_PRODUCT"
runuser -u "$AGENT_USER" -- chmod 644 "$MANAGED_PRODUCT"
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

# Restore it once the secrets are written. Left set, this umask follows the
# installer into everything that runs after — apt keyrings written under it come
# out 600 root:root, and apt verifies signatures as the _apt user, which then
# cannot read them.
secrets_umask="$(umask)"
umask 077
MANAGED_CHANNEL_ENV="$(mktemp)"
: > "$MANAGED_CHANNEL_ENV"
for name in TELEGRAM_BOT_TOKEN OPENAI_API_KEY MEMORY_EMBEDDINGS_OPENAI RECALL_API_KEY RECALL_REGION TG_DROP_PENDING_ON_BOOT \
  OWNER_CHAT_ID TG_CORPORATE_SESSIONS GOG_KEYRING_BACKEND GOG_KEYRING_PASSWORD; do
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
  OWNER_EMAIL BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN OPENAI_API_KEY VOICE_SETUP_STATUS \
  MEMORY_EMBEDDINGS_OPENAI \
  RECALL_API_KEY RECALL_REGION TG_DROP_PENDING_ON_BOOT TG_CORPORATE_SESSIONS \
  CALENDAR_EMAIL VAULT_LOCALE MODULE_DESIGN_PACK MODULE_CHANNEL_PUBLISH \
  MODULE_SOCIAL_BROWSER MODULE_TRANSPORT_DAEMON MODULE_VAULT_WEB \
  MODULE_INSTAGRAM_DM MODULE_YOUTUBE_COMMENTS \
  CHANNEL_ID SITE_PASSWORD ACTIVE_ROLES AGENT_ROLE; do
  write_shell_value "$CONFIG_FILE" "$name"
done
chmod 600 "$CONFIG_FILE"

PROFILE_FILE="$H/.agent-profile.env"
: > "$PROFILE_FILE"
for name in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS \
  OWNER_EMAIL BOT_USERNAME TIMEZONE CALENDAR_EMAIL VAULT_LOCALE \
  TG_DROP_PENDING_ON_BOOT TG_CORPORATE_SESSIONS; do
  write_shell_value "$PROFILE_FILE" "$name"
done
chown "$AGENT_USER:$AGENT_USER" "$PROFILE_FILE"
chmod 600 "$PROFILE_FILE"
umask "${secrets_umask:-022}"
rm -f /home/claude/.cash-agent.env

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
  existing_crontab="$(crontab -u "$AGENT_USER" -l 2>/dev/null || true)"
  # Boxes installed before the managed markers existed still carry those same
  # entries outside the block, so rewriting the block leaves a second copy behind
  # and every job runs twice — Cash was firing reminders, the watchdog, vault-sync,
  # relogin-watch and the memory index twice over (found 2026-07-28). Drop any
  # unmanaged line that invokes a job this block owns.
  unmanaged_crontab="$(printf '%s\n' "$existing_crontab" | awk \
    -v legacy_health="$H/bin/cash-health-evening" \
    -v owned="$H/bin/cash-reminder-tick $H/bin/cash-healthcheck $H/bin/claude-limit-recovery $H/bin/relogin-watch $H/bin/unstick-watch $H/bin/telegram-inbox-prune $H/bin/vault-sync $H/bin/memory-index $H/bin/learning-review $H/bin/onboarding-reminder $H/bin/skill-brief $H/bin/agent-github-backup" '
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
  echo "17 4 * * * /usr/bin/timeout 30 $H/bin/telegram-inbox-prune"
  echo "23 4 * * * find $H/telegram-outbox -xdev -type f -mtime +7 -delete"
  echo "*/5 * * * * /usr/bin/timeout 60 $H/bin/vault-sync"
  # The prompt hook searches with --no-refresh to keep Telegram latency low, so
  # this recurring pass must include both vault notes and new Telegram history.
  echo "*/10 * * * * /usr/bin/timeout 60 $H/bin/memory-index index >/dev/null"
  # The helper itself maps UTC to the owner's declared timezone and records each
  # 09:00/21:00 slot, so DST and repeated installer runs cannot duplicate a backup.
  echo "7 * * * * /usr/bin/timeout 300 $H/bin/agent-github-backup scheduled >/dev/null 2>&1"
  # Daily tick; the helper spaces the nudges itself (a day after install, then weekly).
  echo "13 11 * * * /usr/bin/timeout 30 $H/bin/onboarding-reminder"
  echo "# END claude-tg-starter"
} | sed '/^[[:space:]]*$/N;/^\n$/D' | crontab -u "$AGENT_USER" -
}

echo "[5/7] зберігаю наявний crontab; замінюю лише керований блок"
if [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ]; then
  echo "      режим обслуговування: залишаю зупинений crontab без змін"
else
  install_managed_crontab
fi

# The command menu has to match what actually works, or the owner is guessing —
# Cash ran for months with an empty menu while /fix and /relogin existed.
runuser -u "$AGENT_USER" -- env HOME="$H" "$H/bin/set-tg-commands" || \
  echo "      WARN: не вдалося опублікувати меню команд Telegram (повтор: ~/bin/set-tg-commands)"

echo "[6/7] необов’язкові інструменти"

if product_has_feature google-workspace && ! command -v gog >/dev/null 2>&1; then
  bash "$KIT/scripts/install-gog.sh"
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
    runuser -u "$AGENT_USER" -- env HOME="$H" \
      PIPX_HOME="$H/.local/share/pipx" PIPX_BIN_DIR="$H/.local/bin" \
      pipx install yt-dlp >/dev/null
  fi
  [ -x "$H/.local/bin/yt-dlp" ] || {
    echo "FATAL: yt-dlp не встановлено" >&2
    exit 1
  }
  if [ ! -x "$H/.local/bin/deno" ]; then
    runuser -u "$AGENT_USER" -- env HOME="$H" \
      npm install -g --prefix "$H/.local" deno >/dev/null
  fi
  [ -x "$H/.local/bin/deno" ] || {
    echo "FATAL: Deno не встановлено" >&2
    exit 1
  }
fi

if product_has_feature vercel; then
  runuser -u "$AGENT_USER" -- env HOME="$H" \
    npm install -g --prefix "$H/.npm-global" vercel@latest >/dev/null
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

if product_has_feature telegram-corporate-sessions; then
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

echo "✅ Ядро встановлено: керовані ресурси оновлено, дані власника збережено, перевірки пройдено."
