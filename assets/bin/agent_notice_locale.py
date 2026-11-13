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
    "schedule.late_limit": "Запуск в {time} ждал, пока сбросится лимит Claude, — вот результат:",
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
    "schedule.digest": "📋 Автоматические задачи за сутки — что не сработало:",
    "schedule.digest_failed": "• «{task}» — не выполнено {count} раз; последняя причина: {reason}",
    "schedule.digest_unheard": " (без отдельного уведомления: {unheard})",
    "schedule.digest_missed": "• «{task}» — должна была запуститься {time}, но не запустилась",
    "schedule.digest_error": "ошибка выполнения",
    "schedule.digest_refused": "Telegram отклонил результат",
    "schedule.digest_uncertain": "запуск прервался или доставка не подтверждена",
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
    "schedule.late_limit": "Uruchomienie o {time} czekało na reset limitu Claude — oto wynik:",
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
    "schedule.digest": "📋 Zadania automatyczne z ostatniej doby — co nie zadziałało:",
    "schedule.digest_failed": "• «{task}» — nie wykonano {count} razy; ostatnia przyczyna: {reason}",
    "schedule.digest_unheard": " (bez osobnego powiadomienia: {unheard})",
    "schedule.digest_missed": "• «{task}» — miało się uruchomić {time}, ale się nie uruchomiło",
    "schedule.digest_error": "błąd wykonania",
    "schedule.digest_refused": "Telegram odrzucił wynik",
    "schedule.digest_uncertain": "uruchomienie się przerwało albo dostarczenie nie zostało potwierdzone",
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
    "schedule.late_limit": "The run due at {time} waited for the Claude limit to reset — here is the result:",
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
    "schedule.digest": "📋 Scheduled tasks over the past day — what did not work:",
    "schedule.digest_failed": "• «{task}» — failed {count} times; last reason: {reason}",
    "schedule.digest_unheard": " (without a separate notice: {unheard})",
    "schedule.digest_missed": "• «{task}» — was due {time} but did not start",
    "schedule.digest_error": "run error",
    "schedule.digest_refused": "Telegram refused the result",
    "schedule.digest_uncertain": "the run broke off or the delivery was not confirmed",
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
# The status a chat sees while the native session compacts (tg-compaction-notice). AALL's Polish team
# had the kit text translated by hand on 25.09.2026; the profile now says it.
RUSSIAN_NOTICES["compaction.notice"] = "Секундочку, сейчас сжимаю контекст разговора. После этого продолжу задачу."
POLISH_NOTICES["compaction.notice"] = "Chwileczkę, porządkuję pamięć rozmowy. Zaraz wracam do zadania."
ENGLISH_NOTICES["compaction.notice"] = "One moment, I'm compacting our conversation. I'll continue the task right after."
# The bot's command menu (set-tg-commands; the receiver publishes the same texts on every start). Борис,
# 31.10.2026: his Russian agent showed the Ukrainian menu.
RUSSIAN_NOTICES.update({
    "menu.fix": "Оживить бота, если молчит — работает, даже когда он не отвечает",
    "menu.relogin": "Прислать новую ссылку для входа — работает, даже когда бот не отвечает",
    "menu.health": "Состояние Telegram и очереди; в режиме компании — без модели",
    "menu.unstick": "Разблокировать запрос; в режиме компании — только эту сессию",
    "menu.restart": "Перезапустить бота (нужен работающий бот)",
})
POLISH_NOTICES.update({
    "menu.fix": "Ożyw bota, gdy milczy — działa nawet wtedy, gdy nie odpowiada",
    "menu.relogin": "Wyślij nowy link do logowania — działa nawet wtedy, gdy bot nie odpowiada",
    "menu.health": "Stan Telegrama i kolejki; w trybie firmowym — bez modelu",
    "menu.unstick": "Odblokuj prośbę; w trybie firmowym — tylko tę sesję",
    "menu.restart": "Uruchom bota ponownie (bot musi działać)",
})
ENGLISH_NOTICES.update({
    "menu.fix": "Revive the bot when it is silent — works even when it does not answer",
    "menu.relogin": "Send a fresh sign-in link — works even when the bot does not answer",
    "menu.health": "Telegram and queue status; in company mode — without the model",
    "menu.unstick": "Unblock a request; in company mode — this session only",
    "menu.restart": "Restart the bot (the bot must be running)",
})
# agent-rules: one conversation's rules too long to pass on whole (a hand-edited set); {size} is filled in.
RUSSIAN_NOTICES["rules.overflow"] = ("⚠️ Правила одной из бесед агента слишком длинные, чтобы передать их целиком ({size} знаков). "
                                     "Агент читает их из файла. Разделите эти правила: часть процедур можно перенести в навыки.")
POLISH_NOTICES["rules.overflow"] = ("⚠️ Zasady jednej z rozmów agenta są zbyt długie, by przekazać je w całości ({size} znaków). "
                                    "Agent czyta je z pliku. Podziel te zasady: część procedur można przenieść do umiejętności.")
ENGLISH_NOTICES["rules.overflow"] = ("⚠️ The rules of one of the agent's conversations are too long to pass on whole ({size} characters). "
                                     "The agent reads them from a file. Split these rules: some procedures can move into skills.")
