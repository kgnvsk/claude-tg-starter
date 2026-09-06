# Updating your installed Novsky Codex kit

A kit release is a downloadable version, not a remote command. The publisher
does not connect to customer agents. When the owner supplies the new kit or
release link and asks you to update, perform the update on your own installation.
That request authorizes the update; ask again only to resolve a real conflict or
missing authority. Never update neighbouring agents as a side effect.

The current full installer requires server administrator privileges. The
standard Telegram service runs without them; receiving a kit does not grant
those privileges. Without an existing authorized maintenance path, prepare the
update for the administrator and report that application is still pending.

1. Read the supplied release notes and `manifest.json`. Confirm `engine: codex`,
   the installed product, source revision and all manifest file hashes. Unpack
   into a new staging directory. Do not run the enclosing Claude `update.sh`.
2. Identify the existing Unix account, its exact `codex-telegram@<user>.service`,
   `/etc/novsky/codex/<user>.json` and `.managed.json`. Use the installed owner
   identity and current configuration, not values remembered from initial setup.
   Never print secrets or pass them through shell arguments.
3. If the verified manifest advertises `installerCapabilities` containing
   `readonly-plan-v1`, run its `installer/install.py` with JSON on stdin:
   `action: plan`, `maintenance: true`, and the real `user`, `payload`,
   `productId`, `ownerChatId`. This reads files without stopping the bot or
   installing dependencies. Older installers may ignore `action`: never send
   them a preview request. A plan covers managed files and configuration only;
   it does not prove dependency, browser or service recovery.
4. Inspect conflicts before writes. Preserve the current model, credentials,
   additional administrators, disabled skills, custom files, Vault, indexes and
   conversation histories. Resolve an actual owner-file conflict with the owner;
   do not erase checksums, remove a file or weaken access to force the update.
5. Check current tasks and delivery queues; do not interrupt an unrelated owner
   or employee request. Save a private backup covering every component you will
   change, with a usable recovery procedure. Stop only the named target service
   and confirm its process is gone. Arrange the maintenance command outside the
   process being stopped so stopping yourself cannot abandon the installation.
6. Run the verified native installer with the same JSON identity and
   `maintenance: true`, omitting `action` (normal install). It preserves the
   existing Telegram `.env`. Do not replace the separate Novsky Telegram bridge,
   shared services or CLIs unless the release supplies and verifies those
   components and you have their specific update procedure.
7. Restart the target, confirm fresh health and the actual Telegram poller,
   verify the model, memory search, access policy and an actual delivered reply.
   Report the installed revision and what passed. `systemd active` alone is not
   completion. If installation fails, use the prepared recovery; never replay
   uncertain external work or restore newer memory/history to an older snapshot.

Missing permissions or an unknown installation layout are a reason to stop
before changing files and explain what is missing. They are not permission to
take over another account or bypass the host's restrictions.
