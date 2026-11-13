#!/usr/bin/env bash
# One selected Claude agent. Existing shared HTTP/browser state is never migrated implicitly.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "FATAL: run as root" >&2; exit 1; }
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Exact pin only; the helper validates identity, config precedence and immutable runtime ownership.
PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-0.0.78}"
exec python3 "$KIT/assets/browser/private-browser.py" setup --kit "$KIT" \
  --agent "${AGENT_USER:-claude}" --version "$PLAYWRIGHT_MCP_VERSION"
