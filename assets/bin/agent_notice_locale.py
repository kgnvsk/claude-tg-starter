#!/usr/bin/env python3
"""Opt-in Russian, Polish or English for kit-owned notices; existing agents keep Ukrainian copy.

Only OWNER_NOTICE_LOCALE in the agent's live profile selects these notices.
VAULT_LOCALE configures the web vault and must not change Telegram copy.
"""

from __future__ import annotations

from pathlib import Path
import shlex
import stat


RUSSIAN_NOTICES = {
    "backup.ok": "✅ Приватная резервная копия обновлена и проверена.",
    "backup.scheduled": "✅ Приватная резервная копия обновлена по расписанию.",
    "backup.connected": "✅ Приватный репозиторий GitHub подключён, первая копия проверена.",
    "backup.configured": "✅ Резервное копирование в приватный репозиторий настроено и проверено.",
    "backup.history-unsafe": "Копирование остановлено: в истории Git есть секреты. Автоматически переписывать историю не буду.",
    "backup.history-unverifiable": "Копирование остановлено: не удалось проверить всю историю Git.",
    "backup.error": "Резервное копирование не выполнено.",
    "reminder.memory_backup": (
        "🔐 Напоминание: автоматическое резервное копирование ещё не подключено. "
        "Если с сервером что-то случится, память, навыки и настройки агента не восстановятся автоматически. "
        "Напиши «Настроить резервную копию» — я помогу создать приватный репозиторий GitHub и подключить его. "
        "Чтобы больше не напоминать, напиши: не напоминай о настройке."
    ),
    "queue.restarted": (
        "Процесс агента перезапущен после подтверждённого лимита Claude. "
        "Сохранённый запрос ждёт продолжения с прежним контекстом."
    ),
    "queue.overloaded": "⚠️ Anthropic сейчас перегружен. Запрос сохранён; продолжу его после восстановления доступа.",
    "queue.owner_overloaded": (
        "⚠️ Один из разрешённых чатов не получил ответ: Anthropic перегружен. "
        "Запрос сохранён для продолжения после восстановления доступа."
    ),
    "queue.owner_limit": (
        "⏳ Один из разрешённых чатов не получил ответ из-за лимита Claude. "
        "Запрос сохранён для продолжения после сброса лимита."
    ),
    "queue.background_paused": (
        "⏳ Лимит Claude приостановил задачу. Запрос и контекст сохранены; "
        "продолжу после восстановления доступа."
    ),
    "queue.hung_stopped": (
        "⚠️ Работа над этим запросом зависала трижды, поэтому я её остановил, чтобы не задерживать другие сообщения. "
        "Отправь его снова, если он ещё нужен."
    ),
    "queue.silent_worker": (
        "Фоновая задача запроса {requests} не отвечает: нет ни результата, ни обновлений. "
        "Она больше не задерживает другие сообщения. Если она зависла, пришли /unstick, и запрос выполнится заново."
    ),
    "queue.silent_unconfirmed": (
        "Не знаю, дошло ли сообщение о фоновой задаче запроса {requests}: "
        "процесс прервался или Telegram не подтвердил отправку. Она больше не задерживает другие сообщения."
    ),
    "queue.unread_end": (
        "Служебное уведомление о фоновой задаче запроса {requests} не распознано "
        "(возможно, обновился Claude CLI). Ответ агента на этот запрос больше не ждёт задачу."
    ),
    "queue.unread_timeout": (
        "Служебное уведомление о фоновой задаче запроса {requests} не распознано. "
        "Ожидание этой задачи снято по установленному таймауту."
    ),
    "queue.accepted": "Принял, отвечу чуть позже",
    "queue.login_refused": (
        "⚠️ Claude не принимает мой вход, поэтому запросы сейчас не выполняются. Все они сохранены: "
        "как только вход восстановится, выполню их по очереди — отправлять повторно не нужно. "
        "Ссылка для входа — командой /relogin."
    ),
    "queue.account_unavailable": (
        "⚠️ Агент временно недоступен из-за состояния аккаунта Claude. Требуется действие владельца."
    ),
    "queue.subscription_expired": (
        "⚠️ Claude сообщил, что подписка закончилась. Открой Claude → Settings → Billing и проверь продление. "
        "После продления напиши /relogin, если нужно войти заново. Повторять это сообщение автоматически не буду."
    ),
    "queue.subscription_required": (
        "⚠️ Claude сообщил, что активной подписки нет. Проверь план в Claude → Settings → Billing. "
        "После подключения напиши /relogin, если нужно войти заново. Повторять это сообщение автоматически не буду."
    ),
    "queue.billing": (
        "⚠️ Claude сообщил о проблеме с оплатой или недостаточном балансе. "
        "Проверь оплату в аккаунте Claude или Anthropic Console, который использует агент. "
        "Повторять это сообщение автоматически не буду."
    ),
    # The reminder worker fills the {placeholders} after choosing the language.
    "schedule.interrupted": (
        "⚠️ Автоматическая задача «{task}» прервалась, не завершившись (запуск {time}). "
        "Автоматически не перезапускаю, чтобы не повторить её действия; проверь, что успело прийти."
    ),
    "schedule.interrupted_retry": (
        "⚠️ Автоматическая задача «{task}» прервалась, не завершившись (запуск {time}). "
        "Она только собирает и отправляет данные, поэтому запускаю её ещё раз."
    ),
    "schedule.late": "Напоминание опоздало — вот оно:",
    "schedule.lock_broken": (
        "⚠️ Планировщик задач стоял с {time}: его замок держал процесс от прерванного запуска. "
        "Замок заменён, ничего не останавливая; задачи снова выполняются."
    ),
    "schedule.refused": (
        "⚠️ Не удалось доставить результат задачи «{task}»{where}: Telegram его отклонил. "
        "Автоматически не повторяю; проверь чат и задачу."
    ),
    "schedule.unconfirmed": (
        "⚠️ Не удалось подтвердить доставку результата задачи «{task}»{where}. "
        "Он мог прийти, поэтому автоматически не повторяю, чтобы не создать дубль."
    ),
    "schedule.chat": " в чат {chat}",
    "reminder.undelivered": "⚠️ Не удалось доставить напоминание «{name}». Telegram отклонил: {reason}",
    "secretary.channel_down": "⚠️ Секретарь в {channel} сейчас не слушает: {problem}",
    "secretary.forward": "📩 {channel} · {name}: «{text}»\nОтвет не подготовлен.",
    "secretary.forward_limit": "📩 {channel} · {name}: «{text}»\nОтвет не подготовлен: исчерпан лимит Claude.",
    "secretary.forward_login": "📩 {channel} · {name}: «{text}»\nОтвет не подготовлен: Claude не принимает вход.",
    "secretary.escalate": "📩 {channel} · {name}: «{text}»\nНужен ты: {reason}",
    "secretary.escalate_note": "Нужен ты: {reason}",
    "secretary.proposal": (
        "📩 {channel} · {name}: «{text}»\n\nПредлагаю ответить:\n«{draft}»{note}\n\n"
        "Отправить? Скажи «да» или напиши свой вариант. [{id}]"
    ),
    "secretary.cap": (
        "⚠️ {channel} · {name}: слишком много сообщений за час — дальше отвечай сам или дождись, "
        "пока лимит освободится.\nПоследнее: «{text}»"
    ),
    "secretary.send_failed": "⚠️ {channel} · {name}: ответ не ушёл ({error}).\nСообщение: «{text}»",
    "secretary.new_lead": "🆕 {channel} · {name}: «{text}»\nОтвечаю сам: «{reply}»",
}


