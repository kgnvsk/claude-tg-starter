# Durable follow-ups: portable upgrade handoff

Use this runbook to add generic durable commitments to an existing Telegram Claude agent. It is not tied to claude-premium, a domain, or a particular owner. Adapt every placeholder and path to the target installation; stop when a check fails.

## Behavior being upgraded

| Before | After |
|---|---|
| One-shot-only queue, promise-only replies with no durable artifact, or session-only timers | One-shot, repeat-until-closed, and guided sequence tasks stored as queue artifacts |
| An agent could say “I will remind you” before persistence was proved | The agent may promise a follow-up only after the helper returns `VERIFIED` |
| Some legacy workers deleted a reminder even when Telegram rejected delivery | A Telegram failure is retained unchanged for retry; only an `"ok": true` response consumes or advances it |

Old one-shot `.rem` files remain compatible. New repeat and sequence records add lifecycle headers, helper-managed status, cancellation, locking, and quiet-hour behavior.

## Portable component map

Copy these tested components from the revision that contains this guide:

- worker: `assets/bin/cash-reminder-tick`
- helper: `assets/bin/reminder-task`
- managed rules source: section `## Нагадування (переживають перезапуски)` in `assets/templates/CLAUDE.md.template`

Define the target mapping before doing anything:

```bash
AGENT_USER='<service-account>'
AGENT_GROUP='<service-group>'
AGENT_HOME='/home/<agent>'
REM_DIR="$AGENT_HOME/.atarax/reminders"
WORKER="$AGENT_HOME/bin/cash-reminder-tick"
HELPER="$AGENT_HOME/bin/reminder-task"
RULES="$AGENT_HOME/CLAUDE.md"
MANAGED_RULES="$AGENT_HOME/.claude/CLAUDE.durable-followups.md"
TOKEN_FILE="$AGENT_HOME/.claude/channels/telegram/.env"
PROFILE_FILE="$AGENT_HOME/.agent-profile.env"
LOG="$AGENT_HOME/logs/reminder-tick.log"
LOCK_FILE="${REM_DIR}.worker.lock"
TIMEZONE='<owner-IANA-timezone>'
OWNER_CHAT_ID='<owner-chat-id>'
SOURCE_ROOT='/path/to/this/repository'
```

Change names and paths where the target differs. Both programs must use the same `LOCK_FILE=${REM_DIR}.worker.lock`. This design needs the existing Telegram process plus cron; do not add Docker, do not add a daemon, and do not schedule a nested `claude -p`.

## Prerequisites and privacy boundary

- Ubuntu with Bash, Python 3, cron, GNU `timeout`, `curl`, and timezone data installed.
- Python must provide `fcntl`; the helper also requires `zoneinfo` and the selected `TIMEZONE` in the host timezone database.
- A readable Telegram token env already used by the agent and a known numeric `OWNER_CHAT_ID`. Identify the owner's IANA timezone explicitly; do not guess from the server clock.
- Permission to install user-owned executables, update that user's crontab, and add a managed rules import.

Validate only metadata:

```bash
python3 - "$TIMEZONE" <<'PY'
import sys
from zoneinfo import ZoneInfo
ZoneInfo(sys.argv[1])
print("timezone-ok")
PY
test -r "$TOKEN_FILE"
[ ! -e "$PROFILE_FILE" ] || test -r "$PROFILE_FILE"
```

Never print or source secrets into a shell transcript or report. Do not copy `.env`, tokens, `messages.db`, message content, or private chat data into the upgrade backup. Use placeholders in notes and tickets; never include a real token, password, IP, or private chat ID.

## 1. Back up code, rules, cron, hashes, and modes

