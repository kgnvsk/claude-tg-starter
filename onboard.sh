#!/usr/bin/env bash
# Beginner-safe interactive configuration for a fresh deployment.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "FATAL: запусти від root" >&2; exit 1; }
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRODUCT_CONFIG="$KIT/assets/lib/product-config.py"
CONFIG_DIR=/etc/claude-tg-starter
ENV_OUT=/etc/claude-tg-starter/agent.env

python3 "$PRODUCT_CONFIG" get productId >/dev/null || {
  echo "FATAL: конфігурація продукту некоректна" >&2
  exit 2
}
mapfile -t PRODUCT_CHECKS < <(
  python3 "$PRODUCT_CONFIG" list requiredChecks
  python3 "$PRODUCT_CONFIG" list optionalChecks
)
product_check_declared() {
  local expected="$1" check
  for check in "${PRODUCT_CHECKS[@]}"; do
    [ "$check" != "$expected" ] || return 0
  done
  return 1
}
product_feature_declared() {
  python3 "$PRODUCT_CONFIG" has-feature "$1" >/dev/null
}

normalize_username() {
  local value="${1#@}"
  printf '%s' "$value"
}
status_label() {
  case "$1" in
    configured) printf "налаштовано" ;;
    deferred) printf "відкладено" ;;
    enabled) printf "увімкнено" ;;
    disabled) printf "вимкнено" ;;
    *) printf '%s' "$1" ;;
  esac
}
validate_chat_id() { [[ "$1" =~ ^[0-9]{4,20}$ ]]; }
validate_admin_ids() { [[ -z "$1" || "$1" =~ ^[0-9]{4,20}(,[0-9]{4,20})*$ ]]; }
validate_bot_username() { local value="${1#@}"; [[ "$value" =~ ^[A-Za-z0-9_]{1,27}_bot$ ]]; }  # Telegram allows 5-32 chars total, e.g. ab_bot
validate_bot_token() { [[ "$1" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]]; }
validate_timezone() { [ -f "/usr/share/zoneinfo/$1" ] && [[ "$1" != *..* ]]; }
validate_email() { [[ -z "$1" || "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; }
validate_openai_key() { [[ -z "$1" || "$1" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]; }
validate_apify_token() { [[ "$1" =~ ^apify_api_[^[:space:]]{10,}$ ]]; }
validate_asana_token() { [[ "$1" =~ ^[^[:space:]]{20,}$ ]]; }
validate_meta_token() { [[ "$1" =~ ^[^[:space:]]{16,}$ ]]; }
validate_meta_account() { [[ "$1" =~ ^(act_)?[0-9]{4,30}$ ]]; }
validate_hubspot_token() { [[ "$1" =~ ^[^[:space:]]{20,}$ ]]; }
validate_channel_id() { [[ -z "$1" || "$1" =~ ^-100[0-9]{6,}$ ]]; }
validate_recall_key() { [[ "$1" =~ ^[^[:space:]]{20,}$ ]]; }
validate_recall_region() { [[ -z "$1" || "$1" =~ ^(us-west-2|us-east-1|eu-central-1|ap-northeast-1)$ ]]; }

ask_required() {
  local var="$1" prompt="$2" explanation="$3" validator="${4:-}" value
  printf '\n%s\n' "$explanation"
  while :; do
    read -rp "$prompt: " value
    if [ -z "$value" ]; then
      echo "Це обов’язкова відповідь."
    elif [ -n "$validator" ] && ! "$validator" "$value"; then
      echo "Формат не відповідає очікуваному. Перевір значення та спробуй ще раз."
    else
      printf -v "$var" '%s' "$value"
      return
    fi
  done
}

ask_optional() {
  local var="$1" prompt="$2" explanation="$3" validator="${4:-}" value current
  current="${!var:-}"
  printf '\n%s\n' "$explanation"
  while :; do
    if [ -n "$current" ]; then
      read -rp "$prompt (порожня відповідь — залишити поточне значення): " value
      [ -n "$value" ] || value="$current"
    else
      read -rp "$prompt (порожня відповідь — пропустити): " value
    fi
    if [ -n "$validator" ] && ! "$validator" "$value"; then
      echo "Формат не відповідає очікуваному. Виправ значення або залиш відповідь порожньою, щоб пропустити."
    else
      printf -v "$var" '%s' "$value"
      return
    fi
  done
}

ask_optional_clearable() {
  local var="$1" prompt="$2" explanation="$3" validator="${4:-}" value current
  current="${!var:-}"
  printf '\n%s\n' "$explanation"
  while :; do
    if [ -n "$current" ]; then
      read -rp "$prompt (порожня відповідь — залишити; ввести -, щоб очистити): " value
      if [ "$value" = "-" ]; then
        value=""
      elif [ -z "$value" ]; then
        value="$current"
      fi
    else
      read -rp "$prompt (порожня відповідь — залишити порожнім): " value
      [ "$value" = "-" ] && value=""
    fi
    if [ -n "$validator" ] && ! "$validator" "$value"; then
      echo "Формат не відповідає очікуваному. Виправ значення, залиш порожнім або введи -, щоб очистити."
    else
      printf -v "$var" '%s' "$value"
      return
    fi
  done
}

ask_secret() {
  local var="$1" prompt="$2" required="$3" validator="$4" value
  while :; do
    read -rsp "$prompt: " value
    echo
    if [ "$required" = 1 ] && [ -z "$value" ]; then
      echo "Це обов’язковий секрет."
    elif ! "$validator" "$value"; then
      echo "Формат секрету не розпізнано. Спробуй ще раз."
    else
      printf -v "$var" '%s' "$value"
      return
    fi
  done
}

write_env_value() {
  local name="$1"
  printf '%s=' "$name" >> "$ENV_OUT"
  printf '%q' "${!name}" >> "$ENV_OUT"
  printf '\n' >> "$ENV_OUT"
}

# A re-run is allowed to change the guided core fields, but it must not silently
# reset integrations or module choices that were configured earlier.
ALERT_COPY_CHAT_IDS="${ALERT_COPY_CHAT_IDS:-}"
PRESERVE_NAMES=(
  ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS OWNER_EMAIL CALENDAR_EMAIL
  TELEGRAM_BOT_TOKEN OPENAI_API_KEY MEMORY_EMBEDDINGS_OPENAI
  RECALL_API_KEY RECALL_REGION TG_DROP_PENDING_ON_BOOT
  MODULE_DESIGN_PACK MODULE_CHANNEL_PUBLISH MODULE_SOCIAL_BROWSER
  MODULE_TRANSPORT_DAEMON MODULE_VAULT_WEB MODULE_INSTAGRAM_DM
  MODULE_YOUTUBE_COMMENTS CHANNEL_ID SITE_PASSWORD ACTIVE_ROLES
)
if [ -r "$ENV_OUT" ]; then
  PRESERVED_EXPORTS="$(mktemp)"
  trap 'rm -f "${PRESERVED_EXPORTS:-}"' EXIT
  python3 "$KIT/assets/bin/saved-env-export" \
    "$ENV_OUT" "${PRESERVE_NAMES[@]}" > "$PRESERVED_EXPORTS" || {
      echo "FATAL: наявну конфігурацію пошкоджено; її не змінено" >&2
      exit 1
    }
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    printf -v "$name" '%s' "$value"
  done < "$PRESERVED_EXPORTS"
  rm -f "$PRESERVED_EXPORTS"
  PRESERVED_EXPORTS=""
fi
EXISTING_OPENAI_API_KEY="${OPENAI_API_KEY:-}"
EXISTING_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
EXISTING_APIFY_API_TOKEN=""
if [ -r /home/claude/.config/apify-token ]; then
  EXISTING_APIFY_API_TOKEN="$(cat /home/claude/.config/apify-token)"
fi
APIFY_API_TOKEN=""
EXISTING_ASANA_TOKEN=""
if [ -r /home/claude/.config/asana-token ]; then
  EXISTING_ASANA_TOKEN="$(cat /home/claude/.config/asana-token)"
fi
ASANA_TOKEN=""
EXISTING_HUBSPOT_TOKEN=""
if [ -r /home/claude/.config/hubspot-token ]; then
  EXISTING_HUBSPOT_TOKEN="$(cat /home/claude/.config/hubspot-token)"
fi
HUBSPOT_PRIVATE_APP_TOKEN=""
EXISTING_META_ADS=0
META_ACCESS_TOKEN=""
META_AD_ACCOUNT_ID=""
if [ -r /home/claude/.config/meta-ads.json ] &&
   runuser -u claude -- /home/claude/bin/meta-ads doctor >/dev/null 2>&1; then
  EXISTING_META_ADS=1
fi
RECALL_API_KEY="${RECALL_API_KEY:-}"
RECALL_REGION="${RECALL_REGION:-}"
TELEGRAM_CHANNEL_ENV=/home/claude/.claude/channels/telegram/.env
if [ -r "$TELEGRAM_CHANNEL_ENV" ]; then
  [ -n "$EXISTING_TELEGRAM_BOT_TOKEN" ] || EXISTING_TELEGRAM_BOT_TOKEN="$(
    python3 "$KIT/assets/lib/merge-env.py" --value "$TELEGRAM_CHANNEL_ENV" TELEGRAM_BOT_TOKEN
  )"
  [ -n "$RECALL_API_KEY" ] || RECALL_API_KEY="$(
    python3 "$KIT/assets/lib/merge-env.py" --value "$TELEGRAM_CHANNEL_ENV" RECALL_API_KEY
  )"
  [ -n "$RECALL_REGION" ] || RECALL_REGION="$(
    python3 "$KIT/assets/lib/merge-env.py" --value "$TELEGRAM_CHANNEL_ENV" RECALL_REGION
  )"
  MEMORY_EMBEDDINGS_OPENAI_LIVE="$(
    python3 "$KIT/assets/lib/merge-env.py" --value "$TELEGRAM_CHANNEL_ENV" MEMORY_EMBEDDINGS_OPENAI
  )"
  case "$MEMORY_EMBEDDINGS_OPENAI_LIVE" in
    enabled|disabled) MEMORY_EMBEDDINGS_OPENAI="$MEMORY_EMBEDDINGS_OPENAI_LIVE" ;;
    "") ;;
    *)
      echo "FATAL: поточне MEMORY_EMBEDDINGS_OPENAI містить недопустиме значення" >&2
      exit 2
      ;;
  esac
