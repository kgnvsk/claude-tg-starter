#!/usr/bin/env bash
# update.sh — pull the latest kit onto an ALREADY-DEPLOYED agent and re-apply it.
# Run as ROOT on the target server, from the kit directory (e.g. /opt/claude-tg-starter).
#
# Source-of-truth discipline: you fix things in the REPO, then run THIS to roll the
# fix onto the live agent. You never hand-edit the live agent's files (that recreates
# the drift this kit exists to kill — see README "Source of truth").
#
# What it does (all idempotent):
#   1. update the kit (git pull if this is a clone; otherwise tells you to re-sync)
#   2. re-run install-core with the SAME owner inputs (from the saved agent.env)
#   3. re-apply the golden telegram patch over the installed plugin
#   4. restart claude-telegram so the new code/config takes effect
#
# Usage:
#   ssh root@<SERVER>
#   cd /opt/claude-tg-starter && bash update.sh
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H=/home/claude
ENV_SAVED="$H/.cash-agent.env"   # install-core inputs, saved at first deploy (chmod 600)

echo "==> Обновление из кита — $KIT"

# ---- 1. update the kit ----
if [ -d "$KIT/.git" ]; then
  echo "[1/4] git pull"
  git -C "$KIT" pull --ff-only
else
  echo "[1/4] $KIT is not a git clone (rsync/scp copy)."
  echo "      Re-sync it from your machine first, then re-run update.sh, e.g.:"
  echo "        rsync -az --exclude '.git' ./ root@<SERVER>:$KIT/"
  echo "      Continuing with the kit currently on disk."
fi

# ---- 2. re-run install-core with the saved owner inputs ----
if [ ! -r "$ENV_SAVED" ]; then
  echo "FATAL: $ENV_SAVED not found." >&2
  echo "  First deploy should save the filled agent.env there (chmod 600) so updates" >&2
  echo "  can re-render placeholders. Create it from assets/templates/agent.env.example" >&2
  echo "  with this owner's values, then re-run." >&2
  exit 1
fi
echo "[2/4] re-run install-core (idempotent) with saved inputs"
set -a; . "$ENV_SAVED"; set +a

# Back-compat: boxes deployed before AGENT_NAME existed have it missing from the
# saved env → install-core would FATAL. Recover it from the rendered persona and
# persist it back (source-of-truth), so old boxes update without hand-editing.
if [ -z "${AGENT_NAME:-}" ]; then
  AGENT_NAME="$(grep -m1 'личный AI ассистент' "$H/CLAUDE.md" 2>/dev/null \
    | sed -E 's/.*ассистент +//; s/ +для .*//; s/^"//; s/"$//')"
  if [ -n "$AGENT_NAME" ]; then
    export AGENT_NAME
    grep -q '^AGENT_NAME=' "$ENV_SAVED" || printf 'AGENT_NAME=%s\n' "$AGENT_NAME" >> "$ENV_SAVED"
    echo "      AGENT_NAME отсутствовал в saved env — восстановил из персоны: $AGENT_NAME (дописал в $ENV_SAVED)"
  else
    echo "FATAL: AGENT_NAME не задан в $ENV_SAVED и не извлечён из $H/CLAUDE.md." >&2
    echo "       Допиши строку  AGENT_NAME=<имя агента>  в $ENV_SAVED и перезапусти." >&2
    exit 1
  fi
fi

bash "$KIT/assets/install-core.sh"

# ---- 3. re-apply golden telegram patch over the installed plugin ----
echo "[3/4] re-apply golden telegram server.ts over plugin (if plugin present)"
GOLDEN="$H/telegram-server-fixed.ts"
patched=0
if [ -f "$GOLDEN" ]; then
  for SRV in \
      "$H"/.claude/plugins/cache/claude-plugins-official/telegram/*/server.ts \
      "$H"/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/server.ts; do
    if [ -f "$SRV" ] && ! cmp -s "$GOLDEN" "$SRV"; then
      cp "$GOLDEN" "$SRV"; patched=$((patched+1))
      echo "      patched $SRV"
    fi
  done
fi
[ "$patched" -eq 0 ] && echo "      golden already in place (or plugin not installed yet)"
chown -R claude:claude "$H"

# ---- 4. restart the service ----
echo "[4/4] restart claude-telegram"
systemctl daemon-reload
systemctl restart claude-telegram.service || {
  echo "WARN: restart failed — is the service installed? (first deploy not done?)" >&2
}

echo "✅ update done. Verify: pgrep -af 'bun.*telegram' ; tail ~claude/logs/claude-screen.log"
