# Опциональные модули

Базовый агент (`assets/install-core.sh`) ставит ТОЛЬКО ядро: бот в Telegram,
память-vault, утренний календарь, картинки, PDF, браузер, healthcheck. Всё, что
ниже — **опт-ин**: ставится отдельно и только если соответствующий флаг взведён
в `agent.env` (см. `assets/templates/agent.env.example`).

Принцип: меньше движущихся частей в ядре = стабильнее. Модуль добавляешь, когда
он реально нужен этому владельцу.

| Флаг в `agent.env`        | Что включает | Что в репо | Внешние требования |
|---|---|---|---|
| `MODULE_DESIGN_PACK=1`    | Дизайн-скиллы (`impeccable`, `frontend-design`, `apple-bento`) + деплой на Vercel (`vercel-deploy` + `~/bin/vc`) | `assets/skills/impeccable`, `assets/skills/vercel-deploy`, `assets/bin/vc` | node (Фаза 1), токен Vercel (Фаза 6) |
| `MODULE_TRANSPORT_DAEMON=1` | **СНЯТ С ПОДДЕРЖКИ** — на Claude Code 2.1.208+ плагин канала в этом режиме не запускается: демон складывает входящие в очередь, читать их некому, отправка работает — бот выглядит живым и молчит (Кеш, 29.07.2026). Установщик модуля отказывает; снять с бокса: `bash modules/transport-daemon/install.sh disable` | `modules/transport-daemon/` (оставлен для снятия) | — |
| `MODULE_MULTI_USER=1` | Durable multi-user Telegram routing: один receiver и bounded Claude dispatcher | `modules/multi-user/` | bun, SQLite, systemd-user + linger; несовместим с `MODULE_TRANSPORT_DAEMON=1` |
| `MODULE_VAULT_WEB=1` | Веб-вью Obsidian-vault на Vercel (Quartz: граф + заметки + бэклинки + поиск), за паролем (free middleware-auth). Read-only. | `modules/vault-web/` | Vercel-аккаунт (подключить репо vault + env `SITE_PASSWORD`); ставится `modules/vault-web/setup.sh <домен>` |

Дополнительно (ставится по `modules/`, не флагом ядра):
- `modules/health-dashboard/` — вечерний health-дайджест 22:00 (`cash-health-evening`) + дашборд на Vercel. Healthcheck условно проверяет опциональные сервисы по наличию их systemd-юнита, так что модули и без флага не ломают ядро.

## Как ставить модуль

1. Взведи флаг в `agent.env` (напр. `MODULE_DESIGN_PACK=1`).
2. Скопируй файлы модуля в `~/bin` / `~/.claude/skills` и отрендерь плейсхолдеры тем же `render()`, что в install-core (или вручную `sed`).
3. Поставь его systemd-юнит/крон, если модуль 24/7 (напр. health-evening).
4. Healthcheck подхватит проверку автоматически (он смотрит на наличие юнита).

`design-pack` — особый случай: его скиллы (`impeccable`, `vercel-deploy`) уже
кладёт install-core в `~/.claude/skills/` (они лёгкие, без 24/7-процессов), так
что флаг `MODULE_DESIGN_PACK` здесь — про настройку Vercel-токена и node, а не
про копирование файлов.