fi
RECALL_REGION="${RECALL_REGION:-eu-central-1}"
TG_DROP_PENDING_ON_BOOT="${TG_DROP_PENDING_ON_BOOT:-0}"
MODULE_DESIGN_PACK="${MODULE_DESIGN_PACK:-0}"
MODULE_CHANNEL_PUBLISH="${MODULE_CHANNEL_PUBLISH:-0}"
MODULE_SOCIAL_BROWSER="${MODULE_SOCIAL_BROWSER:-0}"
MODULE_TRANSPORT_DAEMON="${MODULE_TRANSPORT_DAEMON:-0}"
MODULE_VAULT_WEB="${MODULE_VAULT_WEB:-0}"
MODULE_INSTAGRAM_DM="${MODULE_INSTAGRAM_DM:-0}"
MODULE_YOUTUBE_COMMENTS="${MODULE_YOUTUBE_COMMENTS:-0}"
CHANNEL_ID="${CHANNEL_ID:-}"
SITE_PASSWORD="${SITE_PASSWORD:-}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
CALENDAR_EMAIL="${CALENDAR_EMAIL:-}"
OPENAI_API_KEY="$EXISTING_OPENAI_API_KEY"
if [ -n "$OPENAI_API_KEY" ]; then
  VOICE_SETUP_STATUS=configured