# Polish and English (03.10.2026, the owner: AALL speaks Polish, and every kit-owned notice with it).
# The same keys as RUSSIAN_NOTICES, the same {placeholders}; a missing key falls back to Ukrainian.
POLISH_NOTICES = {
    "backup.ok": "✅ Prywatna kopia zapasowa zaktualizowana i sprawdzona.",
    "backup.scheduled": "✅ Prywatna kopia zapasowa zaktualizowana zgodnie z harmonogramem.",
    "backup.connected": "✅ Prywatne repozytorium GitHub podłączone, pierwsza kopia sprawdzona.",
    "backup.configured": "✅ Kopia zapasowa do prywatnego repozytorium skonfigurowana i sprawdzona.",
    "backup.history-unsafe": "Kopiowanie zatrzymane: w historii Git są sekrety. Nie będę automatycznie przepisywać historii.",
    "backup.history-unverifiable": "Kopiowanie zatrzymane: nie udało się sprawdzić całej historii Git.",
    "backup.error": "Kopia zapasowa nie została wykonana.",
    "reminder.memory_backup": (
        "🔐 Przypomnienie: automatyczna kopia zapasowa nie jest jeszcze podłączona. "
        "Jeśli coś stanie się z serwerem, pamięć, umiejętności i ustawienia agenta nie wrócą automatycznie. "
        "Napisz «Skonfiguruj kopię zapasową» — pomogę utworzyć prywatne repozytorium GitHub i je podłączyć. "
        "Żebym więcej nie przypominał, napisz: nie przypominaj o konfiguracji."
    ),
    "queue.restarted": (
        "Proces agenta został uruchomiony ponownie po potwierdzonym limicie Claude. "
        "Zapisane zapytanie czeka na kontynuację z dotychczasowym kontekstem."
    ),
    "queue.overloaded": "⚠️ Anthropic jest teraz przeciążony. Zapytanie zapisane; wrócę do niego, gdy dostęp wróci.",
    "queue.owner_overloaded": (
        "⚠️ Jeden z dozwolonych czatów nie dostał odpowiedzi: Anthropic jest przeciążony. "
        "Zapytanie zapisane do kontynuacji po przywróceniu dostępu."
    ),
    "queue.owner_limit": (
        "⏳ Jeden z dozwolonych czatów nie dostał odpowiedzi z powodu limitu Claude. "
        "Zapytanie zapisane do kontynuacji po zresetowaniu limitu."
    ),
    "queue.background_paused": (
        "⏳ Limit Claude wstrzymał zadanie. Zapytanie i kontekst zapisane; "
        "będę kontynuować po przywróceniu dostępu."
    ),
    "queue.hung_stopped": (
        "⚠️ Praca nad tym zapytaniem zawiesiła się trzy razy, więc ją zatrzymałem, żeby nie blokować innych wiadomości. "
        "Wyślij je ponownie, jeśli nadal jest potrzebne."
    ),
    "queue.silent_worker": (
        "Zadanie w tle dla zapytania {requests} nie odpowiada: brak wyniku i aktualizacji. "
        "Nie blokuje już innych wiadomości. Jeśli się zawiesiło, wyślij /unstick, a zapytanie wykona się od nowa."
    ),
    "queue.silent_unconfirmed": (
        "Nie wiem, czy wiadomość o zadaniu w tle dla zapytania {requests} dotarła: "
        "proces został przerwany albo Telegram nie potwierdził wysłania. Nie blokuje już innych wiadomości."
    ),
    "queue.unread_end": (
        "Nie rozpoznano powiadomienia systemowego o zadaniu w tle dla zapytania {requests} "
        "(możliwe, że zaktualizował się Claude CLI). Odpowiedź agenta na to zapytanie nie czeka już na to zadanie."
    ),
    "queue.unread_timeout": (
        "Nie rozpoznano powiadomienia systemowego o zadaniu w tle dla zapytania {requests}. "
        "Oczekiwanie na to zadanie zakończono po ustalonym czasie."
    ),
    "queue.accepted": "Przyjąłem, odpowiem trochę później",
    "queue.login_refused": (
        "⚠️ Claude nie przyjmuje mojego logowania, więc zapytania nie są teraz wykonywane. Wszystkie są zapisane: "
        "gdy logowanie wróci, wykonam je po kolei — nie trzeba wysyłać ponownie. "
        "Link do logowania — komendą /relogin."
    ),
    "queue.account_unavailable": (
        "⚠️ Agent jest tymczasowo niedostępny z powodu stanu konta Claude. Potrzebne działanie właściciela."
    ),
    "queue.subscription_expired": (
        "⚠️ Claude poinformował, że subskrypcja wygasła. Otwórz Claude → Settings → Billing i sprawdź przedłużenie. "
        "Po przedłużeniu napisz /relogin, jeśli trzeba zalogować się ponownie. Nie będę automatycznie powtarzać tej wiadomości."
    ),
    "queue.subscription_required": (
        "⚠️ Claude poinformował, że nie ma aktywnej subskrypcji. Sprawdź plan w Claude → Settings → Billing. "
        "Po podłączeniu napisz /relogin, jeśli trzeba zalogować się ponownie. Nie będę automatycznie powtarzać tej wiadomości."
    ),
    "queue.billing": (
        "⚠️ Claude zgłosił problem z płatnością lub niewystarczające saldo. "
        "Sprawdź płatność w koncie Claude lub Anthropic Console, którego używa agent. "
        "Nie będę automatycznie powtarzać tej wiadomości."
    ),
    "schedule.interrupted": (
        "⚠️ Automatyczne zadanie «{task}» przerwało się przed zakończeniem (uruchomienie {time}). "
        "Nie uruchamiam go ponownie automatycznie, żeby nie powtórzyć jego działań; sprawdź, co zdążyło dotrzeć."
    ),
    "schedule.interrupted_retry": (
        "⚠️ Automatyczne zadanie «{task}» przerwało się przed zakończeniem (uruchomienie {time}). "
        "Ono tylko zbiera i wysyła dane, więc uruchamiam je jeszcze raz."
    ),
    "schedule.late": "Przypomnienie się spóźniło — oto ono:",
    "schedule.lock_broken": (
        "⚠️ Harmonogram zadań stał od {time}: jego blokadę trzymał proces z przerwanego uruchomienia. "
        "Blokadę wymieniono bez zatrzymywania czegokolwiek; zadania znowu się wykonują."
    ),
    "schedule.refused": (
        "⚠️ Nie udało się dostarczyć wyniku zadania «{task}»{where}: Telegram go odrzucił. "
        "Nie ponawiam automatycznie; sprawdź czat i zadanie."
    ),
    "schedule.unconfirmed": (
        "⚠️ Nie udało się potwierdzić dostarczenia wyniku zadania «{task}»{where}. "
        "Mógł dotrzeć, więc nie ponawiam automatycznie, żeby nie utworzyć duplikatu."
    ),
    "schedule.chat": " do czatu {chat}",
    "reminder.undelivered": "⚠️ Nie udało się dostarczyć przypomnienia «{name}». Telegram odrzucił: {reason}",
    "secretary.channel_down": "⚠️ Sekretarz w {channel} teraz nie słucha: {problem}",
    "secretary.forward": "📩 {channel} · {name}: «{text}»\nOdpowiedź nie została przygotowana.",
    "secretary.forward_limit": "📩 {channel} · {name}: «{text}»\nOdpowiedź nie została przygotowana: wyczerpany limit Claude.",
    "secretary.forward_login": "📩 {channel} · {name}: «{text}»\nOdpowiedź nie została przygotowana: Claude nie przyjmuje logowania.",
    "secretary.escalate": "📩 {channel} · {name}: «{text}»\nPotrzebuję ciebie: {reason}",
    "secretary.escalate_note": "Potrzebuję ciebie: {reason}",
    "secretary.proposal": (
        "📩 {channel} · {name}: «{text}»\n\nProponuję odpowiedzieć:\n«{draft}»{note}\n\n"
        "Wysłać? Powiedz «tak» albo napisz swoją wersję. [{id}]"
    ),
    "secretary.cap": (
        "⚠️ {channel} · {name}: za dużo wiadomości w ciągu godziny — dalej odpowiadaj sam albo poczekaj, "
        "aż limit się zwolni.\nOstatnia: «{text}»"
    ),
    "secretary.send_failed": "⚠️ {channel} · {name}: odpowiedź nie została wysłana ({error}).\nWiadomość: «{text}»",
    "secretary.new_lead": "🆕 {channel} · {name}: «{text}»\nOdpowiadam sam: «{reply}»",
}

