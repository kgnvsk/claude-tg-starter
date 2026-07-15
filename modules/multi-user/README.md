# Multi-user Telegram router

Opt-in Bun runtime with one Telegram receiver, a durable SQLite queue, and a bounded Claude dispatcher. Admin identity uses numeric Telegram IDs only; guests run in per-conversation workspaces. It is disabled by default, so existing owner-only agents do not change until explicitly enabled.

## Conversation model

- Every private chat gets `dm:<chat_id>` and an independent resumable Claude session.
- Every group gets one shared `group:<chat_id>` session for all its members.
- Unrelated conversations run concurrently up to `MAX_WORKERS`; turns inside one conversation stay ordered.
- Dormant sessions consume no worker process. They are only SQLite state until a new message arrives.
- Private configured admins use the owner workspace. Groups always execute as guests, even when an admin writes there.
- Guests receive only `Read`, `WebSearch`, and `WebFetch`; `Read` is scoped to their encoded workspace. They receive no Telegram token, owner vault, inherited MCP servers, Bash, Write, or Edit.

## Enable

Run the authenticated canary in `VERIFY.md` first. Then, as root:

```bash
MODULE_MULTI_USER=1 OWNER_CHAT_ID=123456 TELEGRAM_BOT_TOKEN=... \
  bash modules/multi-user/install.sh enable
bash modules/multi-user/install.sh status
```

Use comma-separated numeric IDs for more than one admin: `ADMIN_CHAT_IDS="123456,987654"`. Usernames are never authorization keys. `GUEST_ACCESS_MODE=public` accepts anyone; `invite` accepts only known/unblocked identities. Change mode from the admin's private chat with `/access public` or `/access invite`, then `/confirm <token>`.

Admin controls are private-chat only: `/access`, `/block`, `/unblock`, `/jobs`, `/cancel`, `/reset`, `/doctor`, `/restart`, and `/confirm`. Mutating actions require a one-use confirmation. Guest command-looking text never reaches the control plane.

## Verify and diagnose

The installer preflights Bun, the absolute Claude executable, authentication status, sources, and the guest prompt before changing transport. It creates lingered `claude` user services, records enabled and active state for both legacy services, then disables both before starting the receiver. Disable and failed enable attempts stop both multi-user services before restoring those exact states in poller-safe order.

Configuration is stored in `/home/claude/multi-user/multi-user.env` with mode `0600`; state and guest workspaces are under `/home/claude/multi-user/state` with mode `0700`. Logs and lifecycle are available through:

```bash
runuser -u claude -- systemctl --user status claude-multi-user-receiver.service
runuser -u claude -- systemctl --user status claude-multi-user-dispatcher.service
runuser -u claude -- journalctl --user -u claude-multi-user-dispatcher.service
/home/claude/bin/cash-doctor
```

The live acceptance checklist in `VERIFY.md` covers two-user concurrency, shared group context, privacy, dispatcher restart, reboot, and rollback. The installer intentionally checks auth status without spending a Claude turn; the authenticated canary remains a manual pre-enable gate.

## Roll back

```bash
bash /opt/claude-tg-starter/modules/multi-user/install.sh disable
```

Disable stops both module services and restores the exact legacy system/user enabled and active states captured at enable time. It keeps the SQLite database and workspaces for diagnosis or re-enable. Run `enable` again with the same environment to return to multi-user mode.

`/doctor` runs `/home/claude/bin/cash-doctor` without a shell and bounds captured output. Confirmed `/restart` restarts only the dispatcher user service after the database transaction commits.

Guest Claude sessions expire after seven inactive days by default. Cleanup atomically renames only the eligible encoded workspace into `state/workspaces/.retention-trash/<claim-token>`, completes the fenced database reset immediately, and removes quarantine entries afterward. A restart resumes persisted claims with the same token, so recursive deletion never keeps ingress blocked. It does not guess at or delete Claude transcript files.

The receiver has `NoNewPrivileges`, a read-only home, and write access only to multi-user state. The dispatcher deliberately does not use `NoNewPrivileges`, `ProtectSystem`, or a read-only home: private admin turns retain the starter's existing scoped sudo, package/configuration access, and server tools. Guest safety comes from the worker's strict Claude CLI tool allowlist, empty MCP configuration, filtered environment, and per-conversation workspace.

Transport rollback metadata is root-owned at `/var/lib/claude-multi-user/previous-transport-state`. Stale directional transitions are reconciled through the fixed root-owned `/usr/local/sbin/claude-multi-user-reconcile reconcile` command; the healthcheck never sources metadata or executes a writable script as root.
