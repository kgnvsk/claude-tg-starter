#!/usr/bin/env bash
# Install a pinned Playwright MCP runtime under a dedicated OS user.
set -euo pipefail

# This kit sets up the primary agent's browser (the claude account) only. Novsky since 25.10 passes AGENT_USER to give
# a subordinate its own browser, which needs the per-agent browser of the 24.10 line: here such a run stopped and
# restarted the primary bot, registered the browser for it and then failed (Kristof, 31.10.2026). Refused first.
if [ -n "${AGENT_USER:-}" ] && [ "$AGENT_USER" != claude ]; then
  echo "FATAL: this kit sets up the browser of the primary agent (claude) only, not of $AGENT_USER" >&2
  exit 1
fi
[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root" >&2; exit 1; }
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.78}"
RUNTIME=/opt/claude-browser
STATE=/var/lib/claude-browser
SHARE=/srv/claude-browser-share
CLAUDE_HOME=/home/claude
CLAUDE_BIN="$CLAUDE_HOME/.local/bin/claude"

"$KIT/assets/lib/install-env" /root node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "FATAL: Node.js 22+ is required" >&2; exit 1; }
id claude >/dev/null 2>&1 || { echo "FATAL: install the claude user first" >&2; exit 1; }
id claude-browser >/dev/null 2>&1 || useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin claude-browser
usermod -a -G claude-browser claude

install -d -o root -g root -m 755 "$RUNTIME"
install -d -o claude-browser -g claude-browser -m 755 "$STATE" "$STATE/ms-playwright" "$STATE/output"
install -d -o claude-browser -g claude-browser -m 700 "$STATE/profile"
install -d -o claude -g claude-browser -m 2770 "$SHARE"
# Root's directories and copies in the agent's home follow no link the agent planted (Codex, 20.11.2026).
AGENT_HOME_WRITE=(python3 "$KIT/assets/lib/agent-home.py" "$CLAUDE_HOME" claude)
"${AGENT_HOME_WRITE[@]}" dir 755 "$CLAUDE_HOME/bin"

echo "==> installing pinned @playwright/mcp@$PLAYWRIGHT_MCP_VERSION"
"$KIT/assets/lib/install-env" /root PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$RUNTIME" --omit=dev --no-audit --no-fund \
  "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION"
PW_CLI="$RUNTIME/node_modules/playwright/cli.js"
[ -f "$PW_CLI" ] || { echo "FATAL: Playwright CLI not found at $PW_CLI" >&2; exit 1; }

echo "==> installing exact browser dependencies"
"$KIT/assets/lib/install-env" /root node "$PW_CLI" install-deps chromium
echo "==> installing exact Chromium revision as claude-browser"
runuser -u claude-browser -- "$KIT/assets/lib/install-env" "$STATE" PLAYWRIGHT_BROWSERS_PATH="$STATE/ms-playwright" \
  node "$PW_CLI" install chromium
chmod -R a+rX "$STATE/ms-playwright"

install -m 644 "$KIT/assets/browser/browser-smoke.mjs" "$RUNTIME/browser-smoke.mjs"
install -m 644 "$KIT/assets/browser/browser-mcp-smoke.mjs" "$RUNTIME/browser-mcp-smoke.mjs"
install -m 644 "$KIT/assets/systemd/claude-browser.service" /etc/systemd/system/claude-browser.service
"${AGENT_HOME_WRITE[@]}" copy 755 "$KIT/assets/bin/browser-doctor" "$CLAUDE_HOME/bin/browser-doctor"
"${AGENT_HOME_WRITE[@]}" copy 755 "$KIT/assets/bin/browser-pdf.mjs" "$CLAUDE_HOME/bin/browser-pdf.mjs"
"${AGENT_HOME_WRITE[@]}" copy 755 "$KIT/assets/bin/html-to-pdf" "$CLAUDE_HOME/bin/html-to-pdf"
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
# A drop-in that replaces ExecStart starts the service its own way, and this script leaves drop-ins alone. What
# counts is the command that really runs, not the text of a unit.
ps -ww -u claude-browser -o args= | awk '/playwright-mcp/ && / --shared-browser-context( |$)/ { found = 1 } END { exit !found }' || \
  echo "WARN: claude-browser.service is started without --shared-browser-context (a drop-in replaces ExecStart?): the bot's own session and its scheduled tasks cannot use the browser at the same time" >&2

echo "==> running real DOM + screenshot smoke as isolated browser user"
runuser -u claude-browser -- "$KIT/assets/lib/install-env" "$STATE" PLAYWRIGHT_BROWSERS_PATH="$STATE/ms-playwright" \
  node "$RUNTIME/browser-smoke.mjs"

echo "==> exercising Playwright through the MCP protocol"
runuser -u claude-browser -- "$KIT/assets/lib/install-env" "$STATE" \
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

# A reinstall (an update of an agent that lost its browser) finds the MCP already registered: Claude CLI is not started
# then, so neither the bot nor the login is touched (a Claude CLI call in the login's renewal window can wipe it). The
# agent's own file is read as the agent, and anything but the exact entry counts as not registered.
registered="$(runuser -u claude -- timeout 10 python3 -I -c 'import json,os,stat,sys
try:
    st = os.lstat(sys.argv[1])
    if not stat.S_ISREG(st.st_mode) or st.st_size > 8 * 1024 * 1024:
        raise ValueError("not a plain settings file")
    d = json.load(open(sys.argv[1], encoding="utf-8"))
    s = d.get("mcpServers") if isinstance(d, dict) else None
    s = s.get("playwright") if isinstance(s, dict) else None
except Exception:
    s = None
print("yes" if isinstance(s, dict) and s.get("type") == "http" and s.get("url") == "http://localhost:8931/mcp" else "no")' "$CLAUDE_HOME/.claude.json" 2>/dev/null || echo no)"
if [ "$registered" = yes ]; then
  echo "==> Claude already has the localhost-only HTTP MCP"
  # BEGIN bot browser group
  # A bot started before claude joined claude-browser above cannot read the browser's group-only screenshots: a running
  # bot read for sure to lack the group restarts to take it; anything not read for sure leaves it alone (Codex, 20.11.2026).
  browser_gid="$(getent group claude-browser | cut -d: -f3)" || browser_gid=
  bot_pid="$(systemctl show -p MainPID --value claude-telegram.service 2>/dev/null)" || bot_pid=
  has_group=
  if [ -n "$browser_gid" ] && [ -n "$bot_pid" ] && [ "$bot_pid" != 0 ]; then
    has_group="$(awk -v gid="$browser_gid" '/^Groups:/ { seen = 1; for (i = 2; i <= NF; i++) if ($i == gid) found = 1 }
      END { if (seen) print (found ? "yes" : "no") }' "/proc/$bot_pid/status" 2>/dev/null)" || has_group=
  fi
  bot_pid_now="$(systemctl show -p MainPID --value claude-telegram.service 2>/dev/null)" || bot_pid_now=
  if [ "$has_group" = no ] && [ "$bot_pid_now" = "$bot_pid" ]; then
    echo "==> restarting the bot: it was started before claude joined claude-browser"
    systemctl try-restart claude-telegram.service
  fi
  # END bot browser group
else
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
fi

runuser -u claude -- env HOME="$CLAUDE_HOME" PATH="$CLAUDE_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  "$CLAUDE_HOME/bin/browser-doctor"

echo "Browser runtime ready: Playwright MCP $PLAYWRIGHT_MCP_VERSION, isolated localhost service."
