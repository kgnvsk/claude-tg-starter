#!/usr/bin/env bash
# Restore files captured by harden-server.sh. Run from an open recovery SSH session.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root" >&2; exit 1; }
BACKUP_ROOT=/var/backups/claude-tg-starter/security
BACKUP_DIR="${1:-$(readlink -f "$BACKUP_ROOT/latest" 2>/dev/null || true)}"
[ -d "$BACKUP_DIR" ] || { echo "FATAL: backup directory not found" >&2; exit 1; }

restore_file() {
  local target="$1" relative="${1#/}" saved="$BACKUP_DIR/${1#/}"
  if [ -e "$BACKUP_DIR/$relative.missing" ]; then
    rm -f "$target"
  elif [ -e "$saved" ]; then
    install -d "$(dirname "$target")"
    rm -f "$target"
    cp -a "$saved" "$target"
  fi
}

for target in \
  /etc/ssh/sshd_config.d/00-claude-tg-starter-hardening.conf \
  /etc/fail2ban/jail.d/claude-tg-starter.conf \
  /etc/apt/apt.conf.d/52claude-tg-starter-security \
  /etc/sysctl.d/99-claude-tg-starter-security.conf \
  /etc/ufw/ufw.conf /etc/ufw/user.rules /etc/ufw/user6.rules; do
  restore_file "$target"
done

sshd -t
systemctl reload ssh
sysctl --system >/dev/null
systemctl restart fail2ban 2>/dev/null || true
if command -v ufw >/dev/null 2>&1; then
  if grep -q '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null; then
    ufw reload
  else
    ufw --force disable
  fi
fi

echo "Rollback complete from $BACKUP_DIR"
echo "Keep this SSH session open and verify a fresh connection before closing it."
