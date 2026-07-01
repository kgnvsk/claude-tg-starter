# claude-tg-starter

Turn-key старт для **своего личного Claude-Code Telegram-агента** — self-hosted, на твоей подписке Claude. Развернул один раз, дальше **настраиваешь всё через самого бота** — без инженера.

## Что внутри коробки
- Claude-Code агент в Telegram (голос, файлы, картинки, PDF)
- Генерация изображений (`gpt-image-2` через Codex) с правильными правилами типографики
- Деплой на Vercel (веб-страницы/отчёты)
- Память Obsidian-vault + pre-search индекс (агент знает, что у него в памяти)
- Устойчивость: self-kill guard, healthcheck, format-enforcer, мгновенный ack — бот не падает и не немеет
- **Self-service:** владелец настраивает бота прямо из чата — добавляет людей (pairing), меняет настройки, allow-list, пишет файлы. Безопасно (только владелец)
- Полезные скиллы из публичных маркетплейсов: `superpowers` (process-скиллы), `frontend-design`, + наши (codex-imagegen, vercel-deploy, research, analyze-video)

## Развернуть
```
ssh root@<SERVER>
git clone https://github.com/kgnvsk/claude-tg-starter /opt/claude-tg-starter
cd /opt/claude-tg-starter && bash onboard.sh
```
`onboard.sh` спросит имя/владельца/токен бота (@BotFather)/TZ → поставит всё (бот, демон, память, скиллы, systemd, кроны). Идемпотентно.

## Self-service — главная фишка
После деплоя владелец рулит из Telegram-чата:
- «добавь @user в доступ» → бот добавит (pairing, только по команде владельца)
- «поменяй настройку X» → бот правит свой settings
- «запомни правило Y» → бот дописывает свою персону

Без второго инструмента, без инженера.

## Безопасность
Изменения allow-list / настроек / pairing — ТОЛЬКО по команде из чата владельца (его chat_id). Любой другой, написавший боту, никогда не добавляется автоматически. Секреты живут в `agent.env` (он в `.gitignore`) — в репозиторий не попадают.

## Состав
- `onboard.sh` · `assets/install-core.sh` — онбординг/установка
- `assets/` — bin, skills (наши), agents, systemd, templates, vault-skeleton
- `modules/` — опц. аддоны (transport-daemon для макс. устойчивости, vault-web, и др.)

Построен на той же проверенной архитектуре, что и боевые ассистенты. Сторонние скиллы (superpowers, frontend-design) ставятся из их публичных маркетплейсов, а не бандлятся в код.
