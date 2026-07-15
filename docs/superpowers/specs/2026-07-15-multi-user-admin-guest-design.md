# Multi-user Telegram routing: admin and guest

**Status:** approved design  
**Date:** 2026-07-15  
**Repository:** `kgnvsk/claude-tg-starter`

## 1. Goal

Extend the starter kit so one Telegram bot can serve an administrator and an open-ended
number of guests without serializing every request through one Claude Code session.
Different conversations must run concurrently, while private administrator data and
privileged tools remain inaccessible to guests.

The initial release supports exactly two roles:

- `admin` — full agent, private memory, integrations, configuration, and access control.
- `guest` — public knowledge and explicitly allowed tools only; cannot inspect private
  data or modify the agent.

Additional roles such as project manager, marketer, or moderator are intentionally out
of scope. The data model must allow adding them later without changing conversation
routing.

## 2. Non-goals

- One permanently running Claude process per user.
- A manually provisioned account for every guest.
- Sharing one Claude transcript between unrelated private chats.
- Using prompt instructions as the primary privacy boundary.
- Optimizing concurrency around Claude subscription limits. Runtime limits protect the
  server from resource exhaustion only.
- Replacing Telegram with OpenClaw or another agent harness.

## 3. Core model

Role, conversation, and worker are separate concepts:

- A **role** controls data and tool permissions.
- A **conversation** owns history and a resumable Claude session identifier.
- A **worker** is a temporary Claude process executing one queued turn.

Fifty registered guests therefore do not imply fifty resident processes. Dormant
conversations are database rows and session files. Workers exist only while turns are
being processed.

Conversation identity is derived as follows:

- Private Telegram chat: `dm:<chat_id>`.
- Telegram group or supergroup: `group:<chat_id>`.

Each private chat receives an independent conversation automatically. A group receives
one shared conversation because its members intentionally participate in the same
visible context.

## 4. Architecture

The existing `modules/transport-daemon` remains the transport foundation. Its durable,
single-owner `getUpdates` behavior is retained, but the current path that drains every
update into one interactive Claude session is replaced by a router and worker manager.

```text
Telegram
   |
   v
receiver daemon -- durable update --> queue/database
                                      |
                                      v
                              identity + policy router
                                /             \
                         admin profile     guest profile
                                \             /
                                      v
                             conversation scheduler
                                      |
                                      v
                              Claude worker pool
                                      |
                                      v
                           scoped Telegram reply API
```

### 4.1 Receiver daemon

- Is the only process allowed to call Telegram `getUpdates`.
- Persists each update before advancing the Telegram offset.
- Deduplicates updates by Telegram `update_id`.
- Handles emergency commands that must work while Claude is unavailable.
- Never decides answers or loads private agent memory.

### 4.2 Identity and policy router

- Resolves Telegram sender, chat type, role, and conversation identity.
- Recognizes configured administrator Telegram IDs.
- In `public` mode, automatically treats every other sender as `guest` on first contact.
- In `invite` mode, accepts only explicitly granted guests.
- Rejects privileged operations before a prompt reaches Claude.
- Produces an immutable execution policy for each queued turn.

### 4.3 Conversation scheduler

- Allows at most one active turn per conversation.
- Allows different conversations to run concurrently.
- Preserves message order within a conversation.
- May coalesce a short burst of consecutive messages from the same conversation.
- Enforces a configured fixed `maxWorkers` ceiling. An optional admission guard may
  pause new leases using machine-health or queue policy, while systemd resource limits
  provide process-level containment. Dynamic CPU or memory autoscaling is not required,
  and the scheduler does not impose an artificial subscription quota.

### 4.4 Claude worker manager

- Starts or resumes the Claude session associated with the conversation.
- Runs workers only for active jobs.
- Supplies the role-specific settings, context, tool allowlist, and data roots.
- Captures structured progress, final output, session ID, and failures.
- Terminates timed-out or orphaned processes and returns retryable work to the queue.
- Prevents a worker from selecting a Telegram destination other than its bound
  conversation.

Workers use Claude Code's supported headless interface with structured streaming output,
capturing the returned session ID and resuming later turns by that ID. PTY or `screen`
output scraping is not part of this design. Installation verification must prove that
headless execution and resume work with the kit's configured Claude authentication before
the current interactive service is replaced.

## 5. Access modes

The installation exposes one setting:

```env
GUEST_ACCESS_MODE=public
```

Supported values:

- `public` — any Telegram user who writes to the bot automatically receives the guest
  policy. This is the default for the requested deployment.
