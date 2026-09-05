# Security model

## Executive summary

This kit assumes a single-owner VPS and a trusted owner-operated Claude Code
session. The server baseline is deny-by-default, deployment code remains
root-owned, browser automation is isolated, and secrets are excluded from
backups and normal memory retrieval.

The controls reduce accidental exposure and common internet attacks. They do
not turn the LLM process into a hostile-code sandbox. Read the residual risks
before enabling third-party skills or unattended publishing.

## Trust boundaries

| Boundary | Trusted | Untrusted or conditional |
|---|---|---|
| VPS administration | Owner SSH key, root-owned kit | Public internet, password probes |
| Agent runtime | Bundled reviewed scripts | Web pages, messages, downloaded files |
| Telegram | Explicit admin and allow lists | Unknown users, forwarded content |
| Extensions | Manifested bundled skills | Newly downloaded skills until reviewed |
| Browser | Dedicated local service on loopback | Every visited page |
| Backups | Checksummed allow-listed files | Secrets, auth files, live message DB |

## Implemented controls

1. **Server baseline.** `scripts/harden-server.sh` configures UFW,
   fail2ban, unattended security updates, and kernel network hardening.
   Password SSH is never disabled by the kit: it is the owner's recovery path
   from a phone or a borrowed computer; brute force is limited by the UFW rate
   limit and fail2ban with the operator IP exempted.
2. **Root-owned deployment.** `/opt/claude-tg-starter` stays root-owned.
   The agent cannot pull code and then execute the changed updater with sudo.
3. **Least-privilege sudo.** The `claude` user can operate only the named
   `claude-telegram.service` actions required for health recovery.
4. **Secret storage.** Installer configuration is mode 600 under
   `/etc/claude-tg-starter`; channel credentials are mode 600. Guided input
   hides tokens and shell-quotes persisted values.
5. **Tool guardrails.** `no-secrets-guard` blocks direct Read/Edit/Write and
   common Bash access to credential paths, process environments, and SSH keys.
   `no-nested-claude-guard` blocks second Claude sessions.
6. **Browser isolation.** Playwright MCP runs as a dedicated system user, binds
   to loopback, uses a fixed package/browser pair, and has a real navigation,
   snapshot, and screenshot smoke test.
7. **Memory isolation.** Telegram retrieval requires a matching chat ID.
   Injected memory is bounded and scanned; legacy mixed conversation snapshots
   are quarantined.
8. **Backups.** `agent-backup` uses an allow list, rejects symlinks, excludes
   credentials and live databases, and records SHA-256 checksums. Restore is
   path-validated and requires `--confirm`.
9. **Optional services.** StreamPost runs as `streampost`, not root, inside a
   venv with systemd filesystem and capability restrictions.
10. **Authentication health.** The healthcheck verifies `claude auth status`;
    a live PID is not considered healthy when Claude is logged out. On logout
    `claude-auth-rescue` sends the owner a re-login link over Telegram; the
    owner replies with the OAuth code and the service restarts itself. No
    password is stored and the human approval step is preserved by design.

## Residual risk

### R-01: Same-user credential boundary

Claude Code and the Telegram channel plugin run as the same Unix user. The
`no-secrets-guard` prevents straightforward accidental reads, but it is not a
complete defense against a deliberately obfuscated shell command or a compromised
runtime. Strong isolation requires a separate token-holding transport service
running as another Unix user and a narrow authenticated IPC protocol.

### R-02: Bypass-permissions agent

The unattended agent runs with broad workspace and command permissions. A
successful prompt injection can still cause harmful actions within those
permissions. Keep external-write skills opt-in, require confirmation before
publishing/deploying, and review third-party skill instructions before install.

### R-03: Third-party supply chain

npm, PyPI, marketplace skills, and browser packages are external dependencies.
Core browser versions are pinned, but owners must still review updates and Git
diffs before root executes `update.sh`.

### R-04: Provider session revocation

Claude subscription OAuth can expire or be revoked independently of process
health. The healthcheck detects and reports this; re-login still requires the
owner in a browser.

### R-05: Offsite data exposure

A private vault remote contains owner memory. Use a repository-scoped deploy key,
keep the repository private, and rotate the key if the VPS is rebuilt or
suspected compromised.

## Operations

Run after install and after network or SSH changes:

```bash
bash scripts/security-audit.sh
runuser -u claude -- /home/claude/bin/memory-doctor
runuser -u claude -- /home/claude/bin/skill-doctor
runuser -u claude -- /home/claude/bin/agent-backup create
```

Rotate any credential that has appeared in chat, logs, screenshots, shell
history, or an untrusted backup. Never commit real `.env`, OAuth, bot, API, or
private-key material.
