# VERIFY.md — смоук-приёмка (все пункты должны быть ✅)

## Установка (детерминизм)
- [ ] `install-core.sh` напечатал `✅ install-core OK ... gate passed` (без FATAL)
- [ ] `grep -rE '\{\{[A-Z_]+\}\}' /home/claude/bin /home/claude/CLAUDE.md /home/claude/.claude` → ПУСТО (ни одного плейсхолдера в боевых файлах)
- [ ] Логин по подписке: `runuser -l claude -c 'claude auth status'` → `"loggedIn": true` + `"subscriptionType": "max"`; scope в `~/.claude/.credentials.json` содержит `user:mcp_servers`
- [ ] claude.ai-коннекторы в ЖИВОЙ сессии бота (если настроены в аккаунте): после первого диалога `grep -l mcp__claude_ai_ /home/claude/.claude/projects/*/*.jsonl` находит (Gmail/Calendar/Drive/ClickUp/Notion). НЕ проверять через `claude -p` — там коннекторы не грузятся

## Ядро
- [ ] `systemctl is-active claude-telegram` → active; `systemctl is-enabled` → enabled
- [ ] `ps -o pid,ppid,cmd -p $(pgrep -f 'bun server.ts')` — поллер жив, его PPID = PID процесса `claude` (НЕ 1)
- [ ] screen-лог содержит `polling as @<bot>`; ошибок 401/409 нет
- [ ] md5: golden == cache/server.ts == marketplaces/server.ts
- [ ] поведенческий тест персоны: бот применяет правило, которое есть ТОЛЬКО в CLAUDE.md (напр. пинг «🔄 Взяв») — значит persona реально загрузилась

## Поведение (владелец, в Telegram)
- [ ] Текст «привет» → ответ ≤30 сек, на языке владельца
- [ ] Многошаговая задача → СНАЧАЛА пинг «🔄 Взяв: …», потом результат
- [ ] Список из 5+ пунктов → markdownv2 c жирным, БЕЗ литеральных `*`
- [ ] Голосовое → корректная транскрипция + ответ (если опция куплена)
- [ ] «сгенери картинку кота» → файл-картинка в чат (если codex-опция)
- [ ] Чужой аккаунт пишет боту → отказ (allowlist работает)

## Self-healing
- [ ] `kill <bun-pid>` → healthcheck поднимает сервис ≤2 мин, бот снова отвечает
- [ ] Подмени server.ts мусором → guard восстановил golden ≤2 мин (md5 снова равен)
- [ ] `cash-healthcheck` вручную: exit 0, в логе нет ALERT (при здоровой системе)
- [ ] Тест алерта: временно выставь порог токена → владельцу пришёл TG-алерт
- [ ] `crontab -l -u claude`: все задания обёрнуты в `/usr/bin/timeout`

## Память
- [ ] `git -C ~claude/obsidian-vault log --oneline` → есть коммиты; после Write бота появляется новый авто-коммит
- [ ] (если настроен офсайт-бэкап) после Write бота `git -C ~claude/obsidian-vault log origin/main --oneline -1` показывает тот же свежий коммит — push реально доходит до GitHub
- [ ] active-thread.md содержит блоки И `] user`, И `] <agent>` (обе стороны диалога пишутся)

## Перезагрузка
- [ ] `reboot` сервера → через 3 мин бот сам отвечает (enable сработал, контекст чистый)

## Гигиена
- [ ] `ls -la ~claude/.claude/channels/telegram/.env` → права 600
- [ ] В `/home/claude/CLAUDE.md` нет `{{` (все плейсхолдеры заполнены)
- [ ] `logrotate -d /etc/logrotate.d/cash-claude` без ошибок
- [ ] Временные логи логина (`/tmp/claude-login.*.log`) затёрты