else
  VOICE_SETUP_STATUS=deferred
fi
# Semantic (vector) memory is on by default whenever a voice key exists — the
# OpenAI key serves voice and memory alike (owner decision 2026-09-03). An
# explicit "disabled" in the live environment still wins.
if [ -z "${MEMORY_EMBEDDINGS_OPENAI:-}" ]; then
  if [ -n "$OPENAI_API_KEY" ]; then
    MEMORY_EMBEDDINGS_OPENAI=enabled
  else
    MEMORY_EMBEDDINGS_OPENAI=disabled
  fi
fi
case "$MEMORY_EMBEDDINGS_OPENAI" in
  enabled|disabled) ;;
  *)
    echo "FATAL: MEMORY_EMBEDDINGS_OPENAI містить недопустиме значення" >&2
    exit 2
    ;;
esac

cat <<'INTRO'
============================================================
Налаштування особистого Telegram-асистента

Я ставитиму по одному запитанню й перед кожним пояснюватиму, навіщо воно потрібне.
Секрети не відображаються на екрані та зберігаються лише на цьому сервері.
Необов’язкові функції можна пропустити й підключити пізніше.
============================================================
INTRO

ask_required AGENT_NAME "Ім’я асистента" "Це ім’я, яким асистент представлятиметься. Наприклад: Atlas або Mego."
ask_required OWNER_NAME "Як звертатися до власника" "Ім’я використовується лише в персональних відповідях асистента."
ask_required OWNER_TG_USERNAME "Ім’я користувача власника в Telegram" "Можна ввести з @. Воно потрібне для підпису власника, але права визначаються числовим ID."
OWNER_TG_USERNAME="$(normalize_username "$OWNER_TG_USERNAME")"
ask_required OWNER_CHAT_ID "Числовий ID користувача Telegram" "Відкрий @userinfobot, натисни Start і скопіюй поле Id. Цей ID стане головним адміністратором." validate_chat_id
ask_optional_clearable ADDITIONAL_ADMIN_CHAT_IDS "ID додаткових адміністраторів через кому" "Адміністратори можуть змінювати доступи й налаштування. Залиш порожнім, якщо головний адміністратор один." validate_admin_ids
if product_check_declared google_workspace || \
   product_check_declared vercel_auth || \
   product_check_declared memory_backup; then
  ask_optional OWNER_EMAIL "Email власника" "Знадобиться для підключень цього продукту й резервної копії пам’яті. Можна додати пізніше." validate_email