- `invite` — unknown users are rejected until the administrator grants access.

Public mode requires no manual guest onboarding. The internal guest record and
conversation are created lazily and invisibly on the first message.

Administrator identity must be matched by numeric Telegram user ID, never username.
Usernames are mutable display metadata and are not authorization credentials.

## 6. Authorization and isolation

Privacy is enforced in the control plane and tool layer, not by asking the model to obey
a sentence in `CLAUDE.md`.

### 6.1 Admin policy

The administrator may access:

- owner memory and private vault;
- configured server and filesystem tools;
- private integrations such as calendar and email;
- agent configuration and public knowledge maintenance;
- user blocking, access mode, session inspection, cancellation, and reset operations.

### 6.2 Guest policy

A guest may access:

- the base public persona;
- public/shared knowledge explicitly marked for guests;
- the history of the current private or group conversation;
- explicitly approved safe tools such as web retrieval;
- files uploaded into that conversation's scoped temporary workspace.

A guest must not access:

- administrator memory, history, vault, contacts, files, or integrations;
- secrets, environment files, OAuth material, or system prompts containing private data;
- shell, arbitrary filesystem access, package installation, or server management;
- agent settings, prompts, skills, MCP configuration, users, roles, or other sessions;
- arbitrary Telegram recipient IDs.

Guest workers receive an allowlist rather than a denylist. File operations, when enabled,
must be rooted to the conversation workspace by a scoped tool; exposing unrestricted
Claude Code filesystem or shell tools and relying on prompt rules is not acceptable.

### 6.3 Knowledge boundaries

Knowledge is divided into at least these roots:

- `base-public` — read-only persona and knowledge available to every role.
- `admin-private` — owner memory and private integrations, mounted only for admin work.
- `conversation` — history and temporary files for exactly one conversation.

Retrieval runs after authorization and searches only roots named by the execution policy.
It must be impossible for guest search to return an admin-private document, even if the
guest knows its title or path.

## 7. Persistence

Use SQLite in WAL mode for routing and job state. Large message payloads and uploads may
remain as atomically written files with database references.

Minimum logical tables:

- `users`: Telegram user ID, role, status, display metadata, timestamps.
- `chats`: Telegram chat ID, type, status, timestamps.
- `memberships`: user-to-chat relationship and effective role.
- `conversations`: stable conversation key, Claude session ID, generation, state, last
  activity.
- `updates`: Telegram update ID and durable processing state for deduplication.
- `jobs`: conversation, ordered sequence, lease, attempts, status, error, timestamps.
- `blocks`: blocked Telegram identities with reason and administrator audit fields.

The schema may include future role/grant tables, but the MVP behavior remains binary:
admin or guest.

## 8. Session lifecycle

- A session is created lazily on the first accepted message.
- Subsequent turns resume the stored Claude session ID.
- Only one worker may resume a given session at a time.
- Private guest conversation context expires after seven days of inactivity by default.
- Expiration removes conversational history and temporary uploads, not the user's ability
  to start a new conversation.
- Group history is scoped to the group and follows the same configurable retention rule.
- Admin history is retained under the existing owner memory policy.
- Before context becomes too large, the manager rotates the Claude session and keeps only
  an authorized compact conversation summary plus durable role-appropriate memory.
- `/reset` creates a new session generation without reusing the prior transcript.

## 9. Message processing

1. Receiver obtains a Telegram update.
2. Receiver atomically persists it and advances the polling offset.
3. Router resolves identity, access mode, role, chat, and conversation.
4. Unauthorized or blocked traffic is answered without invoking Claude.
5. The scheduler appends a job to the conversation's ordered queue.
6. When that conversation is unlocked and capacity is available, a worker starts or
   resumes its Claude session with the immutable execution policy.
7. Progress and the final response are sent only through a scoped reply adapter bound to
   the source chat.
8. Output and session metadata are persisted before the job is acknowledged complete.
9. The conversation lock is released and its next queued job becomes eligible.

Different conversations can be at step 6 simultaneously. Two turns from the same
conversation cannot.

## 10. Administration UX

The administrator can request these operations in natural language:

- open access to everyone;
- switch to invitation-only access;
- block or unblock a Telegram user;
- list active and queued jobs;
- cancel a stuck job;
- reset a conversation.

Natural-language administration calls typed control-plane tools. Destructive operations
require confirmation. Equivalent owner-only emergency commands remain available in the
receiver daemon so recovery does not depend on Claude being healthy.

