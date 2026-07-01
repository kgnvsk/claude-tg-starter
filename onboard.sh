#!/usr/bin/env bash
# onboard.sh — interactive "asks everything" setup for a FRESH agent deploy.
# Run as ROOT on the TARGET server, from the kit dir. Replaces hand-editing
# agent.env: asks every input, writes agent.env (chmod 600), runs install-core.
# OpenClaw-style onboarding — nothing is hardcoded, the agent's name is asked.
#
# ПРИНЦИП ТОНА: объясняй каждый шаг ПРОСТЫМ языком — человек может быть НЕ-технарём
# (бухгалтер, гуманитарий). Он должен понимать ЧТО происходит, ЧТО от него хотят и
# МЕЖДУ ЧЕМ выбирает. Никакого жаргона без перевода (бэкап/Git/токен/деплой/vault).
#
# Usage:
#   ssh root@<SERVER>
#   cd /opt/claude-tg-starter && bash onboard.sh
set -uo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_OUT="$KIT/agent.env"

echo "=================================================="
echo "  Онбординг агента — ответь на вопросы."
echo "  Ничего не пишется на диск до подтверждения в конце."
echo "=================================================="
echo

ask_req() {  # ask_req VAR "prompt" "hint"
  local var="$1" prompt="$2" hint="${3:-}" val
  [ -n "$hint" ] && echo "  ↳ $hint"
  while :; do
    read -rp "$prompt: " val
    [ -n "$val" ] && break
    echo "  ! обязательное поле"
  done
  printf -v "$var" '%s' "$val"
}
ask_opt() {  # ask_opt VAR "prompt" "hint"
  local var="$1" prompt="$2" hint="${3:-}" val
  [ -n "$hint" ] && echo "  ↳ $hint"
  read -rp "$prompt (Enter — пропустить): " val
  printf -v "$var" '%s' "$val"
}

echo "── Агент ──"
ask_req AGENT_NAME "Как назвать агента (имя бота для себя)" "напр. BroAgent. НЕ «Cash» — это чужой агент."
echo
echo "── Владелец ──"
ask_req OWNER_NAME "Имя владельца (для персоны)" "напр. Alex"
ask_req OWNER_TG_USERNAME "Telegram @username владельца (БЕЗ @)"
ask_req OWNER_CHAT_ID "Telegram user_id владельца" "узнать: напиши @userinfobot в Telegram"
ask_opt OWNER_EMAIL "Email владельца" "нужен для веб-vault (Vercel требует, чтобы автор коммита совпадал с email аккаунта). Тот же email — для GitHub ниже."
echo
echo "── Бот ──"
ask_req BOT_USERNAME "Username бота (БЕЗ @, оканчивается на _bot)" "от @BotFather"
ask_req TELEGRAM_BOT_TOKEN "Токен бота" "от @BotFather, вида 1234567890:AA…"
echo
echo "── Окружение ──"
ask_req TIMEZONE "Таймзона (IANA)" "напр. Europe/Lisbon — для кронов"
echo
echo "── Опционально (Enter чтобы пропустить) ──"
ask_opt OPENAI_API_KEY "OpenAI API key" "распознавание голосовых через gpt-4o-mini-transcribe. Пусто → бот сам попросит ключ, когда придёт первое голосовое."
read -rp "Хочешь, чтобы бот слал утренний дайджест дня в 07:30 (события календаря)? [y/N]: " __cal
case "${__cal:-}" in
  y|Y|yes|да|Да) ask_req CALENDAR_EMAIL "  Email Google-календаря для дайджеста" ;;
  *) CALENDAR_EMAIL="" ;;  # нет → крон не ставится
esac
echo

