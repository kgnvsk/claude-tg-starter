# Shared read-only system context check, used before stopping and before writes.
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
LOGROTATE_DIR="${LOGROTATE_DIR:-/etc/logrotate.d}"
INSTANCE_UNIT_TARGET="$SYSTEMD_DIR/$AGENT_SERVICE"
INSTANCE_LOGROTATE_TARGET="$LOGROTATE_DIR/cash-$AGENT_USER"
# The template the kit shipped before, byte for byte and never edited: an update may move past it. Only this
# instance's concrete unit is written afterwards; the shared template, its drop-ins and its neighbours stay as they
# are. 7d6b3d80 (22.07.2026) up to OOMPolicy=continue (10.10.2026).
STOCK_INSTANCE_UNIT_SHA256="ba1286760bd4cf6119ec3c00f41a4aaccc68411567535c5599c313e07de434d7"
# Official primary before 4457ad65 (10.10.2026, OOMPolicy=continue).
STOCK_PRIMARY_UNIT_SHA256="4937987405340b840808ea89d46fbf82af505244b94c8387bf516c51af36e414"
stock_instance_unit() {
  local sum candidate="$KIT/assets/systemd/claude-telegram@.service" known="$STOCK_INSTANCE_UNIT_SHA256"
  if [ "$AGENT_USER" = claude ]; then
    candidate="$KIT/assets/systemd/claude-telegram.service"
    known="$STOCK_PRIMARY_UNIT_SHA256"
  fi
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  cmp -s "$candidate" "$1" && return 0
  sum="$(sha256sum "$1" 2>/dev/null)" || return 1
  case " $known " in *" ${sum%% *} "*) return 0 ;; esac
  return 1
}
verify_instance_system_context() {
  [ "$CLAUDE_UPDATE_MAINTENANCE" = 1 ] || return 0
  local fragment
  fragment="$(systemctl show "$AGENT_SERVICE" --property=FragmentPath --value --no-pager 2>/dev/null)" || return 1
  case "$fragment" in
    "$SYSTEMD_DIR/claude-telegram@.service"|"$INSTANCE_UNIT_TARGET") ;;
    *) echo "FATAL: служба instance має неочікуване джерело" >&2; return 1 ;;
  esac
  if ! stock_instance_unit "$fragment"; then
    echo "FATAL: unit instance відрізняється від комплекту; потрібне ручне узгодження" >&2
    return 1
  fi
  if [ -e "$INSTANCE_UNIT_TARGET" ] || [ -L "$INSTANCE_UNIT_TARGET" ]; then
    if ! stock_instance_unit "$INSTANCE_UNIT_TARGET"; then
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