ENGLISH_NOTICES = {
    "backup.ok": "✅ Private backup updated and verified.",
    "backup.scheduled": "✅ Private backup updated on schedule.",
    "backup.connected": "✅ Private GitHub repository connected, first backup verified.",
    "backup.configured": "✅ Backup to a private repository set up and verified.",
    "backup.history-unsafe": "Backup stopped: the Git history contains secrets. I will not rewrite the history automatically.",
    "backup.history-unverifiable": "Backup stopped: the whole Git history could not be checked.",
    "backup.error": "Backup failed.",
    "reminder.memory_backup": (
        "🔐 Reminder: automatic backup is not connected yet. "
        "If something happens to the server, the agent's memory, skills and settings will not come back automatically. "
        "Write «Set up backup» and I will help you create a private GitHub repository and connect it. "
        "To stop these reminders, write: don't remind me about the setup."
    ),
    "queue.restarted": (
        "The agent process was restarted after a confirmed Claude limit. "
        "The saved request is waiting to continue with its context."
    ),
    "queue.overloaded": "⚠️ Anthropic is overloaded right now. The request is saved; I will continue it once access is back.",
    "queue.owner_overloaded": (
        "⚠️ One of the allowed chats got no answer: Anthropic is overloaded. "
        "The request is saved to continue once access is back."
    ),
    "queue.owner_limit": (
        "⏳ One of the allowed chats got no answer because of the Claude limit. "
        "The request is saved to continue after the limit resets."
    ),
    "queue.background_paused": (
        "⏳ The Claude limit paused a task. The request and its context are saved; "
        "I will continue once access is back."
    ),
    "queue.hung_stopped": (
        "⚠️ Work on this request hung three times, so I stopped it to keep other messages moving. "
        "Send it again if you still need it."
    ),
    "queue.silent_worker": (
        "The background task of request {requests} is not responding: no result and no updates. "
        "It no longer holds up other messages. If it is stuck, send /unstick and the request will run again."
    ),
    "queue.silent_unconfirmed": (
        "I don't know whether the message about the background task of request {requests} arrived: "
        "the process was interrupted or Telegram did not confirm the send. It no longer holds up other messages."
    ),
    "queue.unread_end": (
        "A system notice about the background task of request {requests} was not recognised "
        "(Claude CLI may have been updated). The agent's answer to this request no longer waits for the task."
    ),
    "queue.unread_timeout": (
        "A system notice about the background task of request {requests} was not recognised. "
        "Waiting for the task ended after the set timeout."
    ),
    "queue.accepted": "Got it, I'll reply a bit later",
    "queue.login_refused": (
        "⚠️ Claude does not accept my login, so requests are not running right now. All of them are saved: "
        "once the login is back I will run them in order — no need to resend. "
        "For a login link, send /relogin."
    ),
    "queue.account_unavailable": (
        "⚠️ The agent is temporarily unavailable because of the Claude account's state. The owner needs to act."
    ),
    "queue.subscription_expired": (
        "⚠️ Claude reported that the subscription has ended. Open Claude → Settings → Billing and check the renewal. "
        "After renewing, write /relogin if you need to sign in again. I will not repeat this message automatically."
    ),
    "queue.subscription_required": (
        "⚠️ Claude reported that there is no active subscription. Check the plan in Claude → Settings → Billing. "
        "After connecting one, write /relogin if you need to sign in again. I will not repeat this message automatically."
    ),
    "queue.billing": (
        "⚠️ Claude reported a payment problem or insufficient balance. "
        "Check the payment in the Claude account or Anthropic Console the agent uses. "
        "I will not repeat this message automatically."
    ),
    "schedule.interrupted": (
        "⚠️ The automatic task «{task}» was interrupted before it finished (run {time}). "
        "I am not restarting it automatically so as not to repeat its actions; check what arrived."
    ),
    "schedule.interrupted_retry": (
        "⚠️ The automatic task «{task}» was interrupted before it finished (run {time}). "
        "It only collects and sends data, so I am running it again."
    ),
    "schedule.late": "The reminder is late — here it is:",
    "schedule.lock_broken": (
        "⚠️ The task scheduler had been stuck since {time}: its lock was held by a process from an interrupted run. "
        "The lock was replaced without stopping anything; tasks are running again."
    ),
    "schedule.refused": (
        "⚠️ Could not deliver the result of task «{task}»{where}: Telegram rejected it. "
        "I am not retrying automatically; check the chat and the task."
    ),
    "schedule.unconfirmed": (
        "⚠️ Could not confirm delivery of the result of task «{task}»{where}. "
        "It may have arrived, so I am not retrying automatically to avoid a duplicate."
    ),
    "schedule.chat": " to chat {chat}",
    "reminder.undelivered": "⚠️ Could not deliver the reminder «{name}». Telegram rejected it: {reason}",
    "secretary.channel_down": "⚠️ The secretary in {channel} is not listening right now: {problem}",
    "secretary.forward": "📩 {channel} · {name}: «{text}»\nNo reply prepared.",
    "secretary.forward_limit": "📩 {channel} · {name}: «{text}»\nNo reply prepared: the Claude limit is used up.",
    "secretary.forward_login": "📩 {channel} · {name}: «{text}»\nNo reply prepared: Claude does not accept the login.",
    "secretary.escalate": "📩 {channel} · {name}: «{text}»\nI need you: {reason}",
    "secretary.escalate_note": "I need you: {reason}",
    "secretary.proposal": (
        "📩 {channel} · {name}: «{text}»\n\nI suggest replying:\n«{draft}»{note}\n\n"
        "Send it? Say «yes» or write your own version. [{id}]"
    ),
    "secretary.cap": (
        "⚠️ {channel} · {name}: too many messages within an hour — reply yourself from here or wait "
        "until the limit frees up.\nLast one: «{text}»"
    ),
    "secretary.send_failed": "⚠️ {channel} · {name}: the reply was not sent ({error}).\nMessage: «{text}»",
    "secretary.new_lead": "🆕 {channel} · {name}: «{text}»\nReplying myself: «{reply}»",
}
# The login rescue (claude-auth-rescue) speaks through the same catalog.
RUSSIAN_NOTICES.update({
    'auth.link': '🔐 Срок действия моей авторизации Claude истёк. Восстанови её за минуту, без SSH:\n1) Открой ссылку ниже и войди в свой аккаунт Claude.\n2) Скопируй код со страницы.\n3) Пришли мне сюда код ОДНИМ сообщением (только код, без слов).\n\n{url}\n\n⏳ Жду код 10 минут. Если не успеешь или ссылка перестанет работать — просто напиши мне /relogin, и я сразу пришлю новую (сколько угодно раз).',
    'auth.switch_link': '🔐 Переключаю аккаунт Claude по твоей команде. Текущий вход{current} работает, пока не завершишь новый:\n1) Открой ссылку ниже и войди в НУЖНЫЙ аккаунт Claude.\n2) Скопируй код со страницы.\n3) Пришли мне сюда код ОДНИМ сообщением (только код, без слов).\n\n{url}\n\n⏳ Жду код 10 минут. Передумал — ничего не присылай, всё останется как есть. Новая ссылка — командой /relogin.',
    'auth.hidden': 'скрыто',
    'auth.new_login': 'новый вход',
    'auth.previous_login': 'прежнем входе',
    'auth.settings': 'настройках',
    'auth.queued': 'Службу перезапустил, сохранённые запросы остаются в очереди.',
    'auth.zombie_warn': '\n⚠️ В {where} остался {zombies} — старый токен перекрывает новую авторизацию (бот получит 401). Удали эту строку и перезапусти меня.',
    'auth.restored': '✅ Вход в Claude восстановлен. ',
    'auth.switched': '✅ Аккаунт Claude изменён: теперь {who}. ',
    'auth.same_account': '✅ Вход выполнен, но это тот же аккаунт Claude ({who}): если его лимит исчерпан, ответы пойдут после сброса. ',
    'auth.unverified': '✅ Вход в Claude выполнен, но не удалось проверить, какой это аккаунт, поэтому пауза из-за лимита, если она была, остаётся до сброса. ',
    'auth.switched_elsewhere': '✅ Аккаунт Claude уже изменён другим способом: теперь {who}. ',
    'auth.restored_elsewhere': '✅ Вход в Claude уже восстановлен другим способом. ',
    'auth.queue_unchecked': '⚠️ Вход восстановлен, но очередь ещё требует проверки. Запросы сохранены.',
    'auth.transport_failed': '⚠️ Авторизация Claude восстановлена, но Telegram-канал не запустился после двух безопасных перезапусков. Восстановление не отмечено завершённым — нужна проверка канала.',
    'auth.code_rejected': '❌ Код не подошёл (или прислан с лишним текстом). Напиши /relogin — пришлю новую ссылку, попробуем ещё раз.',
    'auth.code_rejected_switch': '❌ Код не подошёл (или прислан с лишним текстом). Остаюсь на {who}. Напиши /relogin — пришлю новую ссылку, попробуем ещё раз.',
})
POLISH_NOTICES.update({
    'auth.link': '🔐 Moje logowanie do Claude wygasło. Przywróć je w minutę, bez SSH:\n1) Otwórz link poniżej i zaloguj się do swojego konta Claude.\n2) Skopiuj kod ze strony.\n3) Wyślij mi tutaj kod JEDNĄ wiadomością (tylko kod, bez słów).\n\n{url}\n\n⏳ Czekam na kod 10 minut. Jeśli nie zdążysz albo link przestanie działać — po prostu napisz mi /relogin, a od razu wyślę nowy (dowolną liczbę razy).',
    'auth.switch_link': '🔐 Przełączam konto Claude na twoje polecenie. Obecne logowanie{current} działa, dopóki nie dokończysz nowego:\n1) Otwórz link poniżej i zaloguj się do WŁAŚCIWEGO konta Claude.\n2) Skopiuj kod ze strony.\n3) Wyślij mi tutaj kod JEDNĄ wiadomością (tylko kod, bez słów).\n\n{url}\n\n⏳ Czekam na kod 10 minut. Zmieniłeś zdanie — nic nie wysyłaj, wszystko zostanie bez zmian. Nowy link — komendą /relogin.',
    'auth.hidden': 'ukryte',
    'auth.new_login': 'nowe logowanie',
    'auth.previous_login': 'poprzednim logowaniu',
    'auth.settings': 'ustawieniach',
    'auth.queued': 'Usługa uruchomiona ponownie, zapisane zapytania zostają w kolejce.',
    'auth.zombie_warn': '\n⚠️ W {where} został {zombies} — stary token przesłania nowe logowanie (bot dostanie 401). Usuń tę linię i uruchom mnie ponownie.',
    'auth.restored': '✅ Logowanie do Claude przywrócone. ',
    'auth.switched': '✅ Konto Claude zmienione: teraz {who}. ',
    'auth.same_account': '✅ Zalogowano, ale to to samo konto Claude ({who}): jeśli jego limit jest wyczerpany, odpowiedzi pójdą po resecie. ',
    'auth.unverified': '✅ Zalogowano do Claude, ale nie udało się sprawdzić, które to konto, więc pauza z powodu limitu, jeśli była, trwa do resetu. ',
    'auth.switched_elsewhere': '✅ Konto Claude zostało już zmienione w inny sposób: teraz {who}. ',
    'auth.restored_elsewhere': '✅ Logowanie do Claude zostało już przywrócone w inny sposób. ',
    'auth.queue_unchecked': '⚠️ Logowanie przywrócone, ale kolejka wymaga jeszcze sprawdzenia. Zapytania zapisane.',
    'auth.transport_failed': '⚠️ Logowanie do Claude przywrócone, ale kanał Telegram nie uruchomił się po dwóch bezpiecznych restartach. Przywrócenia nie oznaczono jako zakończonego — trzeba sprawdzić kanał.',
    'auth.code_rejected': '❌ Kod nie pasuje (albo wysłano go z dodatkowym tekstem). Napisz /relogin — wyślę nowy link, spróbujemy jeszcze raz.',
    'auth.code_rejected_switch': '❌ Kod nie pasuje (albo wysłano go z dodatkowym tekstem). Zostaję przy {who}. Napisz /relogin — wyślę nowy link, spróbujemy jeszcze raz.',
})
ENGLISH_NOTICES.update({
    'auth.link': "🔐 My Claude login has expired. Restore it in a minute, no SSH needed:\n1) Open the link below and sign in to your Claude account.\n2) Copy the code from the page.\n3) Send me the code here in ONE message (just the code, no words).\n\n{url}\n\n⏳ I'll wait 10 minutes for the code. If you miss it or the link stops working, just write /relogin and I'll send a fresh one right away (as many times as needed).",
    'auth.switch_link': "🔐 Switching the Claude account at your command. The current login{current} keeps working until you finish the new one:\n1) Open the link below and sign in to the RIGHT Claude account.\n2) Copy the code from the page.\n3) Send me the code here in ONE message (just the code, no words).\n\n{url}\n\n⏳ I'll wait 10 minutes for the code. Changed your mind? Send nothing and everything stays as it is. A fresh link: /relogin.",
    'auth.hidden': 'hidden',
    'auth.new_login': 'the new login',
    'auth.previous_login': 'the previous login',
    'auth.settings': 'the settings',
    'auth.queued': 'The service was restarted; saved requests stay in the queue.',
    'auth.zombie_warn': '\n⚠️ {where} still holds {zombies} — the old token overrides the new login (the bot will get 401). Delete that line and restart me.',
    'auth.restored': '✅ Claude login restored. ',
    'auth.switched': '✅ Claude account changed: now {who}. ',
    'auth.same_account': '✅ Signed in, but it is the same Claude account ({who}): if its limit is used up, replies follow after the reset. ',
    'auth.unverified': '✅ Signed in to Claude, but I could not check which account it is, so a pause for the limit, if there was one, stays until the reset. ',
    'auth.switched_elsewhere': '✅ The Claude account was already changed another way: now {who}. ',
    'auth.restored_elsewhere': '✅ The Claude login was already restored another way. ',
    'auth.queue_unchecked': '⚠️ Login restored, but the queue still needs a check. Requests are saved.',
    'auth.transport_failed': '⚠️ The Claude login is restored, but the Telegram channel did not start after two safe restarts. The recovery is not marked complete — the channel needs a check.',
    'auth.code_rejected': "❌ The code did not work (or came with extra text). Write /relogin and I'll send a fresh link; we'll try again.",
    'auth.code_rejected_switch': "❌ The code did not work (or came with extra text). I stay on {who}. Write /relogin and I'll send a fresh link; we'll try again.",
})
LOCALE_NOTICES = {"ru": RUSSIAN_NOTICES, "pl": POLISH_NOTICES, "en": ENGLISH_NOTICES}