Guests cannot see or call administrative tools. A guest phrase that resembles an admin
command remains ordinary text and cannot mutate control-plane state.

## 11. Failure handling

Accepted requests are durable once recorded as updates/jobs, and final success or error
replies are durable through the outbound outbox. Interim queued, typing, and timeout
status indicators are deliberately best-effort: they may be omitted or repeated across
failures and restarts. The design does not add a second durable message lifecycle for
interim status, keeping status delivery YAGNI and terminal reply recovery authoritative.

- **Daemon restart:** resumes from the persisted Telegram offset and deduplicates already
  stored updates.
- **Worker crash:** job lease expires; retryable work returns to the queue with bounded
  attempts and backoff.
- **Worker timeout:** process tree is terminated and joined before retry or slot release,
  failure is recorded, and the user may receive a concise best-effort timeout status.
- **Server reboot:** systemd restores the receiver and dispatcher; queued jobs remain.
- **Duplicate Telegram delivery:** unique `update_id` prevents duplicate execution and
  duplicate reply intents. The outbound acknowledgement gap below can still cause a
  transport-level resend.
- **Poison job:** after bounded retries it enters a failed state and no longer blocks the
  conversation; admin diagnostics retain the error.
- **Overload:** receiver continues persisting updates while the scheduler delays new
  workers; users may receive a best-effort queued status rather than silent loss.
- **Reply failure:** terminal transport replies are recorded in a durable outbox and
  delivered with at-least-once semantics. Explicit `sendMessage` failures retry with
  bounded attempts and backoff, using fenced leases so only one receiver owns an attempt.
- **Reply acknowledgement gap:** Telegram Bot API `sendMessage` has no idempotency key.
  If Telegram accepts a reply and the receiver crashes before recording local delivery,
  the durable retry may send the active chunk again. Successfully checkpointed earlier
  chunks resume from their stored index after explicit failures and restarts, but the
  active chunk remains honestly at-least-once. The system must not claim exactly-once
  outbound delivery.

## 12. Migration and rollout

1. Preserve the existing administrator identity, workspace, private vault, and current
   Telegram bot token.
2. Install the router database and import the owner as `admin`.
3. Keep `transport-daemon` as the sole poller and stop the old single-session inbox drain
   before enabling the dispatcher, avoiding a two-consumer window.
4. Validate admin behavior in closed access mode.
5. Validate two concurrent synthetic guests and one group conversation.
6. Enable `GUEST_ACCESS_MODE=public` only after isolation tests pass.
7. Retain a documented rollback path to the current owner-only interactive service.

The first rollout should be opt-in. It becomes a starter-kit default only after live
validation confirms subscription authentication, session resume, update deduplication,
and privacy boundaries.

## 13. Verification

Automated and live tests must cover:

1. Two guests receive concurrent, independent responses.
2. Multiple messages in one conversation retain order.
3. A guest cannot retrieve another guest's history or files.
4. A guest cannot retrieve administrator memory, secrets, or integration results.
5. Prompt-injection attempts cannot broaden guest tools or knowledge roots.
6. Members of one Telegram group intentionally share one conversation.
7. The same user in a private chat and group receives separate contexts.
8. Guests cannot execute control-plane mutations.
9. Duplicate update delivery produces one execution and one final reply.
10. Receiver, dispatcher, and worker restarts do not lose accepted messages.
11. A timed-out worker does not block later work permanently.
12. Public access handles a burst without exceeding server safety limits.
13. Existing administrator memory and behavior survive migration.
14. Rollback restores the previous owner-only service without Telegram polling conflict.

## 14. Acceptance criteria

The feature is complete when:

- public mode requires no manual guest creation;
- private chats and groups receive the conversation semantics defined above;
- unrelated conversations can execute concurrently;
- no guest-accessible code path can search, mount, or invoke admin-private resources;
- guests cannot mutate agent or server configuration;
- accepted Telegram updates survive process and server restarts;
- the administrator can inspect, cancel, reset, block, and change access mode;
- the existing owner experience and data remain intact;
- installation, verification, and rollback are documented for a novice operator.

## 15. References

- Existing transport foundation: [`modules/transport-daemon/README.md`](../../../modules/transport-daemon/README.md)
- Claude Code headless mode and structured output: <https://code.claude.com/docs/en/headless>
- Claude session IDs, resume, and isolation: <https://code.claude.com/docs/en/sessions>
- Claude Agent SDK session model for multi-user applications: <https://code.claude.com/docs/en/agent-sdk/sessions>