# Owner, 02.11.2026 (Brodsky, «полностью на русский»): the last kit texts that only spoke Ukrainian —
# health alerts, the /unstick and /relogin answers, the GitHub backup dialog and the scheduler's
# topic notices. Each entry is (ru, pl, en); the Ukrainian copy stays at its call site.
_LATER_NOTICES = {
    "health.prefix": ("🚨 {agent}, проверка состояния: ", "🚨 {agent}, kontrola stanu: ", "🚨 {agent}, health check: "),
    "health.subscription": (
        "Claude Code недоступен для аккаунта Claude, под которым я работаю. Владельцу аккаунта: проверь подписку на "
        "claude.ai → Settings → Billing. Если подписка активна, а аккаунт принадлежит компании, попроси администратора "
        "компании включить доступ к Claude Code. Как только доступ вернётся, я заработаю сам; чтобы войти другим "
        "аккаунтом, напиши /relogin.",
        "Claude Code jest niedostępny dla konta Claude, na którym pracuję. Właściciel konta: sprawdź subskrypcję na "
        "claude.ai → Settings → Billing. Jeśli subskrypcja jest aktywna, a konto należy do firmy, poproś administratora "
        "firmy o włączenie dostępu do Claude Code. Gdy dostęp wróci, zacznę działać sam; aby zalogować się innym kontem, "
        "napisz /relogin.",
        "Claude Code is unavailable for the Claude account I run on. Account owner: check the subscription at "
        "claude.ai → Settings → Billing. If the subscription is active and the account belongs to a company, ask the "
        "company admin to enable Claude Code access. As soon as access is back I'll start working by myself; to sign in "
        "with another account, send /relogin."),
    "health.on_hold": (
        "Аккаунт Claude, под которым я работаю, приостановлен. Владельцу аккаунта: проверь почту от Anthropic и "
        "состояние аккаунта на claude.ai.",
        "Konto Claude, na którym pracuję, zostało zawieszone. Właściciel konta: sprawdź pocztę od Anthropic i stan "
        "konta na claude.ai.",
        "The Claude account I run on is suspended. Account owner: check your email from Anthropic and the account "
        "status at claude.ai."),
    "health.verification": (
        "Claude просит подтвердить аккаунт, под которым я работаю. Владельцу аккаунта: войди на claude.ai, пройди "
        "проверку, потом напиши мне /relogin.",
        "Claude prosi o potwierdzenie konta, na którym pracuję. Właściciel konta: zaloguj się na claude.ai, przejdź "
        "weryfikację, a potem napisz mi /relogin.",
        "Claude asks to verify the account I run on. Account owner: sign in at claude.ai, complete the verification, "
        "then send me /relogin."),
    "health.billing": (
        "На аккаунте Claude закончились средства. Владельцу аккаунта: пополни баланс в настройках Claude на claude.ai.",
        "Na koncie Claude skończyły się środki. Właściciel konta: doładuj saldo w ustawieniach Claude na claude.ai.",
        "The Claude account is out of credit. Account owner: top up the balance in the Claude settings at claude.ai."),
    "health.logged_out": (
        "Меня разлогинило. Напиши /relogin — я пришлю ссылку для входа.",
        "Zostałem wylogowany. Napisz /relogin — wyślę link do logowania.",
        "I've been signed out. Send /relogin and I'll send a sign-in link."),
    "health.model": (
        "Модель{model} из моих настроек недоступна для этого аккаунта. Напиши нам — нужно сменить модель.",
        "Model{model} z moich ustawień jest niedostępny dla tego konta. Napisz do nas — trzeba zmienić model.",
        "The model{model} in my settings is not available for this account. Write to us — the model has to be changed."),
    "health.refused": (
        "Claude отклоняет мои запросы, и перезапуск не помогает. Напиши нам — мы посмотрим.",
        "Claude odrzuca moje zapytania, a restart nie pomaga. Napisz do nas — przyjrzymy się temu.",
        "Claude is refusing my requests and a restart doesn't help. Write to us — we'll take a look."),
    "health.limit": (
        "Упёрся в лимит аккаунта. Он сам отпустит; напиши /health, чтобы увидеть когда.",
        "Wyczerpałem limit konta. Sam się odnowi; napisz /health, żeby zobaczyć kiedy.",
        "I've hit the account limit. It will lift by itself; send /health to see when."),
    "health.relogin_needed": (
        "Меня разлогинило — нужен новый вход. Напиши /relogin, и я пришлю ссылку.",
        "Zostałem wylogowany — potrzebne jest ponowne logowanie. Napisz /relogin, a wyślę link.",
        "I've been signed out — a new sign-in is needed. Send /relogin and I'll send a link."),
    "health.anthropic_down": (
        "Это сбой на стороне Anthropic, не у меня: модели отвечают ошибкой. Я вернусь сам, когда их починят — статус "
        "на status.anthropic.com.",
        "To awaria po stronie Anthropic, nie u mnie: modele odpowiadają błędem. Wrócę sam, gdy je naprawią — status na "
        "status.anthropic.com.",
        "This is an outage on Anthropic's side, not mine: the models answer with an error. I'll be back by myself once "
        "they fix it — status at status.anthropic.com."),
    "health.lost_turn": (
        "Вход и лимит в порядке — похоже, потерялся ход. Напиши /unstick: запрос сохранён, я возьму его снова, "
        "пересылать не нужно.",
        "Logowanie i limit są w porządku — wygląda na to, że zgubił się krok. Napisz /unstick: zapytanie jest zapisane, "
        "podejmę je ponownie, nie trzeba go przesyłać.",
        "Sign-in and limit are fine — a turn seems to have got lost. Send /unstick: the request is saved, I'll pick it "
        "up again, no need to resend it."),
    "health.crash_stopped": (
        "Я падаю сразу после запуска ({count} раз за 10 мин), поэтому остановился, чтобы не крутиться в сбоях. "
        "Напиши нам — это нужно посмотреть руками.",
        "Padam zaraz po uruchomieniu ({count} razy w 10 min), więc się zatrzymałem, żeby nie kręcić się w awariach. "
        "Napisz do nas — trzeba to sprawdzić ręcznie.",
        "I crash right after starting ({count} times in 10 min), so I stopped myself instead of looping through "
        "failures. Write to us — this needs a hands-on look."),
    "health.crash_running": (
        "Я падаю сразу после запуска ({count} раз за 10 мин) и не смог сам остановиться. Напиши нам — это нужно "
        "посмотреть руками.",
        "Padam zaraz po uruchomieniu ({count} razy w 10 min) i nie udało mi się samemu zatrzymać. Napisz do nas — "
        "trzeba to sprawdzić ręcznie.",
        "I crash right after starting ({count} times in 10 min) and could not stop myself. Write to us — this needs a "
        "hands-on look."),
    "health.browser_down": (
        "Браузер не работает уже полчаса, и перезапуск не помогает. Напиши нам — это нужно смотреть руками.",
        "Przeglądarka nie działa od pół godziny, a restart nie pomaga. Napisz do nas — trzeba to sprawdzić ręcznie.",
        "The browser has been down for half an hour and a restart doesn't help. Write to us — this needs a hands-on "
        "look."),
    "health.malformed_tool": (
        "Я не смог сам восстановиться после сбоя. Напиши нам — это нужно посмотреть руками.",
        "Nie udało mi się samemu podnieść po awarii. Napisz do nas — trzeba to sprawdzić ręcznie.",
        "I could not recover from a failure by myself. Write to us — this needs a hands-on look."),
    "health.service_down": (
        "Я не могу запуститься уже несколько минут, и автоматический старт не помогает. Напиши нам.",
        "Od kilku minut nie mogę się uruchomić, a automatyczny start nie pomaga. Napisz do nas.",
        "I haven't been able to start for several minutes and the automatic start doesn't help. Write to us."),
    "health.limit_watch_silent": (
        "Моя проверка лимитов Claude не работает уже {minutes} мин. Пока она молчит, я могу замолчать, когда "
        "закончится лимит, и никто не узнает почему. Напиши нам.",
        "Moje sprawdzanie limitów Claude nie działa od {minutes} min. Dopóki milczy, mogę ucichnąć, gdy skończy się "
        "limit, i nikt nie będzie wiedział dlaczego. Napisz do nas.",
        "My Claude limit check has not been working for {minutes} min. While it is silent, I may go quiet when the "
        "limit runs out and nobody will know why. Write to us."),
    "health.low_disk": (
        "На сервере заканчивается место (свободно {pct}%). Когда оно закончится, я перестану работать. Напиши нам — "
        "нужно почистить сервер.",
        "Na serwerze kończy się miejsce (wolne {pct}%). Gdy się skończy, przestanę działać. Napisz do nas — trzeba "
        "wyczyścić serwer.",
        "The server is running out of disk space ({pct}% free). When it runs out, I'll stop working. Write to us — the "
        "server needs cleaning."),
    "health.whatsapp_unlinked": (
        "WhatsApp отвязал сервер: сообщения WhatsApp сейчас не читаются и не отправляются. Чтобы привязать снова, "
        "напиши мне «привяжи WhatsApp».",
        "WhatsApp odłączył serwer: wiadomości WhatsApp nie są teraz czytane ani wysyłane. Aby połączyć ponownie, "
        "napisz mi «połącz WhatsApp».",
        "WhatsApp unlinked the server: WhatsApp messages are not being read or sent right now. To link it again, send "
        "me «link WhatsApp»."),
    "health.whatsapp_offline": (
        "WhatsApp на этом сервере без связи уже {minutes} мин: сообщения WhatsApp сейчас не читаются и не "
        "отправляются. Привязка цела; если за полчаса не заработает — напиши нам.",
        "WhatsApp na tym serwerze nie ma połączenia od {minutes} min: wiadomości WhatsApp nie są teraz czytane ani "
        "wysyłane. Powiązanie jest całe; jeśli w ciągu pół godziny nie zadziała — napisz do nas.",
        "WhatsApp on this server has had no connection for {minutes} min: WhatsApp messages are not being read or sent "
        "right now. The link is intact; if it does not work within half an hour, write to us."),
    "health.answered_unsettled": (
        "Я ответил на сообщение, но очередь не освободилась уже {minutes} мин, и следующие сообщения ждут. Напиши нам — "
        "нужно проверить доставку (код {code}).",
        "Odpowiedziałem na wiadomość, ale kolejka nie zwolniła się od {minutes} min i kolejne wiadomości czekają. "
        "Napisz do nas — trzeba sprawdzić dostarczenie (kod {code}).",
        "I answered a message, but the queue has not cleared for {minutes} min and the next messages are waiting. "
        "Write to us — the delivery needs checking (code {code})."),
    "health.corporate_paused": (
        "⏸ Сотрудникам я не отвечаю уже ~{minutes} мин: корпоративный режим на паузе ({reason}). Твой чат работает. "
        "Напиши мне «восстанови корпоративный приёмник».",
        "⏸ Pracownikom nie odpowiadam od ~{minutes} min: tryb firmowy jest wstrzymany ({reason}). Twój czat działa. "
        "Napisz mi «przywróć odbiornik firmowy».",
        "⏸ I haven't answered employees for ~{minutes} min: company mode is paused ({reason}). Your chat works. Send "
        "me «restore the company receiver»."),
    "health.pause_auth": ("слетел вход в Claude", "wylogowało z Claude", "the Claude sign-in dropped"),
    "health.pause_startup": ("не удалось запуститься", "nie udało się uruchomić", "it failed to start"),
    "health.pause_manual": ("поставлен вручную", "wstrzymano ręcznie", "paused by hand"),
    "health.pause_other": ("причина: {reason}", "przyczyna: {reason}", "reason: {reason}"),
    "health.pause_unknown": ("неизвестна", "nieznana", "unknown"),
    "health.corporate_unavailable": (
        "⚠️ За 15 мин я {count} раз ответил гостям и группам «Корпоративный режим временно недоступен», хотя он у тебя "
        "не включён, так что они остаются без ответа. Напиши мне «проверь корпоративное состояние» или нам.",
        "⚠️ W ciągu 15 min {count} razy odpowiedziałem gościom i grupom «Tryb firmowy jest chwilowo niedostępny», "
        "chociaż nie masz go włączonego, więc zostają bez odpowiedzi. Napisz mi «sprawdź stan trybu firmowego» albo do "
        "nas.",
        "⚠️ In 15 min I replied «Company mode is temporarily unavailable» to guests and groups {count} times, although "
        "you don't have it enabled, so they are left without an answer. Send me «check the company state» or write to "
        "us."),
    "health.stuck": (
        "Не отвечаю на сообщение уже {minutes} мин. {verdict}",
        "Od {minutes} min nie odpowiadam na wiadomość. {verdict}",
        "I haven't answered a message for {minutes} min. {verdict}"),
    "health.api_error": ("Я не могу отвечать: {problem}", "Nie mogę odpowiadać: {problem}", "I can't answer: {problem}"),
    "health.api_error_restarted": (
        "Я не могу отвечать: {problem} Перезапуск не помог.",
        "Nie mogę odpowiadać: {problem} Restart nie pomógł.",
        "I can't answer: {problem} A restart didn't help."),
    "health.vault_sync": (
        "новые изменения заметок не попадают в историю изменений и резервную копию с {since} UTC: автосохранение не "
        "проходит, потому что {why}.{place} Заметки на сервере на месте. Напиши нам — починим.",
        "nowe zmiany notatek nie trafiają do historii zmian ani do kopii zapasowej od {since} UTC: automatyczny zapis "
        "nie przechodzi, bo {why}.{place} Notatki na serwerze są na miejscu. Napisz do nas — naprawimy.",
        "new note changes have not reached the change history or the backup since {since} UTC: autosave fails because "
        "{why}.{place} The notes on the server are intact. Write to us — we'll fix it."),
    "health.vault_secret": (
        "в заметках попалось что-то похожее на ключ доступа",
        "w notatkach trafiło się coś podobnego do klucza dostępu",
        "something resembling an access key turned up in the notes"),
    "health.vault_unverifiable": (
        "историю заметок не удаётся проверить (бывает из-за файла больше 100 МБ)",
        "historii notatek nie da się sprawdzić (zdarza się przez plik większy niż 100 MB)",
        "the note history cannot be checked (this happens with a file over 100 MB)"),
    "health.vault_dirty": (
        "в git остались незавершённые изменения", "w git zostały niedokończone zmiany",
        "unfinished changes are left in git"),
    "health.vault_where": (" Где: {places}.", " Gdzie: {places}.", " Where: {places}."),
    "health.vault_in": (" в ", " w ", " in "),
    "unstick.updating": (
        "🛠 Сейчас идёт обновление — перезапускать меня именно сейчас опасно, это прервёт его на полпути. Напиши ещё "
        "раз через несколько минут.",
        "🛠 Trwa teraz aktualizacja — restartowanie mnie właśnie teraz jest niebezpieczne, przerwie ją w połowie. "
        "Napisz ponownie za kilka minut.",
        "🛠 An update is running right now — restarting me now is unsafe, it would cut the update off halfway. Send it "
        "again in a few minutes."),
    "unstick.hold_loops": (
        "Автоперезапуски выключены на {minutes} мин — проверка состояния перезапускала меня {loops} раз за 10 минут, "
        "именно это и мешало.",
        "Automatyczne restarty wyłączone na {minutes} min — kontrola stanu restartowała mnie {loops} razy w 10 minut i "
        "właśnie to przeszkadzało.",
        "Automatic restarts are off for {minutes} min — the health check restarted me {loops} times in 10 minutes, and "
        "that is exactly what got in the way."),
    "unstick.hold": (
        "Автоперезапуски выключены на {minutes} мин, чтобы ничего не мешало.",
        "Automatyczne restarty wyłączone na {minutes} min, żeby nic nie przeszkadzało.",
        "Automatic restarts are off for {minutes} min so nothing gets in the way."),
    "unstick.restart_failed": (
        "🛠 Принято, но я не смог перезапуститься. Твои запросы сохранены; если через несколько минут я не отвечу — "
        "напиши нам.",
        "🛠 Przyjęte, ale nie udało mi się zrestartować. Twoje zapytania są zapisane; jeśli za kilka minut nie odpowiem "
        "— napisz do nas.",
        "🛠 Got it, but I couldn't restart. Your requests are saved; if I don't answer in a few minutes, write to us."),
    "unstick.restarted": (
        "🔄 Принято. Служба перезапущена один раз.", "🔄 Przyjęte. Usługa została zrestartowana raz.",
        "🔄 Got it. The service was restarted once."),
    "unstick.unstuck": (
        "🛠 Принято. {verdict} Служба перезапущена один раз — сохранённые запросы остаются в очереди.",
        "🛠 Przyjęte. {verdict} Usługa została zrestartowana raz — zapisane zapytania zostają w kolejce.",
        "🛠 Got it. {verdict} The service was restarted once — saved requests stay in the queue."),
    "relogin.superseded": (
        "⚠️ Одновременно пришёл запрос на вход из другого разрешённого чата. Запускаю одну новую ссылку там; повтори "
        "/relogin позже, если нужна отдельная ссылка.",
        "⚠️ Jednocześnie przyszła prośba o logowanie z innego dozwolonego czatu. Uruchamiam jeden nowy link tam; powtórz "
        "/relogin później, jeśli potrzebujesz osobnego linku.",
        "⚠️ A sign-in request came from another allowed chat at the same time. I'm starting one new link there; repeat "
        "/relogin later if you need a separate link."),
    "relogin.starting": (
        "🔄 Запускаю повторный вход — через несколько секунд пришлю свежую ссылку.",
        "🔄 Uruchamiam ponowne logowanie — za kilka sekund wyślę świeży link.",
        "🔄 Starting a new sign-in — I'll send a fresh link in a few seconds."),
    "schedule.topic_refused": (
        "⚠️ Не удалось доставить запланированное сообщение в тему {thread} (задача {task}). Telegram отклонил его. В "
        "общий чат сообщение не отправлялось; проверь тему и задачу.",
        "⚠️ Nie udało się dostarczyć zaplanowanej wiadomości do wątku {thread} (zadanie {task}). Telegram ją odrzucił. "
        "Do czatu ogólnego wiadomość nie została wysłana; sprawdź wątek i zadanie.",
        "⚠️ A scheduled message could not be delivered to topic {thread} (task {task}). Telegram refused it. It was not "
        "sent to the general chat; check the topic and the task."),
    "schedule.topic_unconfirmed": (
        "⚠️ Не удалось подтвердить доставку запланированного сообщения в тему {thread} (задача {task}). Оно могло "
        "дойти, поэтому автоматически повторять не буду, чтобы не создать дубль. В общий чат его не пересылали; "
        "проверь тему и задачу.",
        "⚠️ Nie udało się potwierdzić dostarczenia zaplanowanej wiadomości do wątku {thread} (zadanie {task}). Mogła "
        "dotrzeć, więc nie powtórzę jej automatycznie, żeby nie zrobić duplikatu. Do czatu ogólnego jej nie przesłano; "
        "sprawdź wątek i zadanie.",
        "⚠️ Delivery of a scheduled message to topic {thread} (task {task}) could not be confirmed. It may have arrived, "
        "so I won't repeat it automatically to avoid a duplicate. It was not forwarded to the general chat; check the "
        "topic and the task."),
    "schedule.unapproved": (
        "⚠️ Автоматическая задача «{task}» ещё не выполнена: нужно обновить доступ Claude для планировщика. Повторю, "
        "как только доступ обновится.",
        "⚠️ Zadanie automatyczne «{task}» nie zostało jeszcze wykonane: trzeba odnowić dostęp Claude dla harmonogramu. "
        "Powtórzę, gdy tylko dostęp zostanie odnowiony.",
        "⚠️ The automatic task «{task}» has not run yet: the scheduler's Claude access needs renewing. I'll retry as "
        "soon as the access is renewed."),
    "backup.auto_failed": (
        "Автоматический полный бекап в GitHub не удалось завершить. {prior}Напиши мне «проверь бекап»: проверим доступ "
        "к приватному репозиторию, срок действия токена и свободное место.",
        "Nie udało się dokończyć automatycznego pełnego backupu w GitHub. {prior}Napisz mi «sprawdź backup»: sprawdzimy "
        "dostęp do prywatnego repozytorium, ważność tokena i wolne miejsce.",
        "The automatic full GitHub backup could not be completed. {prior}Send me «check backup»: we'll check access to "
        "the private repository, the token's expiry and free space."),
    "backup.prior_kept": (
        "Предыдущая успешная копия сохранена. ", "Poprzednia udana kopia jest zachowana. ",
        "The previous successful backup is kept. "),
    "backup.no_prior": (
        "Первая успешная копия ещё не создана. ", "Pierwsza udana kopia nie została jeszcze utworzona. ",
        "No successful backup has been made yet. "),
    "backup.chat_first_running": (
        "Первая копия ещё создаётся. Сообщу результат после проверки загрузки.",
        "Pierwsza kopia jest jeszcze tworzona. Dam znać o wyniku po sprawdzeniu przesłania.",
        "The first backup is still being made. I'll report the result once the upload is verified."),
    "backup.chat_login_expired": (
        "Время для входа в GitHub истекло.", "Czas na zalogowanie do GitHub minął.",
        "The time to sign in to GitHub has run out."),
    "backup.chat_cli_missing": (
        "На сервере ещё нет GitHub CLI. Нужно обновление установки.",
        "Na serwerze nie ma jeszcze GitHub CLI. Potrzebna jest aktualizacja instalacji.",
        "GitHub CLI is not on the server yet. The installation needs an update."),
    "backup.chat_login_unfinished": (
        "Вход в GitHub не завершён.", "Logowanie do GitHub nie zostało zakończone.",
        "The GitHub sign-in was not completed."),
    "backup.chat_public": (
        "Репозиторий публичный. Выбери Private в GitHub.", "Repozytorium jest publiczne. Wybierz Private w GitHub.",
        "The repository is public. Choose Private in GitHub."),
    "backup.chat_busy": (
        "Сейчас выполняется бекап. Попробуй после его завершения.", "Trwa właśnie backup. Spróbuj po jego zakończeniu.",
        "A backup is running now. Try again after it finishes."),
    "backup.chat_setup_failed": (
        "Не удалось завершить настройку. Проверь адрес приватного репозитория, права и срок действия токена.",
        "Nie udało się dokończyć konfiguracji. Sprawdź adres prywatnego repozytorium oraz uprawnienia i ważność tokena.",
        "The setup could not be completed. Check the private repository's address and the token's permissions and "
        "expiry."),
    "backup.chat_unfinished": (
        "Настройка не завершена.", "Konfiguracja nie została zakończona.", "The setup is not finished."),
    "backup.chat_continue": (
        "{reason} Напиши «хочу подключить бекап», чтобы продолжить.",
        "{reason} Napisz «chcę podłączyć backup», żeby kontynuować.",
        "{reason} Send «I want to connect backup» to continue."),
    "backup.chat_waiting_login": (
        "Жду подтверждения входа на странице GitHub.", "Czekam na potwierdzenie logowania na stronie GitHub.",
        "Waiting for the sign-in confirmation on the GitHub page."),
    "backup.chat_done": (
        "Готово: первая копия загружена и проверена. Дальше автобекап работает раз в сутки в 22:00 по лиссабонскому "
        "времени и хранит 14 последних копий в приватном репозитории. Ключи доступа к сервисам в копию не входят.",
        "Gotowe: pierwsza kopia przesłana i sprawdzona. Dalej automatyczny backup działa raz na dobę o 22:00 czasu "
        "lizbońskiego i przechowuje 14 ostatnich kopii w prywatnym repozytorium. Klucze dostępu do usług nie trafiają "
        "do kopii.",
        "Done: the first backup is uploaded and verified. From now on the automatic backup runs once a day at 22:00 "
        "Lisbon time and keeps the 14 latest backups in the private repository. Access keys to services are not part "
        "of the backup."),
    "backup.chat_unconfirmed": (
        "Первая копия не подтверждена. Настройки сохранены. Напиши «проверь бекап» — проверим состояние.",
        "Pierwsza kopia nie została potwierdzona. Ustawienia są zapisane. Napisz «sprawdź backup» — sprawdzimy stan.",
        "The first backup is not confirmed. The settings are saved. Send «check backup» and we'll check the state."),
    "backup.chat_token_deleted": (
        "Сообщение с токеном удалено. Настроить бекап может только владелец в своём личном чате.",
        "Wiadomość z tokenem została usunięta. Skonfigurować backup może tylko właściciel w swoim prywatnym czacie.",
        "The message with the token was deleted. Only the owner can set up the backup, in their private chat."),
    "backup.chat_token_not_deleted": (
        "Не удалось удалить сообщение с токеном. Удали его и отзови токен в GitHub. Токен не передан модели и не "
        "использован.",
        "Nie udało się usunąć wiadomości z tokenem. Usuń ją i unieważnij token w GitHub. Token nie trafił do modelu i "
        "nie został użyty.",
        "The message with the token could not be deleted. Delete it and revoke the token in GitHub. The token was not "
        "passed to the model and was not used."),
    "backup.chat_short": (
        "Пришли ссылку или токен отдельным коротким сообщением.", "Wyślij link albo token osobną krótką wiadomością.",
        "Send the link or the token as a separate short message."),
    "backup.chat_closed": (
        "Диалог настройки закрыт. Уже включённый автоматический бекап продолжает работать.",
        "Rozmowa o konfiguracji zamknięta. Włączony już automatyczny backup działa dalej.",
        "The setup dialog is closed. An automatic backup that is already on keeps running."),
    "backup.chat_token_kept": (
        "Не удалось удалить сообщение с токеном. Удали его и отзови этот токен в GitHub. Новый пришли после повторного "
        "подключения.",
        "Nie udało się usunąć wiadomości z tokenem. Usuń ją i unieważnij ten token w GitHub. Nowy wyślij po ponownym "
        "podłączeniu.",
        "The message with the token could not be deleted. Delete it and revoke this token in GitHub. Send a new one "
        "after connecting again."),
    "backup.chat_token_unused": (
        "Токен не использован, сообщение удалено. Сначала напиши «хочу подключить бекап» и пришли адрес приватного "
        "репозитория.",
        "Token nie został użyty, wiadomość usunięta. Najpierw napisz «chcę podłączyć backup» i wyślij adres prywatnego "
        "repozytorium.",
        "The token was not used and the message was deleted. First send «I want to connect backup», then the private "
        "repository's address."),
    "backup.chat_access_ok": (
        "Доступ проверен. Напиши «включи бекап», чтобы запустить первую копию и расписание.",
        "Dostęp sprawdzony. Napisz «włącz backup», żeby uruchomić pierwszą kopię i harmonogram.",
        "Access verified. Send «enable backup» to start the first backup and the schedule."),
    "backup.chat_save_key": (
        "Доступ к приватному репозиторию проверен. Сохрани этот файл ключа на своём компьютере или в менеджере паролей. "
        "Он нужен для восстановления после потери сервера. Потом напиши «ключ сохранён».",
        "Dostęp do prywatnego repozytorium sprawdzony. Zapisz ten plik klucza na swoim komputerze albo w menedżerze "
        "haseł. Jest potrzebny do odtworzenia po utracie serwera. Potem napisz «klucz zapisany».",
        "Access to the private repository verified. Save this key file on your computer or in a password manager. "
        "You'll need it to restore after losing the server. Then send «key saved»."),
    "backup.chat_wait_github": (
        "Жду подтверждения входа на странице GitHub. Чтобы закрыть настройку, напиши «отмени бекап».",
        "Czekam na potwierdzenie logowania na stronie GitHub. Aby zamknąć konfigurację, napisz «anuluj backup».",
        "Waiting for the sign-in confirmation on the GitHub page. To close the setup, send «cancel backup»."),
    "backup.chat_key_saved": (
        "Ключ сохранён. Запускаю первую копию и автоматический бекап. Сообщу результат после проверки загрузки.",
        "Klucz zapisany. Uruchamiam pierwszą kopię i automatyczny backup. Dam znać o wyniku po sprawdzeniu przesłania.",
        "Key saved. Starting the first backup and the automatic backup. I'll report the result once the upload is "
        "verified."),
    "backup.chat_save_key_again": (
        "Сохрани файл ключа отдельно от сервера и напиши «ключ сохранён». Повторно отправляю файл.",
        "Zapisz plik klucza osobno od serwera i napisz «klucz zapisany». Wysyłam plik ponownie.",
        "Save the key file separately from the server and send «key saved». I'm sending the file again."),
    "backup.chat_starting": (
        "Запускаю копию и автоматический бекап. Сообщу результат после проверки загрузки.",
        "Uruchamiam kopię i automatyczny backup. Dam znać o wyniku po sprawdzeniu przesłania.",
        "Starting the backup and the automatic backup. I'll report the result once the upload is verified."),
    "backup.chat_enable_or_cancel": (
        "Напиши «включи бекап» или «отмени бекап».", "Napisz «włącz backup» albo «anuluj backup».",
        "Send «enable backup» or «cancel backup»."),
    "backup.chat_not_enabled": (
        "Доступ и ключ сохранены, но автобекап ещё не включён. Напиши «повтори бекап», чтобы запустить копию и "
        "расписание.",
        "Dostęp i klucz są zapisane, ale automatyczny backup nie jest jeszcze włączony. Napisz «ponów backup», żeby "
        "uruchomić kopię i harmonogram.",
        "Access and key are saved, but the automatic backup is not on yet. Send «retry backup» to start the backup and "
        "the schedule."),
    "backup.chat_repeating": (
        "Повторяю создание и проверку копии.", "Ponawiam tworzenie i sprawdzanie kopii.",
        "Repeating the backup and its check."),
    "backup.chat_enabled_last": (
        "Автобекап включён. Последняя успешная копия: {date}.{tail}",
        "Automatyczny backup jest włączony. Ostatnia udana kopia: {date}.{tail}",
        "The automatic backup is on. Last successful backup: {date}.{tail}"),
    "backup.chat_last_failed": (
        " Последняя попытка завершилась ошибкой; предыдущая копия сохранена.",
        " Ostatnia próba zakończyła się błędem; poprzednia kopia jest zachowana.",
        " The last attempt ended with an error; the previous backup is kept."),
    "backup.chat_enabled_unconfirmed": (
        "Автобекап включён, но успешная первая копия ещё не подтверждена. Напиши «повтори бекап», чтобы повторить "
        "проверку.",
        "Automatyczny backup jest włączony, ale pierwsza udana kopia nie została jeszcze potwierdzona. Napisz «ponów "
        "backup», żeby powtórzyć sprawdzenie.",
        "The automatic backup is on, but a successful first backup is not confirmed yet. Send «retry backup» to repeat "
        "the check."),
    "backup.chat_github_login": (
        "Подключим GitHub. Сейчас пришлю ссылку и одноразовый код для входа. Если аккаунта ещё нет, сначала "
        "зарегистрируйся на https://github.com/signup. Дальше я сам создам приватный репозиторий и настрою копии.",
        "Podłączymy GitHub. Zaraz wyślę link i jednorazowy kod do logowania. Jeśli nie masz jeszcze konta, najpierw "
        "zarejestruj się na https://github.com/signup. Dalej sam utworzę prywatne repozytorium i skonfiguruję kopie.",
        "Let's connect GitHub. I'll send a link and a one-time sign-in code now. If you don't have an account yet, sign "
        "up first at https://github.com/signup. Then I'll create a private repository and set up the backups myself."),
    "backup.chat_manual": (
        "Подключим автоматический бекап. Если ещё нет GitHub — зарегистрируйся: https://github.com/signup\n\nОткрой "
        "https://github.com/new, назови репозиторий my-agent-backup, выбери Private и добавь README. Создай его и пришли "
        "сюда ссылку. Дальше подскажу, как дать доступ только к этому репозиторию. Терминал не нужен. Чтобы прервать "
        "диалог, напиши «отмени бекап».",
        "Podłączymy automatyczny backup. Jeśli nie masz jeszcze GitHub — zarejestruj się: https://github.com/signup\n\n"
        "Otwórz https://github.com/new, nazwij repozytorium my-agent-backup, wybierz Private i dodaj README. Utwórz je i "
        "wyślij tutaj link. Potem podpowiem, jak dać dostęp tylko do tego repozytorium. Terminal nie jest potrzebny. "
        "Aby przerwać rozmowę, napisz «anuluj backup».",
        "Let's connect the automatic backup. If you don't have GitHub yet, sign up: https://github.com/signup\n\nOpen "
        "https://github.com/new, name the repository my-agent-backup, choose Private and add a README. Create it and "
        "send the link here. Then I'll show how to give access to this repository only. No terminal needed. To stop "
        "the dialog, send «cancel backup»."),
    "backup.chat_token_guide": (
        "Теперь создай токен доступа: {url}\n\nRepository access → Only select repositories → выбери только {repo}.\n"
        "Permissions → Contents: Read and write. Другие права не нужны. Нажми Generate token, скопируй его и пришли сюда "
        "отдельным текстовым сообщением.\n\nОбработчик удалит это сообщение и сохранит токен отдельно от переписки и "
        "бекапа. Не присылай пароль GitHub. Токен будет действовать 90 дней; после окончания срока его нужно обновить.",
        "Teraz utwórz token dostępu: {url}\n\nRepository access → Only select repositories → wybierz tylko {repo}.\n"
        "Permissions → Contents: Read and write. Inne uprawnienia nie są potrzebne. Kliknij Generate token, skopiuj go "
        "i wyślij tutaj osobną wiadomością tekstową.\n\nObsługa usunie tę wiadomość i zapisze token osobno od rozmowy i "
        "backupu. Nie wysyłaj hasła do GitHub. Token będzie ważny 90 dni; po tym czasie trzeba go odnowić.",
        "Now create an access token: {url}\n\nRepository access → Only select repositories → choose only {repo}.\n"
        "Permissions → Contents: Read and write. No other permissions are needed. Click Generate token, copy it and send "
        "it here as a separate text message.\n\nThe handler will delete that message and keep the token apart from the "
        "chat and the backup. Don't send your GitHub password. The token is valid for 90 days; after that it has to be "
        "renewed."),
    "backup.chat_device_code": (
        "Открой https://github.com/login/device и введи код {code}. Войди в свой GitHub и подтверди доступ GitHub CLI. "
        "Пароль или токен сюда присылать не нужно. После входа я сам создам приватный репозиторий.",
        "Otwórz https://github.com/login/device i wpisz kod {code}. Zaloguj się do swojego GitHub i potwierdź dostęp "
        "GitHub CLI. Hasła ani tokena nie trzeba tu wysyłać. Po zalogowaniu sam utworzę prywatne repozytorium.",
        "Open https://github.com/login/device and enter the code {code}. Sign in to your GitHub and confirm GitHub CLI "
        "access. No need to send a password or token here. After you sign in I'll create the private repository "
        "myself."),
    "backup.chat_github_ready": (
        "GitHub подключён. Приватный репозиторий: https://github.com/{repo}. Запускаю автоматический бекап.",
        "GitHub podłączony. Prywatne repozytorium: https://github.com/{repo}. Uruchamiam automatyczny backup.",
        "GitHub connected. Private repository: https://github.com/{repo}. Starting the automatic backup."),
    "backup.chat_github_key": (
        "GitHub подключён. Приватный репозиторий: https://github.com/{repo}. Сохрани файл ключа восстановления отдельно "
        "от сервера и напиши «ключ сохранён».",
        "GitHub podłączony. Prywatne repozytorium: https://github.com/{repo}. Zapisz plik klucza odtwarzania osobno od "
        "serwera i napisz «klucz zapisany».",
        "GitHub connected. Private repository: https://github.com/{repo}. Save the recovery key file separately from "
        "the server and send «key saved»."),
    # Product owner, 13.11.2026: tg-answer-check hands a reply back to the agent in the owner's language.
    "answer.done": (
        "Проверка ответа, один раз на запрос: ответ ещё не отправлен. Ты пишешь, что сделано ({found}), но с момента "
        "запроса и за 10 минут до него ты ничего не делал и не проверял. Запрос от: {who}. Проверь саму вещь (файл, "
        "задачу, страницу, архив чата) и напиши, что видишь; если это было раньше — напиши когда. Потом отправь ответ "
        "ещё раз.",
        "Kontrola odpowiedzi, raz na prośbę: odpowiedź nie została jeszcze wysłana. Piszesz, że coś zostało zrobione "
        "({found}), ale od prośby i przez 10 minut przed nią niczego nie robiłeś ani nie sprawdzałeś. Prośba od: {who}. "
        "Sprawdź samą rzecz (plik, zadanie, stronę, archiwum czatu) i napisz, co widzisz; jeśli to było wcześniej, napisz "
        "kiedy. Potem wyślij odpowiedź ponownie.",
        "Answer check, once per request: the reply has not been sent yet. It says something is done ({found}), but "
        "since the request, and in the 10 minutes before it, you did and checked nothing. Request from: {who}. Check "
        "the thing itself (the file, the task, the page, the chat archive) and say what you see; if it happened "
        "earlier, say when. Then send the reply again."),
    "answer.launch": (
        "Проверка ответа, один раз на запрос: ответ ещё не отправлен. Ты пишешь: «{sentence}». В этом ходе ты запустил "
        "{what}, но после запуска ничем не проверил, что оно работает. Запрос от: {who}. Посмотри процесс (ps, pgrep), "
        "первые строки его журнала или вывода, задачу в списке (reminder-task status) или файл, который оно должно дать, "
        "и напиши увиденный факт. Проверить нечем — так и напиши: «не проверял». Потом отправь ответ ещё раз.",
        "Kontrola odpowiedzi, raz na prośbę: odpowiedź nie została jeszcze wysłana. Piszesz: «{sentence}». W tej turze "
        "uruchomiłeś {what}, ale po uruchomieniu niczym nie sprawdziłeś, że to działa. Prośba od: {who}. Sprawdź proces "
        "(ps, pgrep), pierwsze wiersze jego dziennika lub wyjścia, zadanie na liście (reminder-task status) albo plik, "
        "który ma powstać, i napisz, co zobaczyłeś. Jeśli nie ma czym sprawdzić, napisz wprost: «nie sprawdzałem». Potem "
        "wyślij odpowiedź ponownie.",
        "Answer check, once per request: the reply has not been sent yet. It says: «{sentence}». In this turn you "
        "started {what}, but after the start nothing checked that it works. Request from: {who}. Look at the process "
        "(ps, pgrep), the first lines of its log or output, the task in the list (reminder-task status) or the file it "
        "should produce, and write the fact you saw. If there is nothing to check it with, say so: «not checked». Then "
        "send the reply again."),
    "answer.cant": (
        "Проверка ответа, один раз на запрос: ответ ещё не отправлен. Ты пишешь, что не можешь: «{sentence}». С момента "
        "запроса ты ничего не пробовал. Запрос от: {who}. Попробуй своими средствами: свои программы (~/bin), браузер, "
        "свои навыки. Потом напиши, что именно не вышло (что показал сайт или программа) и что нужно от человека. Если "
        "отказа требует правило или охранник — отправь ответ ещё раз как есть.",
        "Kontrola odpowiedzi, raz na prośbę: odpowiedź nie została jeszcze wysłana. Piszesz, że nie możesz: "
        "«{sentence}». Od prośby niczego nie próbowałeś. Prośba od: {who}. Spróbuj własnymi środkami: swoimi programami "
        "(~/bin), przeglądarką, swoimi umiejętnościami. Potem napisz, co dokładnie nie wyszło (co pokazała strona albo "
        "program) i czego potrzeba od człowieka. Jeśli odmowy wymaga reguła albo strażnik, wyślij odpowiedź ponownie bez "
        "zmian.",
        "Answer check, once per request: the reply has not been sent yet. It says you can't: «{sentence}». Since the "
        "request you have tried nothing. Request from: {who}. Try with your own means: your programs (~/bin), the "
        "browser, your skills. Then say what exactly did not work (what the site or the program showed) and what is "
        "needed from the person. If a rule or a guard requires the refusal, send the reply again as it is."),
    "answer.giveup": (
        "Проверка ответа, один раз на запрос: ответ ещё не отправлен. Ты пишешь: «{sentence}». Одна неудачная попытка — "
        "это ещё не «не могу». Посмотри, почему не вышло (что именно вернул инструмент), и попробуй починить сам: "
        "переподключить, настроить, взять другую свою программу или другой путь (браузер, навык, помощника). Потом сделай "
        "то, что просили, и коротко напиши, что было не так и что теперь работает. Если без человека правда никак — "
        "назови один шаг, который нужен от него, и что ты уже проверил сам. Запрос от: {who}. Если отказа требует "
        "правило или охранник — отправь ответ ещё раз как есть.",
        "Kontrola odpowiedzi, raz na prośbę: odpowiedź nie została jeszcze wysłana. Piszesz: «{sentence}». Jedna "
        "nieudana próba to jeszcze nie «nie mogę». Zobacz, dlaczego nie wyszło (co dokładnie zwróciło narzędzie), i "
        "spróbuj naprawić to sam: podłączyć ponownie, skonfigurować, użyć innego swojego programu albo innej drogi "
        "(przeglądarki, umiejętności, pomocnika). Potem zrób to, o co proszono, i krótko napisz, co było nie tak i co "
        "teraz działa. Jeśli bez człowieka naprawdę się nie da, nazwij jeden krok, którego od niego potrzeba, i co już "
        "sam sprawdziłeś. Prośba od: {who}. Jeśli odmowy wymaga reguła albo strażnik, wyślij odpowiedź ponownie bez "
        "zmian.",
        "Answer check, once per request: the reply has not been sent yet. It says: «{sentence}». One failed try is not "
        "yet «I can't». Look at why it failed (what exactly the tool returned) and try to fix it yourself: reconnect, "
        "configure, take another program of yours or another way (the browser, a skill, a helper). Then do what was "
        "asked and say briefly what was wrong and what works now. If it truly cannot be done without the person, name "
        "the one step needed from them and what you have already checked yourself. Request from: {who}. If a rule or a "
        "guard requires the refusal, send the reply again as it is."),
    "answer.pushback": (
        "Проверка ответа, один раз на запрос: ответ ещё не отправлен. Ты возвращаешь работу человеку: «{sentence}» — и "
        "ничего не проверил и не дал точного шага. Запрос от: {who}. Отказ, которого требует правило, оставь как есть. А "
        "для того, что нужно человеку: посмотри, какие пути подключения у тебя есть (свой навык или программа "
        "подключения этого сервиса, состояние подключения), и либо подключи сам, либо дай один точный шаг — ссылку или "
        "команду, которую ты сейчас получил, и что будет после него. Потом отправь ответ ещё раз.",
        "Kontrola odpowiedzi, raz na prośbę: odpowiedź nie została jeszcze wysłana. Oddajesz pracę człowiekowi: "
        "«{sentence}» — niczego nie sprawdziłeś i nie podałeś dokładnego kroku. Prośba od: {who}. Odmowę, której wymaga "
        "reguła, zostaw bez zmian. A w tym, czego potrzebuje człowiek: sprawdź, jakie masz drogi podłączenia (swoją "
        "umiejętność albo program do podłączenia tej usługi, stan połączenia), i albo podłącz sam, albo podaj jeden "
        "dokładny krok — link albo polecenie, które właśnie otrzymałeś, i co będzie po nim. Potem wyślij odpowiedź "
        "ponownie.",
        "Answer check, once per request: the reply has not been sent yet. You hand the work back to the person: "
        "«{sentence}» — with nothing checked and no exact step. Request from: {who}. A refusal a rule requires stays as "
        "it is. For what the person needs: look at the ways to connect you have (your skill or program that connects "
        "this service, the connection's state), and either connect it yourself or give one exact step — the link or "
        "command you just got, and what happens after it. Then send the reply again."),
    "answer.lock": (
        "Ответ не отправлен: пока ты его готовил, от этого же человека в этот чат пришло новое (ниже целиком, по "
        "порядку). Прочитай, учти и отправь ответ заново. Эти сообщения придут тебе ещё раз отдельным запросом; если "
        "новый ответ их уже покрывает, закрой тот запрос одной короткой строкой.",
        "Odpowiedź nie została wysłana: kiedy ją przygotowywałeś, od tej samej osoby przyszło na ten czat coś nowego "
        "(poniżej w całości, po kolei). Przeczytaj, uwzględnij i wyślij odpowiedź od nowa. Te wiadomości przyjdą do "
        "ciebie jeszcze raz jako osobna prośba; jeśli nowa odpowiedź już je obejmuje, zamknij tamtą prośbę jednym krótkim "
        "wierszem.",
        "The reply was not sent: while you were preparing it, the same person sent something new to this chat (below, "
        "whole, in order). Read it, take it into account and send the reply anew. These messages will come to you again "
        "as a separate request; if the new reply already covers them, close that request with one short line."),
    "answer.who.owner": ("владелец", "właściciel", "the owner"),
    "answer.who.other": ("другой человек в этом чате, не владелец", "inna osoba w tym czacie, nie właściciel",
                         "another person in this chat, not the owner"),
    "answer.who.unknown": ("не определено", "nie ustalono", "not determined"),
}
for _key, (_ru, _pl, _en) in _LATER_NOTICES.items():
    RUSSIAN_NOTICES[_key], POLISH_NOTICES[_key], ENGLISH_NOTICES[_key] = _ru, _pl, _en
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


if __name__ == "__main__":
    # For a caller in another language (telegram-backup-chat.ts): `agent_notice_locale.py HOME KEY UKRAINIAN`
    # prints the copy in that agent's notice language, the Ukrainian one when it has none.
    import sys
    if len(sys.argv) == 4:
        print(notice_text(sys.argv[2], sys.argv[3], home=Path(sys.argv[1])), end="")
