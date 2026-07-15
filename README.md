**English** · [Українська](README.uk.md)

# claude-tg-starter

Turn-key start for **your own personal Claude Code Telegram agent** — self-hosted, on your Claude subscription. Deploy it once, then **configure everything through the bot itself** — no engineer required.

## What's in the box
- Claude Code agent in Telegram (voice, files, images, PDF)
- Image generation (`gpt-image-2` via Codex) with proper typography rules
- Deploy to Vercel (web pages / reports)
- Obsidian-vault memory + pre-search index (the agent knows what's in its memory)
- Resilience: self-kill guard, healthcheck, format-enforcer, instant ack — the bot doesn't crash or go silent
- Optional multi-user mode: unrelated Telegram chats run concurrently; every private guest and every group gets an isolated resumable session
- **Self-service:** the owner configures the bot straight from chat — adds people (pairing), changes settings, allow-list, writes files. Safe (owner only)
- Useful skills from public marketplaces: `superpowers` (process skills), `frontend-design`, + ours (codex-imagegen, vercel-deploy, research, analyze-video)

## Deploy

**Easiest — hand it to your agent:** open Claude Code in this folder and say "install the assistant for me" (see [QUICKSTART.md](QUICKSTART.md)). The agent runs the install by the runbook and walks you through each step.

**Doing it yourself (or you *are* the installer agent): your runbook is [DEPLOY.md](DEPLOY.md).** It's the full sequence (~7 phases, in order, a verify gate after each):
```
Phase 1   system base (packages, bun, node)
Phase 2   Claude CLI + owner's subscription LOGIN   ← the bot's "brain"; nothing works without it
Phase 3   kit layout (onboard.sh / install-core) + Telegram plugin (3c) + skills (3d)
Phase 4   launch (systemd)
Phase 5-7 resilience · options (voice/images/calendar/Vercel) · smoke test (VERIFY.md)
```

> ⚠️ **The bot's brain = the owner's Claude subscription.** Login is done by the `claude-login` helper: it prints a URL, the owner opens it in a browser, signs in with their Claude Max subscription and sends back a code (no password is ever typed). This is Phase 2 — the most important step, and it is **separate** from `onboard.sh`.

**What `onboard.sh` does (and doesn't):** it's an interactive helper for ONE phase (core config, Phase 3b) — asks for the agent name / owner / bot token / TZ, writes `agent.env` (chmod 600) and runs `install-core` (user, dirs, persona render, secrets, cron). Idempotent, with input validation and hidden secret entry. It does **NOT** install Claude itself, does **NOT** log in the subscription, does **NOT** install the plugin/skills and does **NOT** bring the bot up — those are neighboring phases in DEPLOY.md. After it, the bot isn't answering yet.

```
ssh root@<SERVER>
git clone https://github.com/kgnvsk/claude-tg-starter /opt/claude-tg-starter
cd /opt/claude-tg-starter && bash onboard.sh   # Phase 3b; then follow DEPLOY.md
```

## Self-service — the main feature
After deploy the owner runs everything from the Telegram chat:
- "add @user to access" → the bot adds them (pairing, owner command only)
- "change setting X" → the bot edits its own settings
- "remember rule Y" → the bot appends to its persona

No second tool, no engineer.

## Optional multi-user mode

Set `MODULE_MULTI_USER=1` when the bot must accept messages from many people. One durable receiver records Telegram updates, then a bounded dispatcher runs unrelated chats in parallel. Private chats have independent sessions; all members of one group share that group's session. Dormant sessions are SQLite records, not background processes.

Admins are matched only by numeric `ADMIN_CHAT_IDS` and keep the owner's normal agent capabilities in private chat. Guests cannot read the owner vault, change the agent/server, or use private MCP tools. Public access is the default; invitation-only mode and one-command rollback are documented in [the module guide](modules/multi-user/README.md). The module is off by default and cannot run together with `MODULE_TRANSPORT_DAEMON=1`.

## Security
Changes to the allow-list / settings / pairing happen ONLY on a command from the owner's chat (their chat_id). Anyone else who writes to the bot is never added automatically. Secrets live in `agent.env` (which is in `.gitignore`) — they never reach the repository.

## Layout
- `onboard.sh` · `assets/install-core.sh` — onboarding / installation
- `assets/` — bin, skills (ours), agents, systemd, templates, vault-skeleton
- `modules/` — optional add-ons (transport-daemon for max resilience, vault-web, etc.)

Built on the same battle-tested architecture as production assistants. Third-party skills (superpowers, frontend-design) are installed from their public marketplaces, not vendored into the code.

## Want more? → `claude-premium` 🔒

The free `claude-tg-starter` is a full personal assistant. **Premium** (private, paid tier) builds on top — for those who want the assistant as a working tool:

- 🧠 **Smart memory search** (SQLite FTS5) — the bot finds across the whole history of notes and chats, not just the last few messages
- 🎯 **Durable goals + portable backup** of the agent (move to a new server in a minute)
- 🛡️ **Isolated browser service** + server hardening (UFW / fail2ban / SSH lockdown / audit / rollback)
- 🔑 **Self-service re-login via Telegram** — Claude login expired? the bot sends you a login link, you recover from your phone, no SSH
- 🎬 **Video generation** (HTML → MP4: promo, explainer, motion graphics)
- 📢 **Auto-publisher** to a Telegram channel (rewrite sources → publish)
- 🕸️ **Knowledge graph** over your notes
- 📸 **Instagram Direct** — read AND reply to DMs (Meta API): give your token from Meta Developers, the module brings up the webhook + tunnel itself, then the bot handles the conversation
- 💬 **YouTube** — parse unanswered channel comments (never miss one)
- 🧪 Full test suite + CI

Access to `claude-premium` — on request: [message @kgnvsk on Telegram](https://t.me/kgnvsk).

## Windows (WSL2) — beta

The kit targets a Linux VPS, but it also runs locally on Windows via WSL2:

1. PowerShell as Administrator: `wsl --install -d Ubuntu` → reboot → on first Ubuntu launch set a username and password.
2. Enable systemd inside Ubuntu: `printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf`, then in PowerShell `wsl --shutdown` and reopen Ubuntu.
3. From there — the usual VPS path: `sudo -i`, clone the kit and run `bash onboard.sh`.

Limitation: the bot runs only while WSL is running (laptop on). Status: beta — the primary, proven path remains a Linux VPS.
