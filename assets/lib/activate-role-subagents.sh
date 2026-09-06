#!/usr/bin/env bash
# Make the kit's role subagents visible to the bot according to ACTIVE_ROLES.
#
#   activate-role-subagents.sh <KIT> <AGENT_HOME> <AGENT_USER> <ACTIVE_ROLES>
#
# Role files live in <KIT>/assets/agents/roles/<role>.md. A role listed in
# ACTIVE_ROLES (comma-separated, or "all") is installed as
# <AGENT_HOME>/.claude/agents/<role>.md; an inactive role is removed only when
# its checksum proves it unchanged. The shared applicator preserves owner edits in role
# and base subagents; a kit marker is not evidence that a file is unchanged.
# Claude Code reads the agents directory at session start: restart the bot after.
set -euo pipefail

KIT="$1"; H="$2"; AGENT_USER="$3"; ACTIVE_ROLES="${4:-}"
AGENTS_DIR="$H/.claude/agents"
BASELINE="$H/.claude/product/managed-agents-baseline.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 "$SCRIPT_DIR/reconcile-managed-skills.py" agents \
  "$AGENTS_DIR" "$KIT/assets/agents" "$BASELINE" --active-roles "$ACTIVE_ROLES"
[ ! -d "$AGENTS_DIR" ] || chown -R "$AGENT_USER:$AGENT_USER" "$AGENTS_DIR"
[ ! -f "$BASELINE" ] || chown "$AGENT_USER:$AGENT_USER" "$BASELINE"
