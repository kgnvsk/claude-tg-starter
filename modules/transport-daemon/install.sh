#!/usr/bin/env bash
# install.sh — enable (or disable) the transport-daemon module on a DEPLOYED agent.
# Run as ROOT on the target server, from the kit dir.
#   bash modules/transport-daemon/install.sh           # enable
#   bash modules/transport-daemon/install.sh disable    # revert to default bot.start()
#
# Enable splits the Telegram receive loop into a lingered systemd-USER daemon and flips
# the plugin into TG_TRANSPORT=daemon (drain) mode — only the daemon polls, no 409. The
# default path is untouched until you run this; `disable` rolls fully back. Restarts the
# bot, so run at deploy/maintenance time (interrupts any in-flight conversation).
set -euo pipefail

MOD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H=/home/claude
UNIT_USER="$H/.config/systemd/user/cash-tg-receiver.service"
DROPIN=/etc/systemd/system/claude-telegram.service.d/transport-daemon.conf
ACTION="${1:-enable}"

# systemctl --user from root needs the user's runtime bus; runuser alone doesn't set it.
as_claude(){ runuser -l claude -c "export XDG_RUNTIME_DIR=/run/user/$(id -u claude); $1"; }

if [ "$ACTION" = "disable" ]; then
  echo "==> transport-daemon: DISABLE (back to default bot.start)"
  as_claude 'systemctl --user disable --now cash-tg-receiver.service 2>/dev/null || true'
  rm -f "$DROPIN"
  systemctl daemon-reload
  systemctl restart claude-telegram.service
  echo "✅ reverted — plugin polls via bot.start() again."
  exit 0
fi

echo "==> transport-daemon: ENABLE"

# 1. daemon code next to the channel secrets (the unit's EnvironmentFile lives there)
install -m644 -o claude -g claude "$MOD/tg-receiver-daemon.ts" \
        "$H/.claude/channels/telegram/tg-receiver-daemon.ts"

# 2. user unit + linger → runs with no login/session, OS-supervised
install -d -o claude -g claude "$H/.config/systemd/user"
install -m644 -o claude -g claude "$MOD/cash-tg-receiver.service" "$UNIT_USER"
loginctl enable-linger claude

# 3. flip the plugin into drain mode via a drop-in on the system service
install -d /etc/systemd/system/claude-telegram.service.d
cat > "$DROPIN" <<'EOF'
[Service]
Environment=TG_TRANSPORT=daemon
EOF
systemctl daemon-reload

# 4. restart the plugin FIRST so it re-reads env → drain mode (stops polling), THEN start
#    the daemon as the SOLE poller. This order avoids a brief 409 (two pollers at once).
systemctl restart claude-telegram.service
as_claude 'systemctl --user daemon-reload && systemctl --user enable --now cash-tg-receiver.service'

echo "✅ transport-daemon enabled."
echo "   daemon: runuser -l claude -c 'systemctl --user status cash-tg-receiver'"
echo "   plugin: TG_TRANSPORT=daemon, drains ~/.claude/channels/telegram/daemon-inbox/"
echo "   revert: bash $0 disable"
