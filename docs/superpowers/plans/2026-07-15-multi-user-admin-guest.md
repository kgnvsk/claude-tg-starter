# Multi-user Admin and Guest Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in production module that routes Telegram conversations into independent resumable Claude Code sessions, runs unrelated conversations concurrently, and enforces admin/guest data and tool boundaries.

**Architecture:** Keep one durable Telegram long-poller, persist updates and jobs in SQLite/WAL, and dispatch one ordered turn per conversation to temporary headless Claude Code workers. Private chats map to one conversation per `chat_id`; groups map to one shared conversation; role policy is resolved independently and guest workers run in safe mode with a scoped workspace and an explicit tool allowlist.

**Tech Stack:** Bun 1.3+, TypeScript, `bun:sqlite`, `bun:test`, Telegram Bot API, Claude Code headless JSON/stream output, systemd.

---

## File map

- `modules/multi-user/src/types.ts` — shared records and normalized Telegram types.
- `modules/multi-user/src/config.ts` — validated environment configuration.
- `modules/multi-user/src/store.ts` — SQLite schema, transactions, leases, sessions, blocks.
- `modules/multi-user/src/policy.ts` — admin/guest resolution and conversation keys.
- `modules/multi-user/src/telegram.ts` — Bot API client, chunked replies, attachment download.
- `modules/multi-user/src/receiver.ts` — sole `getUpdates` owner and durable ingress.
- `modules/multi-user/src/worker.ts` — role-scoped Claude CLI execution and structured output.
- `modules/multi-user/src/dispatcher.ts` — bounded parallel scheduling and retries.
- `modules/multi-user/src/admin.ts` — owner-only control commands and confirmations.
- `modules/multi-user/tests/*.test.ts` — unit and integration tests with fake Telegram/Claude.
- `modules/multi-user/systemd/*.service` — receiver and dispatcher services.
- `modules/multi-user/install.sh` — idempotent enable/disable/status installer.
- `modules/multi-user/README.md` — operator guide and rollback.
- `assets/templates/agent.env.example` — opt-in and runtime settings.
- `assets/install-core.sh` — persist the new module settings.
- `update.sh` — reapply enabled module during updates.
- `VERIFY.md`, `DEPLOY.md`, `modules/README.md` — installation and verification docs.

### Task 1: SQLite state and policy

**Files:**
- Create: `modules/multi-user/src/types.ts`
- Create: `modules/multi-user/src/config.ts`
- Create: `modules/multi-user/src/store.ts`
- Create: `modules/multi-user/src/policy.ts`
- Test: `modules/multi-user/tests/store.test.ts`
- Test: `modules/multi-user/tests/policy.test.ts`

- [ ] **Step 1: Write failing policy tests**

Cover numeric admin identity, automatic public guests, rejected unknown users in invite mode,
`dm:<chat_id>` private keys, and `group:<chat_id>` shared keys. Example assertion:

```ts
expect(resolveIdentity(cfg, privateUpdate(22, 22))).toMatchObject({
  accepted: true, role: 'guest', conversationKey: 'dm:22',
})
expect(resolveIdentity(cfg, groupUpdate(-100, 22))).toMatchObject({
  accepted: true, role: 'guest', conversationKey: 'group:-100',
})
```

- [ ] **Step 2: Run the policy tests and confirm missing-module failure**

Run: `bun test modules/multi-user/tests/policy.test.ts`
Expected: FAIL because `src/policy.ts` does not exist.

- [ ] **Step 3: Implement typed identity policy**

Define `Role = 'admin' | 'guest'`, `AccessMode = 'public' | 'invite'`, normalized chat/message
interfaces, and a pure `resolveIdentity(config, update, lookup)` function. Authorization must
compare numeric sender IDs with `ADMIN_CHAT_IDS`; Telegram usernames are metadata only.

- [ ] **Step 4: Write failing store tests**

Test schema creation, update deduplication, ordered jobs, one lease per conversation, stale
lease recovery, session generation/reset, block/unblock, and WAL mode. Use a temporary DB:

