#!/usr/bin/env bash
# Install a pinned Playwright MCP runtime under a dedicated OS user.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root" >&2; exit 1; }
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.78}"
RUNTIME=/opt/claude-browser
STATE=/var/lib/claude-browser
SHARE=/srv/claude-browser-share
CLAUDE_HOME=/home/claude
CLAUDE_BIN="$CLAUDE_HOME/.local/bin/claude"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "FATAL: Node.js 22+ is required" >&2; exit 1; }
id claude >/dev/null 2>&1 || { echo "FATAL: install the claude user first" >&2; exit 1; }
id claude-browser >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin claude-browser
usermod -a -G claude-browser claude

install -d -o root -g root -m 755 "$RUNTIME"
install -d -o claude-browser -g claude-browser -m 755 "$STATE" "$STATE/ms-playwright" "$STATE/output"
install -d -o claude-browser -g claude-browser -m 700 "$STATE/profile"
install -d -o claude -g claude-browser -m 2770 "$SHARE"
install -d -o claude -g claude -m 755 "$CLAUDE_HOME/bin"

echo "==> installing pinned @playwright/mcp@$PLAYWRIGHT_MCP_VERSION"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$RUNTIME" --omit=dev --no-audit --no-fund \
  "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION"
PW_CLI="$RUNTIME/node_modules/playwright/cli.js"
[ -f "$PW_CLI" ] || { echo "FATAL: Playwright CLI not found at $PW_CLI" >&2; exit 1; }

echo "==> installing exact browser dependencies"
node "$PW_CLI" install-deps chromium
echo "==> installing exact Chromium revision as claude-browser"
runuser -u claude-browser -- env HOME="$STATE" PLAYWRIGHT_BROWSERS_PATH="$STATE/ms-playwright" \
  node "$PW_CLI" install chromium
chmod -R a+rX "$STATE/ms-playwright"

install -m 644 "$KIT/assets/browser/browser-smoke.mjs" "$RUNTIME/browser-smoke.mjs"
install -m 644 "$KIT/assets/browser/browser-mcp-smoke.mjs" "$RUNTIME/browser-mcp-smoke.mjs"
install -m 644 "$KIT/assets/systemd/claude-browser.service" /etc/systemd/system/claude-browser.service
install -m 755 -o claude -g claude "$KIT/assets/bin/browser-doctor" "$CLAUDE_HOME/bin/browser-doctor"
install -m 755 -o claude -g claude "$KIT/assets/bin/browser-pdf.mjs" "$CLAUDE_HOME/bin/browser-pdf.mjs"
install -m 755 -o claude -g claude "$KIT/assets/bin/html-to-pdf" "$CLAUDE_HOME/bin/html-to-pdf"
chown -R root:root "$RUNTIME"
chmod -R go-w "$RUNTIME"

systemctl daemon-reload
systemctl enable claude-browser.service
systemctl restart claude-browser.service
for _ in $(seq 1 30); do
  systemctl is-active --quiet claude-browser.service && ss -ltn | grep -q '127.0.0.1:8931' && break
  sleep 1
done
systemctl is-active --quiet claude-browser.service || { journalctl -u claude-browser.service -n 80 --no-pager; exit 1; }

echo "==> running real DOM + screenshot smoke as isolated browser user"
runuser -u claude-browser -- env HOME="$STATE" PLAYWRIGHT_BROWSERS_PATH="$STATE/ms-playwright" \
  node "$RUNTIME/browser-smoke.mjs"

echo "==> exercising Playwright through the MCP protocol"
runuser -u claude-browser -- env HOME="$STATE" \
  node "$RUNTIME/browser-mcp-smoke.mjs"
setpriv --reuid=claude --regid=claude --init-groups -- \
  python3 -c 'import sys; open(sys.argv[1], "rb").read(1)' "$SHARE/mcp-tool-smoke.png" || {
  echo "FATAL: browser screenshot is not readable by the Claude runtime" >&2
  exit 1
}

if [ ! -x "$CLAUDE_BIN" ]; then
  echo "FATAL: Claude CLI missing at $CLAUDE_BIN; install it before browser registration" >&2
  exit 1
fi

was_active=0
if systemctl is-active --quiet claude-telegram.service; then
  was_active=1
  systemctl stop claude-telegram.service
fi
restart_agent() {
  [ "$was_active" -eq 0 ] || systemctl start claude-telegram.service
}
trap restart_agent EXIT

echo "==> registering localhost-only HTTP MCP for Claude"
runuser -u claude -- env HOME="$CLAUDE_HOME" "$CLAUDE_BIN" mcp remove --scope user playwright >/dev/null 2>&1 || true
runuser -u claude -- env HOME="$CLAUDE_HOME" "$CLAUDE_BIN" mcp add --scope user --transport http \
  playwright http://localhost:8931/mcp
runuser -u claude -- env HOME="$CLAUDE_HOME" "$CLAUDE_BIN" mcp get playwright >/dev/null

runuser -u claude -- env HOME="$CLAUDE_HOME" PATH="$CLAUDE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "$CLAUDE_HOME/bin/browser-doctor"

echo "Browser runtime ready: Playwright MCP $PLAYWRIGHT_MCP_VERSION, isolated localhost service."