Create a root- or agent-readable metadata backup, not a user-data backup:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$AGENT_HOME/backups/durable-followups-$STAMP"
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$BACKUP"
[ ! -e "$WORKER" ] || cp -a "$WORKER" "$BACKUP/worker.before"
[ ! -e "$HELPER" ] || cp -a "$HELPER" "$BACKUP/helper.before"
[ ! -e "$RULES" ] || cp -a "$RULES" "$BACKUP/rules.before"
[ ! -e "$MANAGED_RULES" ] || cp -a "$MANAGED_RULES" "$BACKUP/managed-rules.before"
crontab -u "$AGENT_USER" -l > "$BACKUP/crontab.before" 2>/dev/null || :
for FILE in "$WORKER" "$HELPER" "$RULES" "$MANAGED_RULES"; do
  [ ! -e "$FILE" ] || sha256sum "$FILE"
done > "$BACKUP/sha256.before"
for FILE in "$WORKER" "$HELPER" "$RULES" "$MANAGED_RULES"; do
  [ ! -e "$FILE" ] || stat -c '%a %U:%G %n' "$FILE"
done > "$BACKUP/modes.before"
chmod 0600 "$BACKUP/crontab.before" "$BACKUP/sha256.before" "$BACKUP/modes.before"
```

Confirm the backup directory is mode `700`, metadata files are mode `600`, and `cp -a` retained each copied executable/rules file's ownership and mode for rollback. Explicitly exclude the live queue too: it is operational state, not a backup artifact.

## 2. Install the worker and helper

Inspect the source comparison first:

```bash
git -C "$SOURCE_ROOT" rev-parse HEAD
[ ! -e "$WORKER" ] || diff -u "$WORKER" "$SOURCE_ROOT/assets/bin/cash-reminder-tick" || :
[ ! -e "$HELPER" ] || diff -u "$HELPER" "$SOURCE_ROOT/assets/bin/reminder-task" || :
```

Do not place secret file contents in the diff. Then install both executable assets and the private queue directory:

```bash
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0755 "$AGENT_HOME/bin"
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0700 "$REM_DIR"
install -d -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0750 "$(dirname "$LOG")"
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0755 \
  "$SOURCE_ROOT/assets/bin/cash-reminder-tick" "$WORKER"
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0755 \
  "$SOURCE_ROOT/assets/bin/reminder-task" "$HELPER"
bash -n "$WORKER"
PYCACHE=$(mktemp -d)
PYTHONPYCACHEPREFIX="$PYCACHE" python3 -m py_compile "$HELPER"
rm -rf "$PYCACHE"
```

Do not rewrite existing `.rem` files. An old one-shot has leading `EPOCH`, `CHAT`, optional `PARSE`, then its body. Extended records may also use `TASK`, `REPEAT_SECONDS`, `TIMEZONE`, `QUIET_START`, `QUIET_END`, `UNTIL_EPOCH`, `COUNT`, `SEQUENCE_COUNT`, and `SEQUENCE_INDEX`.

## 3. Add the managed agent rules without overwriting owner rules

Render only the tested reminder section into a separate managed layer:

```bash
export OWNER_CHAT_ID TIMEZONE HELPER
TMP_RULES=$(mktemp)
python3 - "$SOURCE_ROOT/assets/templates/CLAUDE.md.template" "$TMP_RULES" <<'PY'
import os, re, sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
# Match the heading start only, and say which heading moved. A wording edit
# used to crash the step with str.index; matching a prefix narrowed that, but
# only reporting the miss turns it into an instruction you can act on.
opening = re.search(r"^## Нагадування", text, re.M)
closing = re.search(r"^## Що ти можеш сам", text, re.M)
if opening is None or closing is None or closing.start() <= opening.start():
    missing = "## Нагадування" if opening is None else "## Що ти можеш сам"
    sys.exit(
        f"шаблон більше не містить розділу {missing!r} у очікуваному порядку — "
        "звір заголовки з assets/templates/CLAUDE.md.template"
    )
