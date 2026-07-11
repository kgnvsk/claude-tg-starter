# Module: transport-daemon (v3 stability — OPT-IN, experimental)

Borrows OpenClaw's one strong idea — **the transport must outlive the brain** — without
leaving the Claude subscription.

## Problem it solves

By default the Telegram **receive loop** (`bot.start()` / getUpdates) lives *inside* the
claude session's plugin process. When that process dies — orphan-watchdog revert,
nested-`claude` SIGTERM, network blip — the bot goes **deaf** until healthcheck restarts
it (a 1–6 min silent window), and updates arriving in that window can be lost.

## How it works

Split receive from the agent — keep everything else:

```
        ┌──────────────────────────┐        ┌───────────────────────────────┐
Telegram│ tg-receiver-daemon (bun) │ files  │ claude --channels + plugin     │
 getUpd ─▶ systemd-USER + linger   ├──────▶ │ TG_TRANSPORT=daemon            │
        │ owns the ONLY getUpdates │ inbox/ │ drains inbox → bot.handleUpdate │
        │ offset on disk           │        │ tools/sending UNCHANGED → API  │
        └──────────────────────────┘        └───────────────────────────────┘
```

- **Daemon** ([`tg-receiver-daemon.ts`](tg-receiver-daemon.ts)) — receive-only. Always up
  (systemd-user + `loginctl enable-linger`). Writes each update to a filesystem inbox
  (atomic tmp+rename), persists the offset. Survives every way the claude process can die.
- **Plugin** — in `TG_TRANSPORT=daemon` mode it skips `bot.start()` and drains the inbox
  via `bot.handleUpdate`. All handlers, tools, and outbound sending stay byte-for-byte the
  same. The diff is one gated branch.
- **Queue = filesystem.** No Redis, no extra deps — both processes already use `fs`.

Result: receive never stops, no message loss on restart, **claude stays interactive →
on the subscription** (not `claude -p`). Bonus: single consumer ⇒ no 409 two-poller
conflict.

## Telegram control — works even when claude is dead

Because the daemon owns the **sole** poller, it answers **owner-only** admin commands
directly — even when the claude session is crash-loop-stopped or wedged (it's the one
process still reading Telegram). This is the no-SSH recovery path: a fully dead agent can
be restarted from the phone.

- `/restart` — `sudo systemctl restart claude-telegram` (uses claude's existing
  passwordless-sudo rule — the same one `healthcheck` relies on)
- `/doctor` — runs `~/bin/cash-doctor`, replies with the report

Authorized by `access.json` `allowFrom` (the owner's DM). Anyone else's `/restart` falls
through to claude as a normal message — never executed.

## What it does NOT fix

OAuth-token rotation, codex auth, disk — those stay healthcheck's job. This module is
the *transport* layer only.

## Status

Opt-in and **not the default** — the proven `bot.start()` path ships as default until this
is validated live (kill the plugin mid-conversation; confirm the daemon keeps receiving
and the backlog drains with no loss). Enable via the module flag in `agent.env`
(`MODULE_TRANSPORT_DAEMON=1`); the installer copies the daemon, installs the user unit +
linger, and sets `TG_TRANSPORT=daemon` on the claude-telegram service so only the daemon
polls.
