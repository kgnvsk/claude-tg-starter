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
#
# Two callers, and the four arguments are their contract: install-core runs this as the agent, and Novsky's role switch
# runs it as root on the server (role-switch.ts), in every Novsky build already in the field.
set -euo pipefail

KIT="$1"; H="$2"; AGENT_USER="$3"; ACTIVE_ROLES="${4:-}"
AGENTS_DIR="$H/.claude/agents"
BASELINE="$H/.claude/product/managed-agents-baseline.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The files are written with the agent's own rights whoever calls. As root this hands the two folders to the agent,
# following no link, and starts again as the agent: root changes nothing by a name in the agent's folders, where a name
# swapped for a link sent its write or its change of owner elsewhere (security review, 26.11.2026). An account that is
# root itself has nothing to drop to: starting again would never end.
if [ "$(id -u)" = 0 ] && [ "$(id -u "$AGENT_USER")" != 0 ]; then
  python3 "$SCRIPT_DIR/agent-home.py" "$H" "$AGENT_USER" adopt "$AGENTS_DIR" "$H/.claude/product"
  exec runuser -u "$AGENT_USER" -- env HOME="$H" bash "$SCRIPT_DIR/activate-role-subagents.sh" "$KIT" "$H" "$AGENT_USER" "$ACTIVE_ROLES"
fi
python3 "$SCRIPT_DIR/reconcile-managed-skills.py" agents \
  "$AGENTS_DIR" "$KIT/assets/agents" "$BASELINE" --active-roles "$ACTIVE_ROLES"