section = text[opening.start():closing.start()]
section = section.replace("{{OWNER_CHAT_ID}}", os.environ["OWNER_CHAT_ID"])
section = section.replace("{{TIMEZONE}}", os.environ["TIMEZONE"])
section = section.replace("~/bin/reminder-task", os.environ["HELPER"])
Path(sys.argv[2]).write_text(section.rstrip() + "\n", encoding="utf-8")
PY
install -o "$AGENT_USER" -g "$AGENT_GROUP" -m 0600 "$TMP_RULES" "$MANAGED_RULES"
rm -f "$TMP_RULES"
touch "$RULES"
chown "$AGENT_USER:$AGENT_GROUP" "$RULES"
chmod 0600 "$RULES"
IMPORT="@$MANAGED_RULES"
grep -Fqx "$IMPORT" "$RULES" || printf '\n%s\n' "$IMPORT" >> "$RULES"
```

Before appending, inspect the target rules for an older reminder section. Merge or retire only conflicting reminder clauses; do not blindly overwrite custom rules. The managed layer must preserve the owner's unrelated instructions and must retain these commands: `reminder-task one`, `reminder-task repeat`, `reminder-task sequence`, `reminder-task status`, and `reminder-task cancel`.

Worker/helper installation takes effect on the next invocation and does not require a service restart. Rule loading depends on the target agent: a new turn may reload files, while an agent that snapshots its prompt may require its documented reload or restart. Say which behavior was actually observed; do not claim that an existing session imported the new rules unless verified.

## 4. Install one cron entry

Review the backed-up `crontab.before` locally without pasting it into a report. Preserve unrelated jobs. The filter below removes the previous managed block and only unmanaged cron entries whose parsed command contains the exact `$WORKER` path as a standalone token; a different worker path or a mere substring is preserved.

```bash
CRON_OLD=$(mktemp)
CRON_NEW=$(mktemp)
crontab -u "$AGENT_USER" -l > "$CRON_OLD" 2>/dev/null || :
python3 - "$CRON_OLD" "$CRON_NEW" "$WORKER" <<'PY'
import shlex
import re
import sys
from pathlib import Path

source, destination, worker = sys.argv[1:]
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", re.DOTALL)
DURATION = re.compile(r"^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)[smhd]?$")
TIMEOUT_WRAPPERS = {"timeout", "/usr/bin/timeout"}
ENV_WRAPPERS = {"env", "/usr/bin/env"}


def worker_is_executable(command):
    try:
        tokens = shlex.split(command, comments=True)
    except ValueError:
        return False
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if ASSIGNMENT.fullmatch(token):
            index += 1
            continue
        if token in TIMEOUT_WRAPPERS:
            if index + 1 >= len(tokens) or not DURATION.fullmatch(tokens[index + 1]):
                return False
            index += 2
            continue
        if token in ENV_WRAPPERS:
            index += 1
            continue
        return token == worker
    return False


kept = []
managed = False
for line in Path(source).read_text(encoding="utf-8").splitlines(keepends=True):
    stripped = line.strip()
    if stripped == "# BEGIN DURABLE FOLLOWUPS":
        managed = True
        continue
    if stripped == "# END DURABLE FOLLOWUPS":
        managed = False
        continue
    if managed:
        continue
    command = None
    if stripped and not stripped.startswith("#"):
        if stripped.startswith("@"):
            fields = stripped.split(None, 1)
            command = fields[1] if len(fields) == 2 else None
        else:
            fields = stripped.split(None, 5)
            command = fields[5] if len(fields) == 6 else None
    points_to_worker = command is not None and worker_is_executable(command)
    if not points_to_worker:
        kept.append(line)
if kept and not kept[-1].endswith("\n"):
    kept[-1] += "\n"
