# Agent harness architecture

This starter keeps Claude Code as the execution runtime and adds a small,
testable harness around it. The design review used Hermes Agent 0.18.2
(`v2026.7.7.2`, released 2026-07-08) as a reference, not as a dependency.

Primary references:

- https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.7.2
- https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md
- https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/goals.py

## Adapted patterns

| Hermes pattern | Starter implementation |
|---|---|
| Narrow core, capabilities at the edges | Optional modules under `modules/`; core remains Claude Code + Telegram |
| Stable, bounded prompt prefix | Character-bounded MEMORY/USER/hot files; no full vault map injection |
| Facts vs procedures | Facts in bounded memory/vault; procedures in on-demand Claude skills |
| On-demand session retrieval | Local SQLite FTS5 via `memory-search`, scoped by Telegram `chat_id` |
| Durable goals | `agent-goal` JSON state with criteria, constraints, status, and evidence |
| Skill lifecycle | Manifest packs plus `skill-doctor` metadata and unsafe-launch validation |
| Backup/restore boundary | Secret-free checksummed ZIP plus root-only allowlisted restore |
| Browser provider health | Isolated Playwright MCP with real navigation/snapshot/screenshot smoke |
| Doctor commands | Browser, memory, skill, security, and core health checks |

## Intentionally not copied

The following Hermes features are not copied because they conflict with this
starter's purpose or trust model:

- Provider/model abstraction. The runtime is native Claude Code and the owner's
  Anthropic subscription.
- Third-party Claude OAuth reuse. Authentication stays inside the official
  Claude Code login flow.
- Automatic LLM goal judging and an unbounded continuation loop. Goal completion
  requires local evidence; the agent cannot silently burn subscription limits.
- Always-on external memory providers. FTS5 is local and free.
- Mixture-of-agents calls to unrelated paid providers.
- A replacement Telegram gateway. Existing native Telegram transport remains
  the default; the queueing daemon stays optional until its own integration
  suite is complete.

## Memory contract

Always-on context has a fixed maximum:

- `USER.md`: 1,375 characters.
- `MEMORY.md`: 2,200 characters.
- `wiki/hot.md`: 2,400 characters.
- Current Telegram chat history: 12 messages and 3,500 characters.

Detailed vault notes and up to 5,000 recent Telegram rows are indexed locally.
Telegram results are returned only when the caller supplies the matching
`--chat-id`.

## Self-learning contract

Self-learning is a reviewed persistence pipeline, not permission for an online
chat to rewrite the agent. The target design uses three distinct classes:

- episodic evidence: scoped Telegram/session events in SQLite;
- semantic memory: compact durable owner/project facts in `USER.md`/`MEMORY.md`;
- procedural memory: narrow, testable Claude skills.

Only a configured administrator's private conversation may propose a global
memory or skill change. Other allowlisted Telegram turns remain attributed
evidence and cannot approve changes to owner memory, persona, permissions,
shared skills, prompts, or configuration. Automated candidates are staged with sender/chat/job provenance,
an evidence excerpt, promptware/secret scanning, expiry, and a bounded queue.
An admin can inspect, edit, approve, reject, view history, and roll back.

Repeated tool use alone is not proof that a skill was learned. A procedure is
eligible only after a concrete successful workflow or correction is recorded,
then an admin reviews the complete replacement and its acceptance evidence.
The local gate validates structure and declarative assertions; it does not
pretend to be a behavioral replay engine. Prompt or configuration changes still
need the separate release loop: trace, evaluate, diagnose, gate, replay, then
release. The supplied Hermes walkthrough itself shows memory learning but fails
to self-trigger the expected skill in one demo, which is why reviewer events and
outcomes must be observable.

This pipeline is implemented as a reviewed local workflow. `learning-review`
stores attributed candidates under `obsidian-vault/learning`, requires an admin
Telegram message for every review and decision, binds apply to reviewed hashes
and a one-time token, journals mutations for crash recovery, applies complete
replacement files, serializes each candidate, validates changes, and keeps local
rollback history. A used approval token cannot be replayed; retry starts with a
fresh preview. The
learning directory is excluded from global FTS, vault Git
sync, and portable backups because it contains attributed conversation evidence.
Its daily digest is deterministic and free: it only lists pending candidates
and never writes memory or skills. The maintained behavior is specified here
and enforced by the harness and self-learning contract tests; historical
research notes remain available in Git history.

## Goal contract

A goal is active until every completion criterion has concrete evidence.
`agent-goal complete` fails closed when a criterion is unchecked. Secrets are
rejected before persistence. This is deliberately simpler than an LLM judge:
completion remains inspectable and does not consume a hidden model budget.

## Backup contract

`agent-backup` includes persona, owner-visible settings, memory, goals, skills,
agents, and vault documents. It excludes `.env`, auth material, Telegram
transcripts, generated indexes, symlinks, and common private-key formats.
Creation and verification also fail closed on high-confidence secret-like
content. The manifest contains a SHA-256 for every member.

Restore is a separate root-only operation. It validates checksums, rejects path
traversal and symlinks, restricts targets to an allowlist under
`/home/claude`, creates a safety copy, supports `--dry-run`, and requires
`--confirm` for writes.

## Upgrade rule

Pinned third-party versions are updated only in a dedicated change that runs
contract tests and the relevant disposable-Ubuntu integration smoke. No module
may add itself to every prompt or start a recurring paid operation by default.
