# Dependencies a kit update keeps but never downloads, checked by install-core right after the stop and by
# `update.sh --preflight-all` on the live agent, so that every missing one is a wall before the service stops
# (partner, 16.10: the window stopped on gh, then on ~/.venvs/heif, each after the stop). Nothing here writes.
# The caller sets KIT, H, AGENT_USER, CLAUDE_UPDATE_MAINTENANCE, MODULE_TELEGRAM_CORPORATE, MODULE_INSTAGRAM_DM and
# defines product_has_feature.

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
  runuser -u "$AGENT_USER" -- "$KIT/assets/lib/install-env" "$H" "$python" -I -B -c "$import_check" >/dev/null 2>&1 || {
    echo "FATAL: середовище $name не працює; оновлення комплекту зупинено" >&2
    return 1
  }
}

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
  version="$(runuser -u "$AGENT_USER" -- "$KIT/assets/lib/install-env" "$H" \
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

# Names every missing dependency, not only the first one.
verify_maintenance_dependencies() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] || return 0
  local status=0
  maintenance_require_command gh || status=1
  maintenance_require_command sqlite3 || status=1
  "$KIT/assets/lib/install-env" /root /usr/bin/python3 -B -c 'import numpy, markdown' >/dev/null 2>&1 || {
    echo "FATAL: системні Python-залежності пам’яті відсутні; оновлення комплекту зупинено" >&2
    status=1
  }
  if product_has_feature telegram-corporate-sessions; then
    maintenance_require_python heif 'from PIL import Image; from pillow_heif import register_heif_opener' || status=1
    if [ "$MODULE_TELEGRAM_CORPORATE" = 1 ]; then
      maintenance_require_command bwrap || status=1
      maintenance_require_command socat || status=1
    fi
  fi
  if product_has_feature sql-readonly; then
    maintenance_require_python bigquery 'from google.cloud import bigquery' || status=1
  fi
  if product_has_feature finance-data; then
    maintenance_require_python finance 'import yfinance' || status=1
  fi
  if product_has_feature spreadsheets; then
    maintenance_require_python spreadsheets 'import openpyxl, xlsxwriter' || status=1
  fi
  if product_has_feature media-downloads; then
    [ -x "$H/.local/bin/yt-dlp" ] && [ -x "$H/.local/bin/deno" ] || {
      echo "FATAL: yt-dlp або Deno відсутній; оновлення комплекту зупинено" >&2
      status=1
    }
  fi
  if [ "$MODULE_INSTAGRAM_DM" = 1 ]; then
    maintenance_require_python instagram-dm 'import fastapi, uvicorn' || status=1
  fi
  if product_has_feature video-edit; then
    AGENT_USER="$AGENT_USER" CLAUDE_UPDATE_MAINTENANCE=1 \
      bash "$KIT/scripts/install-video-edit.sh" --preflight-maintenance || status=1
  fi
  return "$status"
}

# The retired Graphify extension may contain owner data, and a missing gog
# would make the installer download into /usr/local/bin. Neither action belongs
# to a kit update. Decide before package, runtime, or configuration writes.
verify_external_side_effects() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] || return 0
  local status=0
  if [ -e /opt/claude-graphify ] || [ -L /opt/claude-graphify ]; then
    echo "FATAL: Graphify вже встановлено; перевір його дані окремо перед оновленням комплекту" >&2
    status=1
  fi
  if product_has_feature google-workspace && ! command -v gog >/dev/null 2>&1; then
    echo "FATAL: gog відсутній; віднови Google CLI окремо перед оновленням комплекту" >&2
    status=1
  fi
  return "$status"
}
