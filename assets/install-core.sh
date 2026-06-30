#!/usr/bin/env bash
# install-core.sh — deterministic CORE install of Cash on a fresh Ubuntu VPS.
# Run as ROOT on the TARGET server, from the uploaded kit dir, with inputs exported.
# Idempotent. Fails LOUD on missing inputs or leftover placeholders/residue.
#
# Example:
#   OWNER_NAME="Alex" OWNER_TG_USERNAME="alex" OWNER_CHAT_ID="123456789" \
#   BOT_USERNAME="alex_assistant_bot" TIMEZONE="Europe/Lisbon" \
#   TELEGRAM_BOT_TOKEN="123:AA..." OPENAI_API_KEY="sk-..." \
#   bash assets/install-core.sh
set -euo pipefail

# install-core.sh lives in assets/ ; KIT = repo root (one level up)
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
H=/home/claude

# ---- required inputs ----
for v in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN; do
  [ -n "${!v:-}" ] || { echo "FATAL: required env $v is not set"; exit 1; }
done
# ---- optional (feature flags) ----
OPENAI_API_KEY="${OPENAI_API_KEY:-}"     # voice transcription
CALENDAR_EMAIL="${CALENDAR_EMAIL:-}"     # morning calendar (read locally via gcalcli; owner OAuth in Phase 6)
OWNER_EMAIL="${OWNER_EMAIL:-}"           # vault-web: vault repo git author (Vercel COMMIT_AUTHOR_REQUIRED)
VAULT_LOCALE="${VAULT_LOCALE:-en-US}"    # vault-web: Quartz locale (e.g. uk-UA). Default en-US.
DEPLOY_DATE="$(date +%F)"

echo "[1/6] user + dirs"
id claude >/dev/null 2>&1 || useradd -m -s /bin/bash claude
install -d -o claude -g claude "$H"/logs "$H"/bin "$H"/obsidian-vault \
        "$H"/.claude "$H"/.claude/skills "$H"/.claude/agents "$H"/.claude/channels/telegram

echo "[2/6] copy assets"
install -m755 -o claude -g claude "$KIT"/assets/bin/* "$H"/bin/
install -m644 -o claude -g claude "$KIT"/assets/telegram-server-fixed.ts "$H"/telegram-server-fixed.ts
install -m644 "$KIT"/assets/systemd/claude-telegram.service /etc/systemd/system/claude-telegram.service
install -m644 "$KIT"/assets/systemd/logrotate-cash /etc/logrotate.d/cash-claude
cp -a "$KIT"/assets/skills/. "$H"/.claude/skills/   # codex-imagegen, vercel-deploy, impeccable, …
cp -a "$KIT"/assets/agents/. "$H"/.claude/agents/   # native subagents (researcher example + README)
install -m644 -o claude -g claude "$KIT"/assets/templates/settings.json "$H"/.claude/settings.json
cp -a "$KIT"/assets/vault-skeleton/. "$H"/obsidian-vault/

echo "[3/6] render placeholders EVERYWHERE (persona + access + scripts + skill)"
render(){ sed -e "s|{{AGENT_NAME}}|$AGENT_NAME|g" \
              -e "s|{{OWNER_NAME}}|$OWNER_NAME|g" \
              -e "s|{{OWNER_TG_USERNAME}}|$OWNER_TG_USERNAME|g" \
              -e "s|{{BOT_USERNAME}}|$BOT_USERNAME|g" \
              -e "s|{{OWNER_CHAT_ID}}|$OWNER_CHAT_ID|g" \
              -e "s|{{TIMEZONE}}|$TIMEZONE|g" \
              -e "s|{{CALENDAR_EMAIL}}|$CALENDAR_EMAIL|g" \
              -e "s|{{DEPLOY_DATE}}|$DEPLOY_DATE|g" "$1"; }
render "$KIT"/assets/templates/CLAUDE.md.template > "$H"/CLAUDE.md
render "$KIT"/assets/templates/access.json.template > "$H"/.claude/channels/telegram/access.json
render "$H"/obsidian-vault/wiki/hot.md > "$H"/obsidian-vault/wiki/hot.md.r && mv "$H"/obsidian-vault/wiki/hot.md.r "$H"/obsidian-vault/wiki/hot.md
while IFS= read -r f; do
  render "$f" > "$f.r" && mv "$f.r" "$f"
done < <(printf '%s\n' "$H"/bin/*; find "$H"/.claude/skills -name 'SKILL.md')
chmod +x "$H"/bin/*

echo "[4/6] secrets (.env, strict KEY=value, mode 600)"
{ printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TELEGRAM_BOT_TOKEN"
  printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY"; } > "$H"/.claude/channels/telegram/.env
chmod 600 "$H"/.claude/channels/telegram/.env

# Persist the owner inputs so update.sh can re-render placeholders on later kit pulls
# (source-of-truth flow). chmod 600 — it holds the bot token.
install -m600 -o claude -g claude /dev/null "$H"/.cash-agent.env
{ for v in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID OWNER_EMAIL BOT_USERNAME TIMEZONE \
           TELEGRAM_BOT_TOKEN OPENAI_API_KEY CALENDAR_EMAIL VAULT_LOCALE; do
    printf '%s=%s\n' "$v" "${!v}"
  done; } > "$H"/.cash-agent.env
chmod 600 "$H"/.cash-agent.env

echo "[5/6] crontab (feature-flagged: calendar only if CALENDAR_EMAIL set)"
{
  echo "CRON_TZ=$TIMEZONE"; echo "TZ=$TIMEZONE"; echo
  echo "* * * * * /usr/bin/timeout 55 $H/bin/cash-reminder-tick"
  echo "*/2 * * * * /usr/bin/timeout 110 $H/bin/cash-healthcheck"
  echo "17 4 * * * find $H/.claude/channels/telegram/inbox/ -type f -mtime +2 -delete"
  if [ -n "$CALENDAR_EMAIL" ]; then
    echo "30 7 * * * /usr/bin/timeout 900 $H/bin/cash-morning-calendar"
  fi
} | crontab -u claude -

echo "[6/6] GATE: no leftover {{PLACEHOLDER}} in deployed files"
# The real failure mode is an unrendered placeholder (a missing/typo'd input). Any
# {{UPPER_SNAKE}} surviving render = abort. (No owner-specific fingerprints here —
# the kit ships fully sanitized; this gate is owner-agnostic.)
if grep -rlE '\{\{[A-Z_]+\}\}' \
     "$H"/bin "$H"/CLAUDE.md "$H"/.claude/skills "$H"/.claude/channels/telegram/access.json \
     "$H"/obsidian-vault/wiki/hot.md 2>/dev/null; then
  echo "FATAL: leftover placeholder in file(s) above (check your agent.env inputs). Aborting."; exit 1
fi
chown -R claude:claude "$H"
echo "✅ install-core OK: user+dirs+assets+render+secrets+crontab done, gate passed."
