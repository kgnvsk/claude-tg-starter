#!/usr/bin/env bash
# Base system provisioning for a fresh Ubuntu VPS.
#
# onboard.sh runs this before install-core so a customer install cannot die on a
# missing system package. Everything here is idempotent: re-running is a no-op on
# a prepared box. The premium runbook documents the same steps as Phase 1/2 for
# operators who prefer to drive them by hand.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: install-base потрібно запускати від root" >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# jq, sqlite3 and screen are load-bearing for self-healing and the service unit,
# not conveniences: without them the watchdogs go quiet and the unit cannot start.
PACKAGES=(
  git curl ca-certificates gnupg screen jq ffmpeg sqlite3
  python3 python3-pip python3-venv python3-numpy pipx unzip sudo cron
)

packages_to_install=()
for package in "${PACKAGES[@]}"; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q '^install ok installed$' \
    || packages_to_install+=("$package")
done

if [ "${#packages_to_install[@]}" -gt 0 ]; then
  echo "==> Встановлюю системні пакети: ${packages_to_install[*]}"
  apt-get update
  apt-get install -y "${packages_to_install[@]}"
fi

# Node 22 from the signed NodeSource repository; never pipe a setup script into a
# shell. Ubuntu's own nodejs is too old for the agent runtime.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
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
  apt-get update
  apt-get install -y nodejs
fi

for command in git curl screen jq ffmpeg sqlite3 python3 node npm pipx setpriv; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "FATAL: $command досі відсутній після базового налаштування" >&2
    exit 1
  }
done
/usr/bin/python3 -c 'import numpy' >/dev/null 2>&1 || {
  echo "FATAL: python3-numpy недоступний для системного Python" >&2
  exit 1
}
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
[ "$node_major" -ge 22 ] || {
  echo "FATAL: потрібен Node.js 22+; знайдено $(node --version)" >&2
  exit 1
}

echo "✅ Базове середовище готове: системні пакети й Node $(node --version) встановлено."
