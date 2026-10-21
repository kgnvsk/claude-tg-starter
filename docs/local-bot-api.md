# Local Telegram Bot API: prepared now, activated by the customer

This setup keeps the existing bot on Telegram's cloud API until the customer
enters their own Telegram application credentials and runs `activate`. Preparing
the operator does not log the bot out, change its endpoint, start the local API,
or enable it at boot.

The local API removes Telegram's cloud download limit and lets the agent read
downloaded files directly from a private directory. The runtime must support
both `TELEGRAM_API_BASE` and `TELEGRAM_LOCAL_FILE_ROOT`. Other application limits
(disk space, processing time, supported file formats) still apply.

## Customer instructions — English

1. Open [my.telegram.org](https://my.telegram.org), sign in to your own Telegram
   account, and open **API development tools**. Create an application if you do
   not have one. Keep its `api_id` and `api_hash` private. These identify your
   Telegram application; this setup does not request a personal Telegram session
   or access to your personal messages.
2. Open your server's terminal and run:

   ```bash
   sudo novsky-local-bot-api configure
   ```

   Enter the API ID and API hash at the two prompts. Both inputs are hidden,
   including while you paste. Do not put either value in a command or send it to
   the bot. The operator saves them in a root-only file. Configuration alone
   leaves the bot on its current API endpoint.
3. When the bot has finished its current tasks, run:

   ```bash
   sudo novsky-local-bot-api activate
   ```

   The command checks the prepared runtime, pauses this agent's schedule,
   waits for no work by refusing while busy, stops the bot, logs it out of the
   cloud API, and connects it to the local API. Expect a short interruption.
   A busy refusal is safe: let the tasks finish, allow three quiet minutes after
   recent task output, and run the same command again.
4. Check the state:

   ```bash
   sudo novsky-local-bot-api status
   ```

   A successful switch reports `local-running-needs-chat-test`, with `endpoint`
   set to `local` and both services active. Send the bot a short message and
   check that it replies once. Then send a supported file larger than 20 MB and
   ask it to read the file. This real exchange is the final behavior check;
   service startup alone does not prove the file was processed.

## Gotowa instrukcja dla klienta — polski

Lokalne API Telegrama jest przygotowane. Aby je uruchomić, dodaj dane swojej
aplikacji Telegrama:

1. Wejdź na [my.telegram.org](https://my.telegram.org), zaloguj się i otwórz
   **API development tools**. Utwórz aplikację, jeśli jeszcze jej nie masz.
   Zapisz jej `api_id` oraz `api_hash`. Nie wysyłaj tych danych na czacie.
2. W terminalu serwera uruchom:

   ```bash
   sudo novsky-local-bot-api configure
   ```

   Wpisz lub wklej API ID i API hash w odpowiedzi na pytania. Wpisywane znaki
   pozostają niewidoczne. To dane aplikacji, nie sesja Twojego prywatnego konta.
3. Gdy bot skończy bieżące zadania, uruchom:

   ```bash
   sudo novsky-local-bot-api activate
   ```

   Bot na chwilę przerwie pracę. Jeśli polecenie zgłosi `busy`, poczekaj na
   zakończenie zadań oraz trzy minuty bez nowej aktywności i spróbuj ponownie.
4. Sprawdź:

   ```bash
   sudo novsky-local-bot-api status
   ```

   Oczekiwany stan to `local-running-needs-chat-test`, `endpoint: local` i obie
   usługi aktywne. Napisz do bota, sprawdź jedną odpowiedź, a potem wyślij plik
   większy niż 20 MB i poproś o jego odczytanie.

Jeśli pojawi się `recovery-local`, bot pozostaje bezpiecznie zatrzymany.
Sprawdź połączenie z Internetem i ponów `activate`. Jeśli wynik wylogowania
jest nieznany, odczekaj czas podany przez `status` i ponów `activate`; operator
potwierdzi wylogowanie przed lokalnym logowaniem. Jeśli dane aplikacji były
błędne, ponów `configure`, a następnie `activate`. Nie przełączaj ręcznie bota
z powrotem na chmurowe API: po wylogowaniu Telegram blokuje taki powrót przez
10 minut. Zmienione w międzyczasie ustawienia wymagają sprawdzenia przez
administratora; operator nie nadpisuje ich starszą kopią.

## Installer preparation

Use a reviewed kit checkout and a verified official
[`tdlib/telegram-bot-api`](https://github.com/tdlib/telegram-bot-api) build
installed as root at `/usr/local/bin/telegram-bot-api`. Install and test the
runtime's local endpoint and local-file support first. Inventory this agent's
writers and service units. The built-in assumption is one dedicated Unix user
and one channel at `HOME/.claude/channels/telegram`.

This operator supports the Claude Telegram host, including its isolated
corporate workers. The separate native Codex Telegram runtime does not yet
support this endpoint; its installer refuses local settings before contacting
Telegram. Do not enable this operator for that runtime.

The operator uses Novsky's reviewed `corporate-update.py` **read-only** `busy`
and `writers` commands. Supply the reviewed source explicitly with
`--guard-source`. Preparation copies it to a root-owned directory, records its
SHA-256, and later executes it with `/usr/bin/python3 -I` as the agent user.
It never imports or sources code owned by the agent as root. The helper must
retain its `0 = idle`, `3 = busy`, other nonzero = failure exit contract.

Example preparation after reviewing the actual paths on the host:

```bash
sudo python3 -I scripts/local-bot-api/novsky-local-bot-api.py prepare \
  --user claude --home /home/claude --service claude-telegram.service \
  --guard-source /root/local-api-staging/corporate-update.py \
  --poller /home/claude/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts \
  --runtime /home/claude/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts \
  --runtime /home/claude/telegram-server-fixed.ts
sudo novsky-local-bot-api status
```

List each other changed endpoint consumer with another `--runtime PATH`.
The recorded runtime hashes must still match at activation. Include only this
agent's actual auxiliary transport services with `--daemon UNIT`, and its
actual timers with `--timer UNIT`; omit these options when none exist. Do not
include independent browser, Novsky activity, team, or system services. The
operator does not discover arbitrary services to stop. A long-running writer
outside the inventoried units causes a safe refusal until its current work
has ended or the owner has paused it.

The prepared files are:

| File | Purpose |
| --- | --- |
| `/usr/local/sbin/novsky-local-bot-api` | Root-owned operator, no secret arguments |
| `/etc/novsky-local-bot-api/config.json` | Fixed, root-only agent and runtime inventory |
| `/etc/novsky-local-bot-api/app.env` | Root-only application credentials, created by `configure` |
| `/usr/local/lib/novsky-local-bot-api/guard.py` | Root-owned reviewed read-only maintenance helper |
| `/etc/systemd/system/novsky-telegram-bot-api.service` | Inactive service after preparation |
| `/var/lib/novsky-telegram-bot-api` | Agent-owned mode-0700 local API files and temporary directory |
| `/var/lib/novsky-local-bot-api/activation.json` | Root-only exact environment/schedule preimage and migration phase |

The API service binds only `127.0.0.1:8081`, uses the agent UID so the bot can
read returned local paths, and applies `UMask=0077`. systemd reads credentials
from `EnvironmentFile`; neither app credential appears in process arguments.
No public port or reverse proxy is needed. Ordinary API request logging is
disabled to avoid logging token-bearing URLs. The private directory is a
trust boundary for the runtime, not a public file server.

## Migration and recovery behavior

Before any stop, activation verifies the credentials, binary, prepared unit and
runtime hashes, cloud endpoint, idle work, and the existing restart hold. It
saves the exact channel environment and user crontab with service active states.
The receipt contains private data; do not paste it into chats or publish it.

During the switch, the agent's whole crontab is temporarily removed and later
restored byte for byte. Unrelated users' crontabs are untouched. Existing
scheduled writers must finish; the helper refuses rather than killing them.
A restart hold and systemd start conditions prevent watchdogs from starting the
bot during maintenance. The final idle check and bot stop run under the kit's
transport lifecycle lock. The local server first opens its listener without
logging in the bot. Only after the bot and remaining writers are stopped does
the operator call cloud `logOut`.

Before a logout attempt, failure restores the previous service activity,
schedule and restart hold. Once a logout has been attempted, even an uncertain
HTTP result retains the stop conditions and schedule suspension. A durable
`recovery-local` receipt makes the next `activate` continue locally. A confirmed
cloud logout is not repeated. If its result is unknown, the command waits out
the possible ten-minute cloud lockout, then requires a confirmed logout before
local `getMe`. It never restarts a cloud poller. The command also
supports correcting application credentials with `configure` while this
recovery hold is in place.

After a successful local identity check, only the two endpoint/file-root keys
in the channel `.env` change. Other keys and comments are preserved. The
operator compares the exact current bytes before replacement and never
restores an old `.env` over newer customer edits. Schedule and hold restoration
also refuse conflicting newer state. Such a conflict needs an administrator
to reconcile the preserved receipt and current files; deleting the receipt or
the hold is not a recovery procedure.

On success, the bot depends on the local API service, one poller with the local
environment is verified, and the previous schedule and auxiliary activity are
restored. The receipt remains until the customer completes the chat/file test;
it is small and is the recovery record, not a copy of the agent's database.
No database, messages, polling offsets, access rules, or personal sessions are
rewritten by this operator.

For a deliberate later return to cloud, the administrator must quiesce the
same writers, log the bot out of the local server, honor Telegram's cloud
lockout, and review the current endpoint keys and service dependency. There is
no automatic cloud fallback. Telegram documents the ten-minute restriction in
[`logOut`](https://core.telegram.org/bots/api#logout) and the local migration
requirements in the [official server documentation](https://github.com/tdlib/telegram-bot-api#moving-a-bot-to-a-local-server).

Run the isolated operator tests with:

```bash
python3 -m unittest discover -s tests -p test_local_botapi_setup.py
```

These tests use fake service and HTTP boundaries. They do not activate a real
Telegram bot, validate customer credentials, or replace the final chat/file
check.
