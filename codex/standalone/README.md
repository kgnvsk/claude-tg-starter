# Codex: install on your own server

Unzip Codex Premium or another Codex kit and open the entire folder in Codex or
Claude Code. You do not need the Novsky app or a Novsky account. Your Telegram
agent runs on your Ubuntu server under its own Linux account.

Give your coding agent this request:

> Deploy this kit to my Ubuntu server. Read `codex/standalone/AGENTS.md`, verify
> the bundle and server, install the agent, and help me sign in to Codex.
> Complete a real Telegram reply test, a voice test, and a file test. Ask only
> for missing information, and handle secrets through a private configuration file.

## Prepare

- The purchased kit key for the private `licenseKey` field. One key is for one
  Telegram bot; retry, update, token rotation and moving the same bot reuse it.
  Free Starter leaves this field empty and makes no licensing requests.
- Ubuntu 22.04 or 24.04 with systemd and internet access; SSH access as root
  or an existing authorized route to root for installation.
- Your own BotFather bot token and your numeric Telegram user ID for your
  private chat. A username, channel ID or group ID is not suitable.
- Your Codex sign-in and a browser in which you can authenticate with OpenAI.
- Your OpenAI API key with available API credit for voice transcription and
  vector memory. The API key and the Codex sign-in serve separate purposes.

You can supply agent/owner names and an IANA timezone such as `Europe/Lisbon`.
Neutral defaults are `Codex`, `Owner` and `UTC`. The optional `model` field
should be added only when you want a particular model available to your account.

## What gets installed

Your coding agent verifies the bundle inventory and hashes, inspects the
server and ownership conflicts, stages the intact kit, and runs the bundled
installer. It prepares a dedicated `codex-<your Telegram bot ID>` account,
Node, Bun, Codex, workspace, memory, native skills/plugins and the browser and
corporate workers selected by the kit. Separate global Node, Bun or Codex
installations are unnecessary.

The Telegram agent does not receive installation-time root privileges.
Its workspace and memory are at `/home/<user>/obsidian-vault/`; its main unit
is `codex-telegram@<user>.service`. Take the exact user from the installation
result. Internal Novsky path names do not require the Novsky app.

## Commands

Your coding agent can perform these steps for you. On macOS or Linux, from
the extracted ZIP root:

```sh
python3 codex/server.py verify
```

Transfer the entire folder to a fresh private staging directory on the server,
retain the `codex/` layout and run the same verification there. Run all commands
below as root on the Ubuntu server, from the transferred ZIP root.

Create a private configuration file outside the bundle:

```sh
CODEX_INSTALL_CONFIG=$(mktemp /root/codex-install.XXXXXX.json)
cp codex/standalone/config.example.json "$CODEX_INSTALL_CONFIG"
chmod 600 "$CODEX_INSTALL_CONFIG"
```

Fill it through a private editor or secure file transfer. Every
`REPLACE_WITH_…` value is a dummy placeholder and must be replaced. Keep the
file root-owned with mode `0600`. Never put tokens in command arguments,
print the configuration or commit it. Supply the JSON through stdin:

```sh
python3 codex/server.py install < "$CODEX_INSTALL_CONFIG"
```

After successful installation, keep a receipt with the user, service,
revision and backup location. Remove the temporary file containing secrets:

```sh
unlink "$CODEX_INSTALL_CONFIG"
```

Replace the example account below with the exact user from the installation
result:

```sh
AGENT_USER=codex-1234567890
python3 codex/server.py login --user "$AGENT_USER"
```

This runs official `codex login --device-auth` as the new Linux user. Open the
displayed link in your own browser and enter the one-time code from your
private terminal. If device login is disabled, enable it in your ChatGPT
security settings or ask your workspace administrator. Do not publish the
code or `auth.json`. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth).

After successful login:

```sh
python3 codex/server.py start --user "$AGENT_USER"
python3 codex/server.py status --user "$AGENT_USER"
python3 codex/server.py verify-reply --user "$AGENT_USER"
```

The last command waits for a new actual reply. While it waits, open your bot's
private chat and send a unique request such as “Reply with: setup check 7e3”.
Confirm the matching response, then test:

1. Voice: say a short phrase and ask the bot to repeat its meaning in text.
2. Files: send a small non-sensitive document, ask the bot to process it and
   return a file, then open the returned file.

An `active` unit or fresh health alone does not complete these tests. If login
or a test needs your participation, the installation report must name the
remaining step instead of claiming the agent is ready.

## Integrations and recovery

Google and other external services require your own accounts and keys. Paid
providers are billed separately. Mark each optional integration `unconfigured`
until connected and tested; installed tools do not prove a working connection.

An existing installation needs a server-side backup of the affected files,
memory, configuration and authentication before changes. On failure, preserve
that archive and the staging directory, correct the named cause and retry the
same verified kit. Do not remove an account, memory or locally modified files
to force a retry. Recovery must preserve any newer owner data.

Do not change SSH, firewall rules or neighbouring services. If this bot is
already running, establish who owns that installation before proceeding;
never start a second Telegram poller with the same token.