Path(destination).write_text("".join(kept), encoding="utf-8")
PY
{
  printf '%s\n' '# BEGIN DURABLE FOLLOWUPS'
  printf '%s\n' "* * * * * /usr/bin/timeout 50s /usr/bin/env HOME='$AGENT_HOME' PATH='/usr/local/bin:/usr/bin:/bin' REM_DIR='$REM_DIR' LOCK_FILE='$LOCK_FILE' TOKEN_FILE='$TOKEN_FILE' PROFILE_FILE='$PROFILE_FILE' LOG='$LOG' '$WORKER'"
  printf '%s\n' '# END DURABLE FOLLOWUPS'
} >> "$CRON_NEW"
crontab -u "$AGENT_USER" "$CRON_NEW"
rm -f "$CRON_OLD" "$CRON_NEW"
```

This runs every minute under a 50-second timeout and passes every runtime path explicitly. The filter unwraps only `timeout`, `/usr/bin/timeout`, `env`, `/usr/bin/env`, and environment assignments; parse errors, unsupported wrapper syntax, path arguments, and comments are preserved fail-closed. The worker and helper use the same `${REM_DIR}.worker.lock`, so creation, status, cancellation, and delivery serialize. If a target path contains whitespace or shell metacharacters, generate and inspect a safely quoted cron line rather than copying this one literally.

## 5. Verify in isolation first

Preferred evidence from this repository is:

```bash
cd "$SOURCE_ROOT"
python3 -m unittest tests.test_durable_commitments -v
```

That suite must exit zero and end in `OK`. It uses a temporary queue, token placeholder, fake curl, and explicit `REM_DIR`, `LOG`, `TOKEN_FILE`, `PROFILE_FILE`, `LOCK_FILE`, and `NOW_EPOCH`. It verifies one/repeat/sequence plus status/cancel, Telegram failure retention, concurrent lock behavior, and quiet deferral. There is no network access and no owner message.

For a portable smoke check outside the repository, build the same isolated harness:

```bash
TEST_ROOT=$(mktemp -d)
mkdir -p "$TEST_ROOT/queue" "$TEST_ROOT/fake-bin"
printf '%s\n' 'TELEGRAM_BOT_TOKEN=placeholder-not-a-token' > "$TEST_ROOT/token.env"
printf '%s\n' 'TIMEZONE=UTC' > "$TEST_ROOT/profile.env"
cat > "$TEST_ROOT/fake-bin/curl" <<'SH'
#!/bin/bash
printf 'call\n' >> "$CURL_CALLS_FILE"
printf '%s\0' "$@" >> "$CURL_ARGS_FILE"
sleep "${FAKE_CURL_DELAY:-0}"
if [ "${FAKE_CURL_FAIL:-0}" = 1 ]; then
  printf '%s\n' '{"ok":false,"description":"synthetic failure"}'
else
  printf '%s\n' '{"ok":true}'
fi
SH
chmod 0700 "$TEST_ROOT/fake-bin/curl"
export REM_DIR="$TEST_ROOT/queue"
export LOG="$TEST_ROOT/worker.log"
export TOKEN_FILE="$TEST_ROOT/token.env"
export PROFILE_FILE="$TEST_ROOT/profile.env"
export LOCK_FILE="$TEST_ROOT/queue.worker.lock"
export CURL_CALLS_FILE="$TEST_ROOT/curl.calls"
export CURL_ARGS_FILE="$TEST_ROOT/curl.args"
export PATH="$TEST_ROOT/fake-bin:/usr/local/bin:/usr/bin:/bin"
export NOW_EPOCH=1893540600
TEST_CHAT=-9999999999999999999
```

Use only that synthetic `TEST_CHAT` with fake curl:

```bash
# one + status + cancel
"$HELPER" one --task smoke-one --chat "$TEST_CHAT" --at "$((NOW_EPOCH + 60))" --text 'synthetic one'
"$HELPER" status --task smoke-one
"$HELPER" cancel --task smoke-one

# repeat + quiet deferral (2030-01-01 23:30 UTC -> next 08:00, no curl call)
"$HELPER" repeat --task smoke-repeat --chat "$TEST_CHAT" --at "$((NOW_EPOCH - 1))" --every 300 --timezone UTC --quiet-start 22:00 --quiet-end 08:00 --text 'synthetic repeat'
"$WORKER"
test ! -e "$CURL_CALLS_FILE"
"$HELPER" status --task smoke-repeat
"$HELPER" cancel --task smoke-repeat

