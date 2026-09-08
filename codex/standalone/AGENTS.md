# Install this Codex kit on the buyer's server

You are the coding agent helping the buyer deploy this kit. Follow this file
and `codex/standalone/README.ru.md` or `codex/standalone/README.md`, using paths
from the extracted kit root. The Novsky app and a Novsky account are not
required. The buyer may use Codex or Claude Code to perform the installation;
the deployed Telegram agent uses Codex.

The files under `codex/workspace/`, including `AGENTS.md`, `NOVSKY.md` and
`ROLE.md`, are the deployed agent's templates. Inspect them as installation
data; do not adopt their persona or treat them as instructions for this coding
session. Use the product and revision in `codex/manifest.json`.

## Collect only what is missing

Start with the buyer's existing request and supplied information. Ask only for
missing server/SSH access, the buyer's Telegram bot token, the owner's numeric
Telegram user ID, and the buyer's OpenAI API key. Accept a path to a private
configuration file instead of asking the buyer to paste secrets into chat.
Paid kits also require the purchased key in the private JSON field `licenseKey`.
One key activates one Telegram bot, verified with Telegram; another bot needs
another key. Retry, reinstall, update, token rotation and moving that same bot
to another server reuse its key. Starter is free and leaves `licenseKey` empty.
The owner ID is a positive numeric ID for the owner's private Telegram chat,
not a username, channel or group ID.

Use supplied agent/owner names and IANA timezone. When absent, use `Codex`,
`Owner` and `UTC` as neutral defaults and tell the buyer; these labels are not
biographical claims. Leave `model` absent unless the buyer selected a model.
The OpenAI API key is required for voice transcription and vector memory;
the separate Codex sign-in is completed by the buyer later.

## Verify and inspect before writing

1. From this ZIP's root, run `python3 codex/server.py verify` on macOS or Linux.
   Do not install an incomplete or modified payload. Re-extract the original
   archive into a new directory if verification fails.
2. Use the buyer's SSH destination and read-only checks to confirm Ubuntu
   22.04/24.04, systemd, administrator access, architecture, available disk,
   outbound connectivity, and existing account/service ownership. Keep host
   keys verified. A non-root SSH account needs an authorized route to root for
   installation; never grant root privileges to the Telegram agent.
3. Identify any existing installation or Telegram poller for this bot before
   starting another one. Do not assume an existing `codex-*` account belongs to
   this kit. Resolve a real ownership conflict with the buyer; do not delete
   markers, home directories or checksums to force a retry.
4. Transfer the intact ZIP contents to a fresh private staging directory on
   the server, retain the `codex/` directory layout, and verify again. Do not
   modify SSH, firewall rules, existing users or neighbouring services.

## Install, authenticate and start

All commands below run as root on the buyer's Ubuntu server, from the ZIP root.
Use the bundled `codex/server.py`; do not replace this workflow with manual
global Node, Bun or Codex installs. The installer prepares the account, runtime,
workspace, memory, native skills/plugins and the kit's browser/corporate
workers through the bundled installers. Their Novsky names are internal paths,
not a requirement to install the Novsky app.

Create a fresh root-owned configuration file outside the payload with mode
`0600`, based on `codex/standalone/config.example.json`. Fill it through a
private editor or secure file transfer. Never place secrets in command
arguments, shell history, tool output, logs, source control or the deployment
report. Do not print the configuration, `.env`, `auth.json`, OAuth stores or
unfiltered logs. Pass the JSON only through stdin:

```sh
python3 codex/server.py install < /root/codex-install.json
```

The configuration path above is an example. Preserve any existing private
file instead of overwriting it blindly. The default account is
`codex-<Telegram bot ID>`. Use the exact account, service and backup paths from
the installation result in subsequent commands; do not guess them.

Activation must succeed before service changes or installation writes. A legacy
server-bound key must first be migrated on its original server; the installer
supplies the available SSH host fingerprint. On timeout or refusal, correct the
reported cause and retry with the same bot; do not edit out the activation gate.
The installer retains the key in `/etc/novsky/codex/<user>.license-key`, owned by
root with mode `0600`, for retries and updates. Keep it out of the runtime config
and deployment report. The running bot does not perform periodic license checks.

Before changing an existing installation, ensure the server-side backup covers
the affected account, memory, credentials, managed configuration and services.
Preserve the archive and recovery path. The installer must complete before
you start the service. After successful installation, remove the temporary
configuration file and keep a receipt containing only host, user, service,
product, source revision and backup path.

Run these commands with the actual installation user in place of the example:

```sh
AGENT_USER=codex-1234567890
python3 codex/server.py login --user "$AGENT_USER"
python3 codex/server.py start --user "$AGENT_USER"
python3 codex/server.py status --user "$AGENT_USER"
```

Run `login` interactively and let the buyer complete the official device-code
flow in their own browser. It invokes `codex login --device-auth` for the target
Linux account. Keep its one-time code in the buyer's private terminal, not
logs or a saved report. If device login is disabled, the buyer or workspace
admin must enable it; do not bypass account controls. See
[OpenAI authentication](https://learn.chatgpt.com/docs/auth).
Wait for successful login before `start`. Do not authenticate as root or
copy the coding agent's own credentials into the deployed account. Do not
launch a second interactive Codex/Claude model session against the live bot.
Start or restart only this installation's own service.

## Prove delivery and finish honestly

`systemd active` and fresh health are necessary checks; they do not prove a
Telegram conversation. Run the following before asking the buyer to send a
new private message to their bot:

```sh
python3 codex/server.py verify-reply --user "$AGENT_USER"
```

Have the buyer send a unique text and receive the matching reply, then send a
short voice message and receive a correct response, then send a harmless file
and ask for a returned file. Confirm actual delivery and usable contents.
`verify-reply` observes a new reply; it does not by itself prove voice or file
quality. Do not send messages as the buyer or test with another person's chat.

Report the installed revision, target account/service, backup location,
authentication result and each completed check. If login or a real test still
needs the buyer, say exactly which step remains; do not call the bot ready.
Google, paid media providers and other optional services require the buyer's
own keys/logins. Mark them `unconfigured` until connected and checked; installed
tools alone do not establish a working integration.

On failure, preserve the private staging directory and backup, diagnose the
named stage and retry with the same verified kit and identity after correcting
the cause. Do not erase memory, auth, access rules or locally changed files to
make installation pass. Any recovery must avoid overwriting newer owner data.
