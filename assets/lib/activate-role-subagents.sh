#!/usr/bin/env bash
# Make the kit's role subagents visible to the bot according to ACTIVE_ROLES.
#
#   activate-role-subagents.sh <KIT> <AGENT_HOME> <AGENT_USER> <ACTIVE_ROLES>
#
# Role files live in <KIT>/assets/agents/roles/<role>.md. A role listed in
# ACTIVE_ROLES (comma-separated, or "all") is installed as
# <AGENT_HOME>/.claude/agents/<role>.md; a role not listed is removed from
# there — but only files carrying the kit marker, never the owner's own agents.
# Claude Code reads the agents directory at session start: restart the bot after.
set -euo pipefail

KIT="$1"; H="$2"; AGENT_USER="$3"; ACTIVE_ROLES="${4:-}"
MARKER='<!-- managed: kit role subagent -->'
ROLES_DIR="$KIT/assets/agents/roles"
AGENTS_DIR="$H/.claude/agents"

[ -d "$ROLES_DIR" ] || exit 0
install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 755 "$AGENTS_DIR"

is_active() {
  [ "$ACTIVE_ROLES" = "all" ] && return 0
  printf ',%s,' "$ACTIVE_ROLES" | tr -d ' ' | grep -q ",$1,"
}

installed=0; removed=0
for role_file in "$ROLES_DIR"/*.md; do
  [ -f "$role_file" ] || continue
  role="$(basename "$role_file" .md)"
  target="$AGENTS_DIR/$role.md"
  if is_active "$role"; then
    install -m 644 -o "$AGENT_USER" -g "$AGENT_USER" "$role_file" "$target"
    installed=$((installed + 1))
  elif [ -f "$target" ] && grep -qF "$MARKER" "$target"; then
    rm -f "$target"
    removed=$((removed + 1))
  fi
done
echo "рольові субагенти: активних $installed, знято $removed (ACTIVE_ROLES=${ACTIVE_ROLES:-порожньо})"