fi

ask_required BOT_USERNAME "Ім’я користувача нового бота" "Створи бота в @BotFather командою /newbot. Ім’я користувача має закінчуватися на _bot." validate_bot_username
BOT_USERNAME="$(normalize_username "$BOT_USERNAME")"
printf '\nТокен пов’язує сервер лише з новим ботом. Введення приховано; не надсилай токен у чат.\n'
if [ -n "$EXISTING_TELEGRAM_BOT_TOKEN" ]; then
  read -rp "Telegram-токен уже налаштовано. Замінити? [т/Н]: " replace_token
  case "${replace_token:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret TELEGRAM_BOT_TOKEN "Новий токен від @BotFather" 1 validate_bot_token ;;
    *) TELEGRAM_BOT_TOKEN="$EXISTING_TELEGRAM_BOT_TOKEN" ;;
  esac
else
  ask_secret TELEGRAM_BOT_TOKEN "Токен від @BotFather" 1 validate_bot_token
fi
until printf '%s\n' "$TELEGRAM_BOT_TOKEN" |
  "$KIT/assets/bin/verify-telegram-bot" --username "$BOT_USERNAME"; do
  printf '\nПеревірку Telegram не пройдено. Уже введені відповіді збережено в цій сесії.\n'
  read -rp "Порожня відповідь — повторити; u — виправити ім’я користувача; t — ввести інший токен: " telegram_fix
  case "${telegram_fix:-}" in
    u|U)
      ask_required BOT_USERNAME "Ім’я користувача бота" "Введи ім’я користувача саме того бота, якому належить токен." validate_bot_username
      BOT_USERNAME="$(normalize_username "$BOT_USERNAME")"
      ;;
    t|T)
      ask_secret TELEGRAM_BOT_TOKEN "Новий токен від @BotFather" 1 validate_bot_token
      ;;
  esac
done

