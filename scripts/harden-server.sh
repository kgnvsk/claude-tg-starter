#!/usr/bin/env bash
# Ubuntu hardening: firewall, brute-force protection, security updates.
# Вхід за паролем не вимикається — власник має заходити з телефона й чужого компʼютера.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  harden-server.sh --baseline
  harden-server.sh --audit

Run --baseline first; воно не чіпає пароль. --audit показує стан захисту.
USAGE
}

die() { printf 'FATAL: %s\n' "$*" >&2; exit 1; }
note() { printf '==> %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "run as root"

MODE=""
SSH_ADMIN_USER="${SSH_ADMIN_USER:-root}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --baseline) MODE=baseline ;;
    --admin-user) shift; [ "$#" -gt 0 ] || die "--admin-user needs a value"; SSH_ADMIN_USER="$1" ;;
    --audit) MODE=audit ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ -n "$MODE" ] || { usage; exit 2; }

detect_ssh_port() {
  if [ -n "${SSH_CONNECTION:-}" ]; then
    printf '%s\n' "$SSH_CONNECTION" | awk '{print $4}'
    return
  fi
  /usr/sbin/sshd -T 2>/dev/null | awk '$1 == "port" && !found { print $2; found=1 }'
}

detect_operator_ip() {
  # Exempt the source IP of the session that applies the baseline.
  if [ -n "${SSH_CONNECTION:-}" ]; then
    printf '%s\n' "$SSH_CONNECTION" | awk '{print $1}'
  fi
}

SSH_PORT="${SSH_PORT:-$(detect_ssh_port)}"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] || die "could not detect SSH port; set SSH_PORT explicitly"
(( SSH_PORT >= 1 && SSH_PORT <= 65535 )) || die "invalid SSH port: $SSH_PORT"

# Whoever runs the hardening is exempt from the two controls managed here.
OPERATOR_IP="${OPERATOR_IP:-$(detect_operator_ip)}"
[[ "$OPERATOR_IP" =~ ^[0-9a-fA-F:.]+$ ]] || OPERATOR_IP=""
if [ "$MODE" = baseline ] && [ -z "$OPERATOR_IP" ] \
  && [ "${ALLOW_UNWHITELISTED_SSH:-0}" != 1 ]; then
  die "refusing baseline without an operator IP; run through SSH, set OPERATOR_IP, or explicitly set ALLOW_UNWHITELISTED_SSH=1"
fi

BACKUP_ROOT=/var/backups/claude-tg-starter/security
BACKUP_DIR="$BACKUP_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$MODE"
install -d -m 700 "$BACKUP_DIR"

backup_file() {
  local source="$1" relative="${1#/}" destination="$BACKUP_DIR/${1#/}"
  install -d -m 700 "$(dirname "$destination")"
  if [ -e "$source" ]; then
    cp -a "$source" "$destination"
  else
    : > "$BACKUP_DIR/$relative.missing"
  fi
}

record_backups() {
  local path
  for path in \
    /etc/ssh/sshd_config.d/00-claude-tg-starter-hardening.conf \
    /etc/fail2ban/jail.d/claude-tg-starter.conf \
    /etc/apt/apt.conf.d/52claude-tg-starter-security \
    /etc/sysctl.d/99-claude-tg-starter-security.conf \
    /etc/ufw/ufw.conf /etc/ufw/user.rules /etc/ufw/user6.rules; do
    backup_file "$path"
  done
  printf '%s\n' "$SSH_PORT" > "$BACKUP_DIR/ssh-port"
  ln -sfn "$BACKUP_DIR" "$BACKUP_ROOT/latest"
}

baseline() {
  record_backups
  export DEBIAN_FRONTEND=noninteractive
  note "installing firewall, brute-force protection, and security updates"
  apt-get update
  apt-get install -y ufw fail2ban unattended-upgrades

  local cloud_id=""
  if command -v cloud-id >/dev/null 2>&1; then
    cloud_id="$(cloud-id 2>/dev/null || true)"
  fi
  if [[ "$cloud_id" == *oracle* ]] && [ "${ALLOW_UFW_ON_ORACLE:-0}" != 1 ]; then
    printf 'WARN: Oracle Cloud detected; skipping UFW because Ubuntu 24.04 images may rely on provider networking.\n' >&2
    printf '      Set ALLOW_UFW_ON_ORACLE=1 only after checking the provider firewall and iSCSI setup.\n' >&2
  else
    note "enabling deny-by-default firewall; preserving SSH on port $SSH_PORT"
    ufw default deny incoming
    ufw default allow outgoing
    if [ -n "$OPERATOR_IP" ]; then
      note "exempting operator IP $OPERATOR_IP from the SSH rate limit"
      ufw allow from "$OPERATOR_IP" to any port "$SSH_PORT" proto tcp \
        comment 'operator IP — never rate-limited'
    else
      printf 'WARN: could not detect operator IP (no SSH_CONNECTION); SSH rate limit will apply to everyone, including you.\n' >&2
    fi
    ufw limit "$SSH_PORT/tcp" comment 'SSH rate limit'
    ufw logging low
    ufw --force enable
  fi

  local ignore_ips="127.0.0.1/8 ::1"
  [ -n "$OPERATOR_IP" ] && ignore_ips="$ignore_ips $OPERATOR_IP"
  cat > /etc/fail2ban/jail.d/claude-tg-starter.conf <<EOF
[sshd]
enabled = true
port = $SSH_PORT
backend = systemd
ignoreip = $ignore_ips
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban
  fail2ban-client reload >/dev/null

  cat > /etc/apt/apt.conf.d/52claude-tg-starter-security <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer

  cat > /etc/sysctl.d/99-claude-tg-starter-security.conf <<'EOF'
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
fs.protected_fifos = 2
fs.protected_regular = 2
fs.protected_hardlinks = 1
fs.protected_symlinks = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
EOF
  sysctl --system >/dev/null

  [ ! -d /home/claude/.claude ] || chmod 700 /home/claude/.claude
  for secret in /etc/claude-tg-starter/agent.env /home/claude/.claude/channels/telegram/.env; do
    [ ! -e "$secret" ] || chmod 600 "$secret"
  done

  note "listening sockets after baseline"
  ss -lntup
  printf '\nBaseline complete. Password SSH is unchanged.\n'
  if [ -n "$OPERATOR_IP" ]; then
    printf 'Your IP %s is exempt from the kit-managed fail2ban jail and UFW SSH rate limit.\n' "$OPERATOR_IP"
  else
    printf 'NOTE: operator IP was NOT auto-whitelisted. If SSH starts refusing you, see recovery below.\n'
  fi
  printf 'Locked out anyway? bans self-clear (UFW ~30s, fail2ban <=1h), or via the provider console:\n'
  printf '  fail2ban-client unban --all ; ufw disable\n'
  printf "Вхід за паролем лишається доступним: власник має заходити з телефона й чужого комп'ютера.\n"
}

case "$MODE" in
  baseline) baseline ;;
  audit) "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/security-audit.sh" ;;
esac

printf 'Backup: %s\n' "$BACKUP_DIR"
