---
name: vercel-deploy
description: Deploy a static site or web app to Vercel from the server via the `vc` wrapper. Use when {{OWNER_NAME}} asks to "выложи сайт", "задеплой на vercel", "publish this page", "залей лендинг", "обнови прод", "ship the site", or when you've just built HTML/a frontend and it needs a live URL. Returns a public https URL.
---

# Deploy to Vercel via `vc`

Деплой сайтов/приложений на Vercel с сервера — через хелпер `~/bin/vc` (тонкая обёртка над `vercel` CLI, которая сама подставляет токен владельца из `~/.config/vercel-token`). Никакого интерактивного `vercel login` не нужно — токен уже на сервере (настроен в DEPLOY Фаза 6).

## ЖЕЛЕЗНО: команда — КОРОТКАЯ; большой контент (HTML/конфиг) — в ФАЙЛ

Как и везде на Opus 4.8: не инлайнь большой HTML/JSON в аргумент команды (срыв сериализации tool_use → бот молчит). Сначала `Write` файлы проекта на диск, потом короткая команда `vc deploy`.

## Базовый поток (статический сайт / лендинг)

1. `Write` файлы сайта в папку, напр. `/tmp/site/index.html` (+ css/js/assets рядом). Можно использовать скилл `frontend-design` / `apple-bento-grid` для вёрстки, `codex-imagegen` для картинок.
2. Деплой в прод одной командой из папки проекта:

```bash
cd /tmp/site && vc deploy --prod --yes
```

`vc` сам подставит `VERCEL_TOKEN`. CLI напечатает публичный `https://...vercel.app` URL — это и есть результат.

3. Отправь URL владельцу через `reply`.

## Команды

- `vc deploy --prod --yes` — задеплоить текущую папку в production (без интерактивных вопросов).
- `vc deploy --yes` — preview-деплой (отдельный URL, прод не трогает).
- `vc ls` — список последних деплоев.
- `vc --help` — справка vercel CLI.

`--yes` обязателен в headless: без него CLI задаёт интерактивные вопросы про scope/линковку и виснет.

## CRITICAL: проект ещё не слинкован

Первый деплой новой папки vercel спросит про привязку к проекту. В headless это виснет → всегда `--yes` (принимает дефолты: создаёт новый проект по имени папки). Если нужен конкретный существующий проект — `vc deploy --prod --yes --name <project>` или `cd` в уже слинкованную папку (где есть `.vercel/`).

## CRITICAL: токен отвалился / нет доступа

Если `vc` упал с auth-ошибкой (`The specified token is not valid` / 403) — **НЕ** проси у владельца пароль и **НЕ** пытайся `vercel login` интерактивно на сервере. Правило: при отвале внешней авторизации ты СООБЩАЕШЬ владельцу («токен Vercel протух, нужен новый: vercel.com/account/tokens → Create → положить в ~/.config/vercel-token») и ЖДЁШЬ. Перелогин делает владелец.

## Rules

- Деплой — всегда через `~/bin/vc`, не через голый `vercel` (иначе нет токена).
- Всегда `--yes` в headless.
- Большой HTML/JSON — сначала `Write` в файл, потом `cd … && vc deploy`. Никогда инлайном.
- Прод-деплой (`--prod`) — только когда владелец явно просит «в прод» / «обнови сайт»; иначе preview.
- Никаких секретов в репозиторий проекта (`.env` не коммить в папку сайта).

## Пример (лендинг в прод)

```bash
# шаг 1: Write /tmp/lp/index.html (+ /tmp/lp/style.css) — вёрстка
# шаг 2:
cd /tmp/lp && vc deploy --prod --yes
# → https://lp-xxxx.vercel.app  — отдать владельцу через reply
```