def owner_notice_locale(home: Path) -> str:
    profile = home / ".agent-profile.env"
    try:
        metadata = profile.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > 65536:
            return "uk"
        lines = profile.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return "uk"
    found = []
    for line in lines:
        key, separator, raw = line.partition("=")
        if separator and key == "OWNER_NOTICE_LOCALE":
            try:
                values = shlex.split(raw, posix=True)
            except ValueError:
                return "uk"
            if len(values) != 1:
                return "uk"
            found.extend(values)
    return found[0] if len(found) == 1 and found[0] in {"uk", "ru", "pl", "en"} else "uk"


MONTHS = {
    "uk": ("січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня",
           "жовтня", "листопада", "грудня"),
    "ru": ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
           "октября", "ноября", "декабря"),
    "pl": ("stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września",
           "października", "listopada", "grudnia"),
    "en": ("January", "February", "March", "April", "May", "June", "July", "August", "September",
           "October", "November", "December"),
}


def named_time_zone(home: Path) -> str | None:
    """TIMEZONE from the agent's live profile when it names a real zone, else None."""
    try:
        lines = (home / ".agent-profile.env").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return None
    found = [line.partition("=")[2].strip().strip("'\"") for line in lines if line.startswith("TIMEZONE=")]
    if len(found) != 1:
        return None
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(found[0])
    except (ValueError, KeyError, OSError):
        return None
    return found[0]