echo "── Копия памяти в интернете + сайт-визитка (по желанию) ──"
echo "  Что это: GitHub — бесплатное облако для кода. Сюда уезжает ПРИВАТНАЯ копия"
echo "  памяти ассистента (его vault — всё, что он про тебя знает) и исходник сайта-vault."
echo "  Зачем: чтобы память не потерялась, если с сервером что-то случится, и чтобы"
echo "  Vercel мог собрать из неё веб-страницу (граф + заметки за паролем). Репозиторий"
echo "  ПРИВАТНЫЙ — видишь только ты."
read -rp "Настроить GitHub сейчас? (нужен для веб-vault) [y/N]: " __gh
case "${__gh:-}" in
  y|Y|yes|да|Да)
    echo "  1) Аккаунт: если его нет — заведи на https://github.com/signup (1 минута, бесплатно)."
    echo "     Совет: используй тот же email, что выше ($([ -n "${OWNER_EMAIL:-}" ] && echo "$OWNER_EMAIL" || echo "OWNER_EMAIL")) —"
    echo "     иначе сайт-визитку из заметок потом может не получиться собрать."
    if command -v gh >/dev/null 2>&1; then
      echo "  2) Вход в GitHub: программа покажет короткий код — открой указанную"
      echo "     страницу в браузере, впиши код и подтверди. Пароль здесь не вводится."
      read -rp "     Запустить 'gh auth login' сейчас? [y/N]: " __ghlogin
      case "${__ghlogin:-}" in
        y|Y|yes|да|Да) gh auth login || echo "  ! gh auth login не завершён — можно повторить позже: gh auth login" ;;
        *) echo "  ↳ ок, позже сам: gh auth login" ;;
      esac
    else
      echo "  2) gh (GitHub CLI) не установлен. Поставь и залогинься позже:"
      echo "       apt-get install -y gh   # или см. https://github.com/cli/cli#installation"
      echo "       gh auth login           # device flow: код вставляешь в браузере"
    fi
    echo "  3) Дальше веб-vault (модуль vault-web) сам закоммитит память и подскажет шаги Vercel."
    ;;
  *) echo "  ↳ пропущено. Без этого запасная копия памяти в интернете и сайт-визитка не заработают — настроишь позже." ;;
esac
echo

echo "=================================================="
echo "  Проверь:"
echo "    Агент:     $AGENT_NAME"
echo "    Владелец:  $OWNER_NAME (@$OWNER_TG_USERNAME, id $OWNER_CHAT_ID)"
echo "    Email:     ${OWNER_EMAIL:-—(веб-vault деплой будет недоступен)}"
echo "    Бот:       @$BOT_USERNAME"
echo "    Токен:     …${TELEGRAM_BOT_TOKEN: -6}"
echo "    TZ:        $TIMEZONE"
echo "    Голос:     $([ -n "$OPENAI_API_KEY" ] && echo вкл || echo выкл)"
echo "    Календарь: ${CALENDAR_EMAIL:-выкл}"
echo "=================================================="
read -rp "Всё верно? Записать agent.env и установить? [y/N]: " ok
case "${ok:-}" in y|Y|yes|да|Да) ;; *) echo "Отменено. Ничего не записано."; exit 0 ;; esac

umask 077
cat > "$ENV_OUT" <<EOF
AGENT_NAME=$AGENT_NAME
OWNER_NAME=$OWNER_NAME
OWNER_TG_USERNAME=$OWNER_TG_USERNAME
OWNER_CHAT_ID=$OWNER_CHAT_ID
OWNER_EMAIL=${OWNER_EMAIL:-}
BOT_USERNAME=$BOT_USERNAME
TIMEZONE=$TIMEZONE
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
OPENAI_API_KEY=$OPENAI_API_KEY
CALENDAR_EMAIL=$CALENDAR_EMAIL
EOF
chmod 600 "$ENV_OUT"
echo "✅ agent.env записан (chmod 600)."
echo "==> Запускаю install-core…"
echo

set -a; . "$ENV_OUT"; set +a
if bash "$KIT/assets/install-core.sh"; then
  echo
  echo "✅ Core готов. Дальше (нужен живой claude из Фазы 2, install-core этого не делает):"
  echo "   • Фаза 3c — Telegram-плагин + golden-патч (DEPLOY.md)"
  echo "   • Фаза 3d — маркетплейс-скиллы:  runuser -l claude -c '~/bin/install-plugins'"
  echo "     (superpowers, frontend-design, impeccable, document/example-skills)"
  echo "   Доп-модули (канал/браузер) — опционально, см. agent.env.example + DEPLOY.md."
else
  echo
  echo "✗ install-core упал — см. ошибку выше. Поправь ввод и запусти снова (идемпотентно)."
  exit 1
fi