ask_required TIMEZONE "Часовий пояс у форматі Region/City" "Він потрібен для нагадувань і розкладу. Наприклад: Europe/Kyiv або Europe/Lisbon." validate_timezone

if product_feature_declared channel-publishing; then
  printf '\nПублікація в Telegram-канал — фіксована безпечна адреса призначення.\n'
  printf 'Бота потрібно додати адміністратором каналу. Будь-яка реальна публікація все одно потребує явного підтвердження.\n'
  if [ "$MODULE_CHANNEL_PUBLISH" = 1 ] && validate_channel_id "$CHANNEL_ID"; then
    read -rp "Telegram-канал уже налаштовано ($CHANNEL_ID). Змінити? [т/Н]: " channel_now
    case "${channel_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
        ask_required CHANNEL_ID "Числовий ID Telegram-каналу" "ID починається з -100. Його можна отримати через @userinfobot після пересилання допису з каналу." validate_channel_id
        ;;
    esac
  else
    read -rp "Підключити публікацію в Telegram-канал зараз? [т/Н]: " channel_now
    case "${channel_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
        ask_required CHANNEL_ID "Числовий ID Telegram-каналу" "ID починається з -100. Його можна отримати через @userinfobot після пересилання допису з каналу." validate_channel_id
        MODULE_CHANNEL_PUBLISH=1
        ;;
      *)
        MODULE_CHANNEL_PUBLISH=0
        CHANNEL_ID=""
        ;;
    esac
  fi
fi

if product_check_declared voice_transcription; then
  printf '\nГолосові повідомлення — необов’язкова функція. OpenAI використовується лише для розпізнавання через gpt-4o-mini-transcribe.\n'
  printf 'Ключ створюється на https://platform.openai.com/. Для легкого старту можна внести $5; витрати залежать від аудіо.\n'
  read -rp "Підключити розпізнавання голосових повідомлень зараз? [т/Н]: " voice_now
  case "${voice_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret OPENAI_API_KEY "API-ключ OpenAI (введення приховано)" 0 validate_openai_key
      [ -n "$OPENAI_API_KEY" ] && VOICE_SETUP_STATUS=configured || VOICE_SETUP_STATUS=deferred
      ;;
  esac

  # onboarding state key: memory_semantic_search
  if [ -n "$OPENAI_API_KEY" ] && [ "$MEMORY_EMBEDDINGS_OPENAI" != enabled ]; then
    printf '\nСемантичний пошук у пам’яті — окрема функція й окрема згода власника.\n'
    printf 'Після ввімкнення OpenAI отримує фрагменти сховища й Telegram (до 8 000 символів кожен, до 400 нових документів за запуск індексації) та кожен пошуковий запит; використання може оплачуватися окремо.\n'
    printf 'Без цього пам’ять залишається повністю локальною: пошук за ключовими словами продовжує працювати. Вимкнення: ~/bin/memory-embeddings-config disable.\n'
    read -rp "Дозволити семантичну пам’ять OpenAI зараз? [т/Н]: " memory_embeddings_now
    case "${memory_embeddings_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      MEMORY_EMBEDDINGS_OPENAI=enabled ;;
      *) MEMORY_EMBEDDINGS_OPENAI=disabled ;;
    esac
  elif [ "$MEMORY_EMBEDDINGS_OPENAI" = enabled ]; then
    printf '\nСемантичну пам’ять OpenAI уже ввімкнено за явною згодою власника. Вимкнення: ~/bin/memory-embeddings-config disable.\n'
  fi
fi

if product_check_declared meeting_secretary; then
  printf '\nСекретар зустрічей — необов’язкова функція. Recall.ai підключає бота до Google Meet, Zoom або Teams,\n'
  printf 'створює транскрипт за спікерами та зберігає протокол із завданнями. Ключ береться на https://recall.ai/.\n'
  if [ -n "$RECALL_API_KEY" ]; then
    read -rp "Recall.ai уже налаштовано. Замінити ключ? [т/Н]: " recall_now
  else
    read -rp "Підключити секретаря зустрічей зараз? [т/Н]: " recall_now
  fi
  case "${recall_now:-}" in # ) reply patterns follow
    y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret RECALL_API_KEY "API-ключ Recall.ai (введення приховано)" 1 validate_recall_key
      ask_optional RECALL_REGION "Регіон Recall.ai" "Вибери регіон із панелі: us-west-2, us-east-1, eu-central-1 або ap-northeast-1." validate_recall_region
      RECALL_REGION="${RECALL_REGION:-eu-central-1}"
      ;;
  esac