# guided sequence + status + cancel
"$HELPER" sequence --task smoke-sequence --chat "$TEST_CHAT" --checkpoint "$((NOW_EPOCH + 60))|synthetic first" --checkpoint "$((NOW_EPOCH + 120))|synthetic second"
"$HELPER" status --task smoke-sequence
"$HELPER" cancel --task smoke-sequence
```

Then separately prove failure retention and serialization:

```bash
# Telegram failure retention: hash must not change.
rm -f "$REM_DIR"/*.rem "$CURL_CALLS_FILE" "$CURL_ARGS_FILE"
"$HELPER" one --task smoke-failure --chat "$TEST_CHAT" --at "$((NOW_EPOCH - 1))" --text 'retain me'
BEFORE=$(sha256sum "$REM_DIR"/*.rem)
FAKE_CURL_FAIL=1 "$WORKER"
AFTER=$(sha256sum "$REM_DIR"/*.rem)
test "$BEFORE" = "$AFTER"
"$HELPER" cancel --task smoke-failure

# Concurrent workers: one due record produces exactly one fake curl call.
rm -f "$CURL_CALLS_FILE" "$CURL_ARGS_FILE"
"$HELPER" one --task smoke-lock --chat "$TEST_CHAT" --at "$((NOW_EPOCH - 1))" --text 'send once'
FAKE_CURL_DELAY=1 "$WORKER" & FIRST=$!
FAKE_CURL_DELAY=1 "$WORKER" & SECOND=$!
wait "$FIRST" "$SECOND"
test "$(wc -l < "$CURL_CALLS_FILE")" -eq 1
test ! -e "$REM_DIR"/*.rem
```

Exact success evidence is: every create/status/cancel line begins with `VERIFIED`; modes report `one`, `repeat`, and `sequence`; sequence reports two files; every cancel reports `mode=cancelled files=0`; quiet deferral leaves the repeat queued with `COUNT=0` and makes zero fake curl calls; the failed-send hash is identical; and concurrent workers record one call and leave no one-shot file. Remove `TEST_ROOT` after recording only these non-secret results.

## 6. Live rollout without a live reminder

Do not create a real reminder or send a test owner message unless the owner explicitly approves it. Safe live checks are read-only:

```bash
test -x "$WORKER" && test -x "$HELPER" && test -s "$MANAGED_RULES"
test "$(grep -Fxc "@$MANAGED_RULES" "$RULES")" -eq 1
crontab -u "$AGENT_USER" -l | grep -F 'BEGIN DURABLE FOLLOWUPS'
find "$REM_DIR" -maxdepth 1 -type f -name '*.rem' -printf . | wc -c
```

Compare the queue count before and after installation; it must not change. Confirm the managed cron appears once, cron/service health is active using the host's existing health command, and the worker log shows minute ticks or no errors. Do not manually run the live worker merely to test it: it may deliver an already-due real queue item.

## Rollback

The rollback order is safety-critical. A legacy worker can leak new lifecycle headers into the Telegram body because it may not recognize `TASK`, `REPEAT_SECONDS`, `SEQUENCE_COUNT`, or `SEQUENCE_INDEX`.

### Rollback step 1: stop scheduling

Disable the managed durable worker cron **before** inspecting or converting the queue, so a new tick cannot race the quarantine:

```bash
CRON_LIVE=$(mktemp)
CRON_STOPPED=$(mktemp)
crontab -u "$AGENT_USER" -l > "$CRON_LIVE" 2>/dev/null || :
sed '/^# BEGIN DURABLE FOLLOWUPS$/,/^# END DURABLE FOLLOWUPS$/d' \
  "$CRON_LIVE" > "$CRON_STOPPED"
crontab -u "$AGENT_USER" "$CRON_STOPPED"
rm -f "$CRON_LIVE" "$CRON_STOPPED"
```

### Rollback step 2: make the queue legacy-safe

Use the new helper to cancel known tasks and require `VERIFIED ... files=0`. Then quarantine all remaining nonlegacy records, including `TASK`-only helper one-shots. The safe predicate is any leading header outside `EPOCH`, `CHAT`, and `PARSE`; checking only repeat/sequence headers is insufficient.

The following scan understands only the leading header block, holds the shared `fcntl` lock while it preflights and moves records, and creates a mode-`700` quarantine:

```bash
QUARANTINE="$REM_DIR/.rollback-quarantine-$(date -u +%Y%m%dT%H%M%SZ)"
python3 - "$REM_DIR" "$LOCK_FILE" "$QUARANTINE" <<'PY'
import fcntl
import os
import re
import sys
from pathlib import Path

rem_dir, lock_file, quarantine = map(Path, sys.argv[1:])
HEADER = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")
LEGACY_HEADERS = {"EPOCH", "CHAT", "PARSE"}

quarantine.mkdir(mode=0o700)
os.chmod(quarantine, 0o700)
with lock_file.open("a+", encoding="utf-8") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    candidates = []
    for path in sorted(rem_dir.glob("*.rem")):
        keys = []
        for line in path.read_text(encoding="utf-8").splitlines():
            match = HEADER.fullmatch(line)
            if not match:
                break
            keys.append(match.group(1))
        if any(key not in LEGACY_HEADERS for key in keys):
            destination = quarantine / path.name
            if destination.exists():
                raise SystemExit(f"quarantine collision: {destination.name}")
            candidates.append((path, destination))
    for source, destination in candidates:
        os.replace(source, destination)
    print(f"quarantined={len(candidates)}")
PY
```

Do not print record bodies. The files left directly in `REM_DIR` now have only legacy headers; keep the quarantine until the rollback is accepted.

After the queue is safe:

1. Restore `worker.before`, `rules.before`, and `managed-rules.before` with `cp -a`; compare `sha256.before` and `modes.before`, then restore the recorded ownership and modes.
2. Merge the saved `crontab.before` entries without deleting cron changes made after the upgrade; enable the restored legacy worker schedule only after its queue is safe.
3. Remove the helper only after the queue is safe. Restore `helper.before` if one existed; otherwise remove only the installed helper.
4. Apply the target agent's documented rules reload/restart only if it is required, and verify its Telegram service health.

Do not restore data or secrets by default. Keep the live queue, `.env`, tokens, `messages.db`, and private chat data untouched; restore user data only for a separately diagnosed data-loss incident.

## Troubleshooting and limitations

- A queued file proves durable intent, not delivery. Check cron, host uptime, worker log, network reachability, Telegram authentication, and API responses separately.
- One-shot stale semantics are deliberate: a one-shot more than ten minutes late is removed without sending; repeat tasks do not emit catch-up bursts.
- Telegram `ok:false`, network errors, and authentication failures retain the record. A healthy process alone does not prove delivery.
- Cancel acquires the shared lock. It waits for an in-flight send to finish, so that one send may land, but after `VERIFIED ... files=0` no future send for that task remains queued.
- Session-native smart live checks are optional; a durable fallback is required for every promised future follow-up.
- Invalid headers, timezone, quiet hours, partial sequences, or duplicate task arguments fail closed. Fix the record through the helper rather than editing a live queue file unlocked.

## Acceptance checklist

- [ ] Source revision, target variables, owner timezone, and file comparison are recorded without secrets.
- [ ] Timestamped worker/rules/crontab/hash/mode backup exists and excludes private data.
- [ ] Both assets are executable, owner-controlled, and share `${REM_DIR}.worker.lock`.
- [ ] Existing one-shot records and unrelated owner rules/crontab entries are preserved.
- [ ] Managed rules say promise only after `VERIFIED` and cover one/repeat/sequence/status/cancel.
- [ ] One minute cron with `timeout` is installed exactly once; no Docker, new daemon, or nested Claude process was added.
- [ ] Repository tests or the isolated fake-curl smoke checks prove all required modes, retention, lock, and quiet deferral.
- [ ] Live queue integrity and cron/service health pass without an unapproved owner message.
- [ ] Rollback order is explicit: cron is disabled before quarantine; under the shared lock every record with any nonlegacy leading header, including a `TASK`-only one-shot, enters mode-`700` quarantine before any legacy worker or cron is restored.

On later upgrades, compare `cash-reminder-tick`, `reminder-task`, and the managed template section together. Do not upgrade one component independently when its headers or `VERIFIED` contract changed; rerun the repository contract and isolated smoke checks after every comparison.
