#!/usr/bin/env bash
# Base system provisioning for a fresh Ubuntu VPS.
#
# onboard.sh runs this before install-core so a customer install cannot die on a
# missing system package. Everything here is idempotent: re-running is a no-op on
# a prepared box. The premium runbook documents the same steps as Phase 1/2 for
# operators who prefer to drive them by hand.
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "FATAL: install-base потрібно запускати від root" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# jq, sqlite3 and screen are load-bearing for self-healing and the service unit,
# not conveniences: without them the watchdogs go quiet and the unit cannot start.
PACKAGES=(
  git gh curl ca-certificates gnupg screen jq ffmpeg sqlite3
  python3 python3-pip python3-venv python3-numpy pipx unzip sudo cron
)

# Exact shared-library prerequisites of pinned Playwright Chromium. This is the
# fresh-host stage, before agent services; selected browser setup never runs apt.
browser_prerequisite_packages() {
  BROWSER_PACKAGES=(nftables socat fonts-liberation fonts-noto-color-emoji
    libcairo2 libdbus-1-3 libdrm2 libgbm1 libnspr4 libnss3 libpango-1.0-0
    libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2)
  case "$1:$2" in
    ubuntu:24.04|ubuntu:26.04) BROWSER_PACKAGES+=(libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64
      libatspi2.0-0t64 libcups2t64 libglib2.0-0t64) ;;
    ubuntu:22.04) BROWSER_PACKAGES+=(libasound2 libatk-bridge2.0-0 libatk1.0-0
      libatspi2.0-0 libcups2 libglib2.0-0 libwayland-client0) ;;
    *) echo 'FATAL: browser prerequisites support Ubuntu 22.04/24.04/26.04 only' >&2; return 1 ;;
  esac
}

host_has_agent_units() {
  local unit
  for unit in /etc/systemd/system/claude-telegram*.service /usr/lib/systemd/system/claude-telegram*.service \
              /lib/systemd/system/claude-telegram*.service /run/systemd/system/claude-telegram*.service; do
    if [ -e "$unit" ] || [ -L "$unit" ]; then return 0; fi
  done
  return 1
}

check_browser_host_prerequisites() {
  local package
  if host_has_agent_units; then
    for package in "${BROWSER_PACKAGES[@]}"; do
      if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$'; then
        echo 'FATAL: browser host prerequisites are missing on a host with agents; use separate host maintenance, not selected-agent setup' >&2
        return 1
      fi
    done
  fi
}

. /etc/os-release
browser_prerequisite_packages "${ID:-}" "${VERSION_ID:-}"
check_browser_host_prerequisites
PACKAGES+=("${BROWSER_PACKAGES[@]}")

packages_to_install=()
for package in "${PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$' \
    || packages_to_install+=("$package")
done

if [ "${#packages_to_install[@]}" -gt 0 ]; then
  echo "==> Встановлюю системні пакети: ${packages_to_install[*]}"
  "$KIT/assets/lib/install-env" /root DEBIAN_FRONTEND=noninteractive apt-get update
  "$KIT/assets/lib/install-env" /root DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages_to_install[@]}"
fi

# Node 22 from the signed NodeSource repository; never pipe a setup script into a
# shell. Ubuntu's own nodejs is too old for the agent runtime.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$("$KIT/assets/lib/install-env" /root node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
fi
if [ "${node_major:-0}" -lt 22 ]; then
  echo "==> Встановлюю Node.js 22"
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  cat > /etc/apt/sources.list.d/nodesource.sources <<'SOURCES'
Types: deb
URIs: https://deb.nodesource.com/node_22.x
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
SOURCES
  "$KIT/assets/lib/install-env" /root DEBIAN_FRONTEND=noninteractive apt-get update
  "$KIT/assets/lib/install-env" /root DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi

for command in git gh curl screen jq ffmpeg sqlite3 python3 node npm pipx setpriv; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "FATAL: $command досі відсутній після базового налаштування" >&2
    exit 1
  }
done
"$KIT/assets/lib/install-env" /root /usr/bin/python3 -c 'import numpy' >/dev/null 2>&1 || {
  echo "FATAL: python3-numpy недоступний для системного Python" >&2
  exit 1
}
node_major="$("$KIT/assets/lib/install-env" /root node -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge 22 ] || {
  echo "FATAL: потрібен Node.js 22+; знайдено $("$KIT/assets/lib/install-env" /root node --version)" >&2
  exit 1
}

echo "✅ Базове середовище готове: системні пакети й Node $("$KIT/assets/lib/install-env" /root node --version) встановлено."