fi

if product_check_declared apify_social_data; then
  printf '\nApify — необов’язкове джерело публічних даних Instagram, TikTok, YouTube і Facebook.\n'
  printf 'Воно потрібне для вибірок конкурентів, дописів, коментарів і метрик; кожен запуск витрачає кредит Apify.\n'
  printf 'Обліковий запис і API-токен створюються на https://console.apify.com/ → Settings → Integrations.\n'
  if [ -n "$EXISTING_APIFY_API_TOKEN" ]; then
    read -rp "Apify уже налаштовано. Замінити токен? [т/Н]: " apify_now
  else
    read -rp "Підключити соціальні дані Apify зараз? [т/Н]: " apify_now
  fi
  case "${apify_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret APIFY_API_TOKEN "API-токен Apify (введення приховано)" 1 validate_apify_token
      ;;
  esac
fi

if product_check_declared asana_tasks; then
  printf '\nAsana — необов’язкова робоча система завдань для проєктів, виконавців і дедлайнів.\n'
  printf 'Персональний токен доступу створюється в Asana Developer Console. Читання автоматичне; зміни потребують підтвердження власника.\n'
  if [ -n "$EXISTING_ASANA_TOKEN" ]; then
    read -rp "Asana уже налаштована. Замінити токен? [т/Н]: " asana_now
  else
    read -rp "Підключити Asana зараз? [т/Н]: " asana_now
  fi
  case "${asana_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret ASANA_TOKEN "Персональний токен доступу Asana (введення приховано)" 1 validate_asana_token
      ;;
  esac
fi

if product_check_declared meta_ads; then
  printf '\nMeta Ads — джерело фактичних витрат, показів, кліків і конверсій.\n'
  printf 'Для звітів потрібен дозвіл ads_read. Для підтвердженої паузи, запуску й денного бюджету — ads_management.\n'
  printf 'Зміни доступні лише командами set-status/set-budget за точним ID, із підтвердженням і перевірною квитанцією.\n'
  printf 'Токен створюється в Meta for Developers / Business Settings і вводиться лише в прихованому полі тут.\n'
  if [ "$EXISTING_META_ADS" = 1 ]; then
    read -rp "Meta Ads уже налаштовано. Замінити підключення? [т/Н]: " meta_now
  else
    read -rp "Підключити Meta Ads зараз? [т/Н]: " meta_now
  fi
  case "${meta_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret META_ACCESS_TOKEN "Токен доступу Meta (введення приховано)" 1 validate_meta_token
      ask_required META_AD_ACCOUNT_ID "ID рекламного акаунта Meta" "Числовий ID рекламного кабінету у форматі act_123456." validate_meta_account
      ;;
  esac
fi

if product_check_declared hubspot_crm; then
  printf '\nHubSpot CRM — доступ до контактів, компаній, угод і звернень.\n'
  printf 'Для читання потрібні дозволи CRM на читання. Для підтвердженої зміни угоди — дозвіл на запис угод.\n'
  printf 'Підтверджена дія змінює лише етап або власника точної угоди та видає перевірну квитанцію.\n'
  if [ -n "$EXISTING_HUBSPOT_TOKEN" ]; then
    read -rp "HubSpot уже налаштовано. Замінити токен? [т/Н]: " hubspot_now
  else
    read -rp "Підключити HubSpot CRM зараз? [т/Н]: " hubspot_now
  fi
  case "${hubspot_now:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т)
      ask_secret HUBSPOT_PRIVATE_APP_TOKEN "Токен приватного застосунку HubSpot (введення приховано)" 1 validate_hubspot_token
      ;;
  esac
fi

