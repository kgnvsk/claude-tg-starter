# Multi-user Telegram router

Opt-in Bun runtime with one Telegram receiver, a durable SQLite queue, and a bounded Claude dispatcher. Admin identity uses numeric Telegram IDs only; guests run in per-conversation workspaces.

```bash
MODULE_MULTI_USER=1 OWNER_CHAT_ID=123456 TELEGRAM_BOT_TOKEN=... \
  bash modules/multi-user/install.sh enable
bash modules/multi-user/install.sh status
bash modules/multi-user/install.sh disable
```

The installer preflights Bun, the absolute Claude executable, authentication status, sources, and the guest prompt before changing transport. It creates lingered `claude` user services, records enabled and active state for both legacy services, then disables both before starting the receiver. Disable and failed enable attempts stop both multi-user services before restoring those exact states in poller-safe order.

Configuration is stored in `/home/claude/multi-user/multi-user.env` with mode `0600`; state and guest workspaces are under `/home/claude/multi-user/state` with mode `0700`. Logs and lifecycle are available through:

```bash
runuser -u claude -- systemctl --user status claude-multi-user-receiver.service
runuser -u claude -- systemctl --user status claude-multi-user-dispatcher.service
runuser -u claude -- journalctl --user -u claude-multi-user-dispatcher.service
```

`/doctor` runs `/home/claude/bin/cash-doctor` without a shell and bounds captured output. Confirmed `/restart` restarts only the dispatcher user service after the database transaction commits.

Guest Claude sessions expire after seven inactive days by default. Cleanup atomically renames only the eligible encoded workspace into `state/workspaces/.retention-trash/<claim-token>`, completes the fenced database reset immediately, and removes quarantine entries afterward. A restart resumes persisted claims with the same token, so recursive deletion never keeps ingress blocked. It does not guess at or delete Claude transcript files.

The receiver has `NoNewPrivileges`, a read-only home, and write access only to multi-user state. The dispatcher deliberately does not use `NoNewPrivileges`, `ProtectSystem`, or a read-only home: private admin turns retain the starter's existing scoped sudo, package/configuration access, and server tools. Guest safety comes from the worker's strict Claude CLI tool allowlist, empty MCP configuration, filtered environment, and per-conversation workspace.

Transport rollback metadata is root-owned at `/var/lib/claude-multi-user/previous-transport-state`. Stale directional transitions are reconciled through the fixed root-owned `/usr/local/sbin/claude-multi-user-reconcile reconcile` command; the healthcheck never sources metadata or executes a writable script as root.