def agent_time_zone(home: Path) -> str:
    """TIMEZONE from the agent's live profile, or UTC."""
    return named_time_zone(home) or "UTC"


# Owner, 03.10.2026 (Арти): the person hears that it is the plan's limit and when it resets.
LIMIT_REACHED = {  # (no reset known, with the reset time)
    "uk": ("Уперся в ліміт Claude за тарифом — відповім, щойно він скинеться",
           "Уперся в ліміт Claude за тарифом — відповім після"),
    "ru": ("Упёрся в лимит Claude по тарифу — отвечу, как только он сбросится",
           "Упёрся в лимит Claude по тарифу — отвечу после"),
    "pl": ("Wyczerpał się limit Claude w planie — odpowiem, gdy tylko się odnowi",
           "Wyczerpał się limit Claude w planie — odpowiem po"),
    "en": ("I've hit my Claude plan limit — I'll reply as soon as it resets",
           "I've hit my Claude plan limit — I'll reply after"),
}


def accepted_line(home: Path, reset_epoch_ms: int | None, now_ms: int) -> str:
    """The limit line, the same as the receiver's and the corporate runtime's.

    The reset in the agent's zone, its date only when that is not today there,
    and the zone named only when the profile sets none.
    """
    locale = owner_notice_locale(home)
    later, after = LIMIT_REACHED[locale]
    if not reset_epoch_ms:
        return later
    return f"{after} {reset_time_text(home, reset_epoch_ms, now_ms, locale)}"


def reset_time_text(home: Path, reset_epoch_ms: int, now_ms: int, locale: str) -> str:
    """The reset in the agent's zone: its time, the date only when that is not today there, the zone only when the
    profile names none. The scheduler's task notice words its limit with it too (Арти, 05.10.2026)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo
    named = named_time_zone(home)
    zone = named or "UTC"
    at = datetime.fromtimestamp(reset_epoch_ms / 1000, ZoneInfo(zone))
    today = datetime.fromtimestamp(now_ms / 1000, ZoneInfo(zone)).date()
    day = "" if at.date() == today else f" {at.day} {MONTHS[locale][at.month - 1]}"
    return f"{at:%H:%M}{day}" + ("" if named else f" ({zone})")


def notice_text(key: str, ukrainian: str, *, home: Path) -> str:
    return LOCALE_NOTICES.get(owner_notice_locale(home), {}).get(key, ukrainian)