if product_check_declared google_workspace; then
  ask_optional CALENDAR_EMAIL "Email календаря" "Потрібен для календарного дайджесту. Авторизація Google відбуватиметься за окремим OAuth-посиланням." validate_email
fi
if product_check_declared sec_edgar && [ -z "$OWNER_EMAIL" ]; then
  ask_required OWNER_EMAIL "Контактний email для SEC EDGAR" "SEC вимагає справжній контакт у User-Agent автоматичних запитів. Ключ або пароль не потрібен." validate_email
fi
VAULT_LOCALE="${VAULT_LOCALE:-en-US}"

printf '\nПеревір без секретів:\n'
printf '  Асистент: %s\n  Власник: %s (@%s, id %s)\n' "$AGENT_NAME" "$OWNER_NAME" "$OWNER_TG_USERNAME" "$OWNER_CHAT_ID"
printf '  Бот: @%s\n  Часовий пояс: %s\n' "$BOT_USERNAME" "$TIMEZONE"
if product_check_declared voice_transcription; then
  printf '  Голосові: %s\n' "$(status_label "$VOICE_SETUP_STATUS")"
  printf '  Семантична пам’ять: %s (локальний пошук за ключовими словами завжди ввімкнено)\n' "$(status_label "$MEMORY_EMBEDDINGS_OPENAI")"
fi
if product_check_declared meeting_secretary; then
  printf '  Секретар зустрічей: %s\n' "$([ -n "$RECALL_API_KEY" ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_check_declared apify_social_data; then
  printf '  Соціальні дані Apify: %s\n' "$([ -n "$APIFY_API_TOKEN$EXISTING_APIFY_API_TOKEN" ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_check_declared asana_tasks; then
  printf '  Завдання Asana: %s\n' "$([ -n "$ASANA_TOKEN$EXISTING_ASANA_TOKEN" ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_check_declared meta_ads; then
  printf '  Meta Ads: %s\n' "$([ -n "$META_ACCESS_TOKEN" ] || [ "$EXISTING_META_ADS" = 1 ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_check_declared sec_edgar; then
  printf '  Первинні дані SEC EDGAR: %s\n' "$([ -n "$OWNER_EMAIL" ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_check_declared hubspot_crm; then
  printf '  HubSpot CRM: %s\n' "$([ -n "$HUBSPOT_PRIVATE_APP_TOKEN$EXISTING_HUBSPOT_TOKEN" ] && printf 'налаштовано' || printf 'відкладено')"
fi
if product_feature_declared channel-publishing; then
  printf '  Telegram-канал: %s\n' "$([ "$MODULE_CHANNEL_PUBLISH" = 1 ] && printf '%s' "$CHANNEL_ID" || printf 'відкладено')"
fi
printf '  Додаткові адміністратори: %s\n' "${ADDITIONAL_ADMIN_CHAT_IDS:-немає}"
read -rp "Усе правильно? Записати захищену конфігурацію та встановити ядро? [т/Н]: " confirmed
case "${confirmed:-}" in y|Y|yes|YES|да|Да|так|Так|т|Т) ;; *) echo "Скасовано, файли не змінено."; exit 0 ;; esac

install -d -m 700 "$CONFIG_DIR"
if [ -f "$ENV_OUT" ]; then
  cp -a "$ENV_OUT" "$ENV_OUT.backup.$(date -u +%Y%m%dT%H%M%SZ)"
fi
# Restore it right after the secret is written. Left set, this umask follows the
# installer into install-base.sh, where the NodeSource keyring and .sources land
# as 600 root:root — and apt verifies signatures as the _apt user, which then
# cannot read them. The repository comes back "not signed", apt-get update exits
# 100, and a clean-machine install dies there (reported by a buyer 2026-08-01).
env_umask="$(umask)"
umask 077
: > "$ENV_OUT"
for name in AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS OWNER_EMAIL \
            BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN OPENAI_API_KEY VOICE_SETUP_STATUS \
            MEMORY_EMBEDDINGS_OPENAI \
            RECALL_API_KEY RECALL_REGION CALENDAR_EMAIL VAULT_LOCALE TG_DROP_PENDING_ON_BOOT \
            MODULE_DESIGN_PACK MODULE_CHANNEL_PUBLISH MODULE_SOCIAL_BROWSER \
            MODULE_TRANSPORT_DAEMON MODULE_VAULT_WEB MODULE_INSTAGRAM_DM \
            MODULE_YOUTUBE_COMMENTS CHANNEL_ID SITE_PASSWORD; do
  write_env_value "$name"
