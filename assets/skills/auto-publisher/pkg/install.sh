#!/bin/bash
# StreamPost interactive installer.
# Run on a fresh VPS as root (or via sudo). Asks for the few values the bot
# cannot infer, writes .env + configs/admin.json, installs systemd, starts.

set -eu

echo ""
echo "════════════════════════════════════════"
echo "  StreamPost installer"
echo "════════════════════════════════════════"
echo ""

# 1) System deps
apt-get update
apt-get install -y python3 python3-pip git curl

# 2) Project dir
TARGET=/opt/streampost
if [ ! -d "$TARGET" ]; then cp -r . "$TARGET"; fi   # пакет вшит в кит
cd "$TARGET"

# 3) Python deps
pip3 install --break-system-packages -r requirements.txt 2>/dev/null || pip3 install -r requirements.txt

# 4) Interactive setup
echo ""
echo "Now I need a few values from you."
echo "Open https://my.telegram.org for the API ID/Hash, and @BotFather for the bot token."
echo ""
read -p "Telegram API ID:               " TG_API_ID
read -p "Telegram API Hash:             " TG_API_HASH
read -p "Bot token (from @BotFather):   " BOT_TOKEN
read -p "Target channel ID (-100xxxxx): " TARGET_CHANNEL
read -p "Your Telegram user_id (first admin): " ADMIN_UID
read -p "LLM mode [claude-max|api-key] (default claude-max): " LLM_MODE
LLM_MODE=${LLM_MODE:-claude-max}

# 5) Write .env
cat > .env <<EOF
TELEGRAM_API_ID=$TG_API_ID
TELEGRAM_API_HASH=$TG_API_HASH
TELEGRAM_BOT_TOKEN=$BOT_TOKEN
EOF

if [ "$LLM_MODE" = "api-key" ]; then
  read -p "Anthropic API key: " API_KEY
  echo "ANTHROPIC_API_KEY=$API_KEY" >> .env
else
  cat >> .env <<EOF
OPENCLAW_GATEWAY_URL=http://127.0.0.1:3456
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_MODEL=claude-sonnet-4-6
EOF
fi

# 6) Write configs/admin.json
mkdir -p configs/examples
python3 - <<PY
import json
cfg = {
  "admin_user_ids": [int("$ADMIN_UID")],
  "target_channel_id": int("$TARGET_CHANNEL"),
  "target_channel_name": "user-channel",
  "safe_mode": True,
  "require_confirm": ["pause", "test_post", "remove_source"],
  "rate_limit_per_min": 10
}
json.dump(cfg, open("configs/admin.json", "w"), ensure_ascii=False, indent=2)
PY

# 7) Telethon session (interactive — user enters SMS code)
echo ""
echo "Telegram will text a login code. Type it when asked."
python3 create_session.py

# 8) Claude Code (only if LLM mode = claude-max)
if [ "$LLM_MODE" = "claude-max" ]; then
  if ! command -v claude >/dev/null 2>&1; then
    echo ""
    echo "Installing Claude Code..."
    curl -fsSL https://claude.ai/install.sh | bash || true
  fi
  echo ""
  echo "⚠️  Now run:   claude   →   /login"
  echo "    Sign in with the Claude Max account that should pay for LLM calls."
  echo "    Then come back and run:"
  echo "      systemctl restart streampost"
fi

# 9) systemd
cp systemd/streampost.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable streampost
systemctl start streampost

echo ""
echo "✅ Installed."
echo "Check:    systemctl status streampost"
echo "Logs:     journalctl -u streampost -f"
echo "Open DM with your bot and send /start."
