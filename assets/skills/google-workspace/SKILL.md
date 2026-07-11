---
name: google-workspace
description: Google для владельца через gog CLI — календарь (события + Google Meet ссылки), Gmail (поиск/чтение/отправка), Docs, Sheets, Drive, Contacts. Use when the owner asks про календарь, встречу, созвон, google meet, почту, письмо, документ, таблицу — или просит подключить Google.
---

# Google через gog CLI

Все команды — через `~/bin/gog` (враппер сам подгружает ключи окружения).

## Шаг 0 — проверка подключения

```bash
~/bin/gog auth list
```

- Показывает аккаунт с нужными сервисами → работай (см. «Команды» ниже).
- Пусто / ошибка `no client` → пройди «Первичную настройку».
- Токен протух (`invalid_grant`) → повтори «Подключение аккаунта» (шаг 2).

## Первичная настройка (один раз на сервер)

### Шаг 1 — OAuth-клиент

Проверь: `~/bin/gog auth doctor --check 2>&1 | head -5`. Если клиент не настроен —
попроси владельца (объясни простыми словами, это ~5 минут, один раз):

> Нужен «ключ приложения» от Google. Сделай, пожалуйста:
> 1. Открой console.cloud.google.com → создай проект (любое имя).
> 2. Слева «APIs & Services» → «Library» → включи: Google Calendar API, Gmail API, Google Docs API, Google Sheets API, Google Drive API, Google Meet API.
> 3. «APIs & Services» → «Credentials» → «Create credentials» → «OAuth client ID» → тип **Desktop app** → Create → скачай JSON.
> 4. «OAuth consent screen» (Audience) → «Publish app» → Confirm (иначе доступ будет слетать каждые 7 дней).
> 5. Пришли мне скачанный JSON-файл сюда в чат.

Получив файл: скачай его (`download_attachment`), затем:

```bash
~/bin/gog auth credentials <путь_к_json>
```

### Шаг 2 — Подключение аккаунта (remote-флоу)

Спроси владельца, какой Gmail подключаем. Затем — строго по правилам ниже,
иначе флоу зацикливается (проверено на ошибках):

1. **URL генерирует ТОЛЬКО `--step 1`** — собирать ссылку accounts.google.com руками бесполезно: в ней не будет PKCE `code_verifier`, и step 2 упадёт с `Missing code verifier`.
2. **Шаг 1 и шаг 2 — один непрерывный поток с одинаковыми флагами `--services`.**
3. **Пока ждёшь ссылку от владельца — step 1 повторно не запускай** (каждый новый запуск убивает code_verifier предыдущего). Если надо начать заново — новый step 1 → НОВАЯ ссылка владельцу → сразу step 2.
4. **Всегда добавляй `--force-consent`** — без него повторное согласие возвращает access-токен без refresh-токена, и подключение не сохраняется.
5. **Код одноразовый и непрозрачный** — не декодируй его (base64/JWT/скрипты), обмен делает только `--step 2 --auth-url`.

```bash
~/bin/gog auth add <email> --services gmail,calendar,docs,sheets,drive,meet --remote --step 1 --force-consent
```

Из вывода возьми URL и отправь владельцу:

> Открой ссылку, войди в Google и разреши доступ. В конце браузер попробует открыть страницу и покажет ошибку «не удаётся подключиться» — это нормально. Скопируй ПОЛНЫЙ адрес из адресной строки (начинается с localhost) и пришли мне.

Получив ссылку (жди, ничего не запуская):

```bash
~/bin/gog auth add <email> --services gmail,calendar,docs,sheets,drive,meet --remote --step 2 --force-consent --auth-url "<присланный_url>"
~/bin/gog auth list   # проверка
```

Скажи владельцу: «Google подключён» — без упоминания gog/OAuth/токенов.

## Команды

Перед командами: `export GOG_ACCOUNT=<email>` (или флаг `--account <email>`).

**Календарь + Google Meet:**
```bash
~/bin/gog calendar events --today                          # что сегодня
~/bin/gog calendar create primary --summary "Созвон с X" \
  --from "2026-07-02T15:00:00" --to "2026-07-02T15:30:00" \
  --attendee someone@gmail.com --with-meet                  # событие + Meet-ссылка
~/bin/gog calendar update primary <eventId> --with-meet    # добавить Meet к существующему
```

**Gmail:**
```bash
~/bin/gog gmail search 'is:unread newer_than:7d' --max 10
~/bin/gog gmail search 'from:x@y.com' --all                # --all = все страницы, дефолт только 10
~/bin/gog gmail send --to x@y.com --subject "Тема" --body "Текст"
```

**Docs / Sheets / Drive:**
```bash
~/bin/gog docs cat <docId>
~/bin/gog sheets get <sheetId> 'A1:C10'
~/bin/gog drive ls
```

Полный список: `~/bin/gog --help`, `~/bin/gog <сервис> --help`.

## Ошибки

- `Missing code verifier` → state потерян: новый step 1 → новая ссылка владельцу → сразу step 2.
- `no refresh token received` → повтори step 1 с `--force-consent` (он обязателен всегда).
- `invalid_grant / expired` → токен протух: повтори «Подключение аккаунта».
- `accessNotConfigured` → соответствующий API не включён в Google Cloud проекте — попроси владельца включить его в Library (см. Шаг 1 п.2).
- `no TTY available for keyring` → в окружении нет GOG_KEYRING_PASSWORD — запускай через `~/bin/gog` (враппер), не `/usr/local/bin/gog` напрямую.