done
chmod 600 "$ENV_OUT"
umask "$env_umask"

export AGENT_NAME OWNER_NAME OWNER_TG_USERNAME OWNER_CHAT_ID ADDITIONAL_ADMIN_CHAT_IDS ALERT_COPY_CHAT_IDS OWNER_EMAIL
export BOT_USERNAME TIMEZONE TELEGRAM_BOT_TOKEN OPENAI_API_KEY VOICE_SETUP_STATUS MEMORY_EMBEDDINGS_OPENAI
export RECALL_API_KEY RECALL_REGION CALENDAR_EMAIL VAULT_LOCALE TG_DROP_PENDING_ON_BOOT
export MODULE_DESIGN_PACK MODULE_CHANNEL_PUBLISH MODULE_SOCIAL_BROWSER
export MODULE_TRANSPORT_DAEMON MODULE_VAULT_WEB MODULE_INSTAGRAM_DM MODULE_YOUTUBE_COMMENTS
export CHANNEL_ID SITE_PASSWORD

echo "==> Готую систему (пакети, Node)"
bash "$KIT/scripts/install-base.sh"

echo "==> Встановлюю ядро агента"
bash "$KIT/assets/install-core.sh"
if [ -n "$APIFY_API_TOKEN" ]; then
  printf '%s\n' "$APIFY_API_TOKEN" |
    runuser -u claude -- /home/claude/bin/set-apify-token --stdin
  runuser -u claude -- /home/claude/bin/apify-social doctor
fi
if [ -n "$ASANA_TOKEN" ]; then
  printf '%s\n' "$ASANA_TOKEN" |
    runuser -u claude -- /home/claude/bin/set-asana-token --stdin
  runuser -u claude -- /home/claude/bin/asana-tasks doctor
fi
if [ -n "$META_ACCESS_TOKEN" ]; then
  printf '%s\n%s\n' "$META_ACCESS_TOKEN" "$META_AD_ACCOUNT_ID" |
    runuser -u claude -- /home/claude/bin/set-meta-ads-config --stdin
  runuser -u claude -- /home/claude/bin/meta-ads doctor
fi
if product_check_declared sec_edgar && [ -n "$OWNER_EMAIL" ]; then
  printf '%s\n%s\n' "$AGENT_NAME" "$OWNER_EMAIL" |
    runuser -u claude -- /home/claude/bin/set-sec-identity --stdin
  runuser -u claude -- /home/claude/bin/sec-edgar doctor
fi
if [ -n "$HUBSPOT_PRIVATE_APP_TOKEN" ]; then
  printf '%s\n' "$HUBSPOT_PRIVATE_APP_TOKEN" |
    runuser -u claude -- /home/claude/bin/set-hubspot-token --stdin
  runuser -u claude -- /home/claude/bin/hubspot-crm doctor
fi

echo
echo "Ядро встановлено. Наступні обов’язкові етапи для цього продукту:"
echo "1. OAuth-вхід власника в Claude."
echo "2. Telegram-плагін, плагіни навичок та ізольований браузер."
if product_check_declared codex_auth; then
  echo "3. OAuth-вхід у ChatGPT/Codex для генерації зображень."
fi
if product_check_declared google_workspace; then
  echo "4. OAuth-вхід у Google Workspace."
fi
if product_check_declared vercel_auth; then
  echo "5. Авторизація Vercel для розгортання сайтів."
fi
echo "6. Запуск служби, захист сервера та повна перевірка за інструкцією VERIFY.md."
echo
echo "Поточний безпечний список перевірок: runuser -u claude -- /home/claude/bin/onboarding-status"