```ts
const store = new Store(join(tmp, 'state.sqlite'))
expect(store.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
expect(store.acceptUpdate(update, resolved)).toBe(true)
expect(store.acceptUpdate(update, resolved)).toBe(false)
```

- [ ] **Step 5: Implement SQLite schema and transactions**

Create the approved tables: `users`, `chats`, `memberships`, `conversations`, `updates`,
`jobs`, `blocks`, `settings`, and `pending_admin_actions`. Use unique `update_id`, monotonically
increasing per-conversation job sequence, transactional enqueue, and lease timestamps.

- [ ] **Step 6: Run foundation tests**

Run: `bun test modules/multi-user/tests/store.test.ts modules/multi-user/tests/policy.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit foundation**

```bash
git add modules/multi-user/src modules/multi-user/tests
git commit -m "feat(multi-user): add durable routing state and role policy"
```

### Task 2: Telegram ingress and attachment scoping

**Files:**
- Create: `modules/multi-user/src/telegram.ts`
- Create: `modules/multi-user/src/receiver.ts`
- Test: `modules/multi-user/tests/telegram.test.ts`
- Test: `modules/multi-user/tests/receiver.test.ts`

- [ ] **Step 1: Write failing Telegram client tests**

Use an injected `fetch` fake to verify long-poll parameters, API error propagation, 409 retry
classification, 4096-character chunking, typing actions, `getFile`, and downloads into only
`<base>/workspaces/<encoded-conversation>/uploads`.

- [ ] **Step 2: Implement the Bot API adapter**

Expose `getUpdates`, `sendMessage`, `sendTyping`, `getFile`, and `downloadAttachment`.
Sanitize filenames with `basename`, generate collision-resistant local names, reject paths
outside the resolved workspace, and write downloads atomically.

- [ ] **Step 3: Write failing receiver tests**

Verify that the receiver persists before advancing the offset, ignores duplicate update IDs,
routes private and group updates correctly, stores supported attachment metadata, and never
invokes Claude itself.

- [ ] **Step 4: Implement durable receiver loop**

Normalize message text/caption and attachments, resolve policy, persist accepted jobs, answer
blocked/invite-only users without Claude, and save the offset only after each update transaction
commits. Keep this process as the only Bot API poller.

- [ ] **Step 5: Run ingress tests and commit**

Run: `bun test modules/multi-user/tests/telegram.test.ts modules/multi-user/tests/receiver.test.ts`
Expected: PASS.

```bash
git add modules/multi-user/src modules/multi-user/tests
git commit -m "feat(multi-user): add durable Telegram ingress"
```

### Task 3: Claude worker isolation and session resume

**Files:**
- Create: `modules/multi-user/src/worker.ts`
- Create: `modules/multi-user/guest-system-prompt.md`
- Test: `modules/multi-user/tests/worker.test.ts`

- [ ] **Step 1: Write failing command-construction tests**

Admin commands must use the owner vault and configured Claude settings while preventing direct
Telegram recipient selection. Guest commands must include `--safe-mode`, `--strict-mcp-config`,
`--permission-mode dontAsk`, an empty MCP config, and only `Read`, `WebSearch`, and `WebFetch`.
The only allowed Read path must be the resolved conversation workspace.

- [ ] **Step 2: Implement role-scoped command construction**

For a new turn generate a UUID and pass `--session-id`; for later turns pass `--resume` with the
stored ID. Use `--print --output-format stream-json --verbose`. Build prompts from normalized
message text and attachment paths. Never interpolate user text into shell command strings;
spawn an argv array directly.

- [ ] **Step 3: Write failing stream parser tests**

Feed fixture JSONL containing assistant deltas, result, session ID, malformed diagnostics, and
non-zero exits. Assert one final answer, captured session ID, bounded stderr, and retryable versus
terminal error classification.

- [ ] **Step 4: Implement worker execution**

Use `Bun.spawn`, an argv array, explicit cwd/env, process-group termination, timeout, and JSONL
parsing. Return structured `WorkerResult`; never send Telegram messages from the worker.

- [ ] **Step 5: Run worker tests and commit**

Run: `bun test modules/multi-user/tests/worker.test.ts`
Expected: PASS with the Claude executable replaced by a fixture script.

```bash
git add modules/multi-user/src/worker.ts modules/multi-user/guest-system-prompt.md modules/multi-user/tests/worker.test.ts
git commit -m "feat(multi-user): isolate resumable Claude workers"
```

### Task 4: Parallel dispatcher and recovery

**Files:**
- Create: `modules/multi-user/src/dispatcher.ts`
- Test: `modules/multi-user/tests/dispatcher.test.ts`

- [ ] **Step 1: Write failing concurrency tests**

With a fake worker, prove that two conversations overlap, two jobs in one conversation do not,
worker count never exceeds `MAX_WORKERS`, retries are bounded, expired leases recover, and a poison
job does not permanently block later turns.

- [ ] **Step 2: Implement bounded scheduling**

Poll eligible jobs, acquire transactional conversation leases, execute up to `MAX_WORKERS`, send
typing heartbeats, persist session/result before completion, and release locks in `finally`.

- [ ] **Step 3: Implement replies and error paths**

Chunk final text through the Telegram adapter. Record outbound attempts separately from execution.
On overload leave jobs queued; on timeout retry with backoff; after `MAX_ATTEMPTS`, fail the poison
job and continue the conversation queue.

- [ ] **Step 4: Run dispatcher tests and commit**

Run: `bun test modules/multi-user/tests/dispatcher.test.ts`
Expected: PASS.

```bash
git add modules/multi-user/src/dispatcher.ts modules/multi-user/tests/dispatcher.test.ts
git commit -m "feat(multi-user): dispatch conversations in parallel"
```

### Task 5: Owner controls and public mode

**Files:**
- Create: `modules/multi-user/src/admin.ts`
- Test: `modules/multi-user/tests/admin.test.ts`
- Modify: `modules/multi-user/src/receiver.ts`

- [ ] **Step 1: Write failing admin tests**

Test `/access public`, `/access invite`, `/block <id>`, `/unblock <id>`, `/jobs`, `/cancel <id>`,
`/reset <chat_id>`, and `/confirm <token>`. Add exact Russian natural-language aliases for “open
access to everyone” and “switch to invitations only”. Assert guest senders cannot mutate state.

- [ ] **Step 2: Implement typed control actions**

Read-only commands execute immediately. Block, cancel, reset, and access-mode changes create a
short-lived confirmation token; `/confirm` executes the stored typed payload once. Emergency
`/restart` and `/doctor` remain independent of Claude.

- [ ] **Step 3: Integrate commands before queueing**

Receiver checks admin commands only after numeric admin authorization and before normal message
enqueue. Guest command-looking text is either rejected as unauthorized or treated as ordinary chat,
but never reaches mutation code.

- [ ] **Step 4: Run admin tests and commit**

Run: `bun test modules/multi-user/tests/admin.test.ts`
Expected: PASS.

```bash
git add modules/multi-user/src/admin.ts modules/multi-user/src/receiver.ts modules/multi-user/tests/admin.test.ts
git commit -m "feat(multi-user): add owner-only access controls"
```

### Task 6: Installation, service lifecycle, and rollback

**Files:**
- Create: `modules/multi-user/systemd/claude-multi-user-receiver.service`
- Create: `modules/multi-user/systemd/claude-multi-user-dispatcher.service`
- Create: `modules/multi-user/install.sh`
- Create: `modules/multi-user/README.md`
- Modify: `assets/templates/agent.env.example`
- Modify: `assets/install-core.sh`
- Modify: `update.sh`
- Modify: `modules/README.md`
- Test: `modules/multi-user/tests/install.bats` or shell fixture equivalent

- [ ] **Step 1: Write installer fixture tests**

Run the installer against temporary fake `systemctl`, `loginctl`, and filesystem roots. Assert
idempotent enable, mutual exclusion with both existing pollers, mode `0700/0600` on state and env,
service ordering, update reapplication, and disable rollback.

- [ ] **Step 2: Implement hardened systemd units**

Run as `claude`, use separate receiver/dispatcher units, `Restart=always`, `UMask=0077`, private
temporary directories, no new privileges, restricted writable paths, explicit environment file,
and receiver-before-dispatcher ordering.

- [ ] **Step 3: Implement idempotent installer**

Copy source and prompts into `/home/claude/multi-user`, initialize state, record the previously
active Telegram mode, stop conflicting pollers before starting the receiver, install units, and
provide `enable`, `disable`, and `status`. Disable must stop both services and restore the prior
owner-only service without a two-poller overlap.

- [ ] **Step 4: Wire opt-in configuration and updates**

Add `MODULE_MULTI_USER=0`, `GUEST_ACCESS_MODE=public`, `MAX_WORKERS=4`, guest retention, timeout,
and retry settings. `install-core.sh` persists them; `update.sh` reapplies the module only when the
saved flag is enabled.

- [ ] **Step 5: Run installer tests and commit**

Run: `bun test modules/multi-user/tests && bash -n modules/multi-user/install.sh assets/install-core.sh update.sh`
Expected: all tests PASS and shell syntax checks exit 0.

```bash
git add modules/multi-user assets/templates/agent.env.example assets/install-core.sh update.sh modules/README.md
git commit -m "feat(multi-user): install supervised routing services"
```

### Task 7: Documentation and end-to-end verification

**Files:**
- Modify: `DEPLOY.md`
- Modify: `VERIFY.md`
- Modify: `README.md`
- Modify: `README.uk.md`
- Create: `modules/multi-user/tests/e2e.test.ts`

- [ ] **Step 1: Add fake end-to-end test**

Start receiver and dispatcher against a fake Telegram server and fake Claude executable. Send two
private chats and one group, restart dispatcher between enqueue and execution, and assert independent
session IDs, group sharing, concurrent execution, one reply per update, and no guest command containing
admin-private paths or tools.

- [ ] **Step 2: Document enable, verify, and rollback**

Document novice-safe commands, public versus invite mode, the fact that dormant sessions are not
processes, diagnostics, live two-user test, reboot test, privacy probe, and one-command rollback.

- [ ] **Step 3: Run the complete local verification**

Run:

```bash
bun test modules/multi-user/tests
bash -n modules/multi-user/install.sh assets/install-core.sh update.sh onboard.sh
git diff --check origin/main...HEAD
```

Expected: all tests pass, all shell scripts parse, and diff check is empty.

- [ ] **Step 4: Review against acceptance criteria**

Confirm every item in `docs/superpowers/specs/2026-07-15-multi-user-admin-guest-design.md`
maps to code or a test. Any deliberate live-only gate must be explicit in `VERIFY.md` and must keep
the module opt-in.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md README.uk.md DEPLOY.md VERIFY.md modules/multi-user
git commit -m "docs: add multi-user deployment and verification"
```

### Task 8: Final review and integration

- [ ] **Step 1: Run a bug-focused code review**

Review privacy boundaries, SQL transactions, path traversal, command injection, process cleanup,
poller exclusivity, retry idempotency, and rollback. Fix all high/medium findings with regression
tests.

- [ ] **Step 2: Run final verification again**

Run the Task 7 command block and inspect `git status --short`.

- [ ] **Step 3: Push feature branch and open PR**

```bash
git push -u origin feat/multi-user-routing
gh pr create --base main --head feat/multi-user-routing --title "feat: parallel multi-user Telegram routing" --body-file <generated-pr-body>
```

- [ ] **Step 4: Merge only after checks pass**

Use a normal merge through GitHub, then verify `origin/main` contains the merge commit. Do not force
push the rewritten main history.
