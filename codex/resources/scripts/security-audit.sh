#!/usr/bin/env bash
# Redacted host audit: reports state and permissions, never secret contents.
set -uo pipefail

failures=0
warnings=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warnings=$((warnings + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
section() { printf '\n[%s]\n' "$*"; }

section firewall
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  pass "UFW active"
  ufw status numbered
else
  fail "UFW inactive or unavailable"
fi

section ssh
if command -v sshd >/dev/null 2>&1; then
  effective="$(sshd -T 2>/dev/null || true)"
  printf '%s\n' "$effective" | grep -E '^(port|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|permitrootlogin|maxauthtries|x11forwarding) '
  # Password SSH stays on by design: it is the owner's recovery path from a
  # phone or a borrowed computer. Key-only login is never a goal of this audit.
  if printf '%s\n' "$effective" | grep -qx 'passwordauthentication yes'; then
    pass "password SSH enabled (owner recovery path; brute force is limited by UFW rate limit + fail2ban)"
  else
    warn "password SSH disabled — the owner cannot log in without the key; re-enable it unless the owner explicitly asked for key-only access"
  fi
else
  fail "sshd unavailable"
fi

section brute-force-protection
if systemctl is-active --quiet fail2ban && fail2ban-client status sshd >/dev/null 2>&1; then
  pass "fail2ban sshd jail active"
  fail2ban-client status sshd | sed -n '1,12p'
else
  fail "fail2ban sshd jail inactive"
fi

section security-updates
if systemctl is-enabled --quiet apt-daily.timer && systemctl is-enabled --quiet apt-daily-upgrade.timer; then
  pass "automatic security update timers enabled"
else
  fail "automatic security update timers disabled"
fi
[ ! -e /var/run/reboot-required ] || warn "reboot required for installed updates"

section listening-sockets
ss -lntup

section secret-permissions
for path in /etc/claude-tg-starter/agent.env /home/claude/.claude/channels/telegram/.env; do
  if [ -e "$path" ]; then
    mode="$(stat -c %a "$path")"
    owner="$(stat -c %U:%G "$path")"
    printf 'permissions=%s owner=%s path=%s\n' "$mode" "$owner" "$path"
    [ "$mode" = 600 ] || fail "secret file permissions must be 600: $path"
  else
    warn "secret file not created yet: $path"
  fi
done

section summary
printf 'failures=%d warnings=%d\n' "$failures" "$warnings"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
if [ "${AUDIT_STRICT:-0}" = 1 ] && [ "$warnings" -gt 0 ]; then
  exit 2
fi
