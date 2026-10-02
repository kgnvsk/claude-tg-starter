#!/usr/bin/env python3
"""Opt-in Russian for kit-owned notices; existing agents keep Ukrainian copy.

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
        "Не знаю, дошло ли сообщение о фоновой задаче запроса {requests}, которая молчала: "
        "процесс прервался или Telegram не подтвердил отправку. Она больше не задерживает другие сообщения."
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
    "secretary.limit": "⚠️ Секретарь не может писать ответы: исчерпан лимит Claude.",
    "secretary.login": "⚠️ Секретарь не может писать ответы: Claude не принимает вход.",
    "secretary.forward": "📩 {channel} · {name}: «{text}»\nОтвет не подготовлен.",
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
    return found[0] if len(found) == 1 and found[0] in {"uk", "ru"} else "uk"


MONTHS = {
    "uk": ("січня", "лютого", "березня", "квітня", "травня", "червня", "липня", "серпня", "вересня",
           "жовтня", "листопада", "грудня"),
    "ru": ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
           "октября", "ноября", "декабря"),
}


def agent_time_zone(home: Path) -> str:
    """TIMEZONE from the agent's live profile, or UTC."""
    try:
        lines = (home / ".agent-profile.env").read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        return "UTC"
    found = [line.partition("=")[2].strip().strip("'\"") for line in lines if line.startswith("TIMEZONE=")]
    if len(found) != 1:
        return "UTC"
    try:
        from zoneinfo import ZoneInfo
        ZoneInfo(found[0])
    except (ValueError, KeyError, OSError):
        return "UTC"
    return found[0]


def accepted_line(home: Path, reset_epoch_ms: int | None, now_ms: int) -> str:
    """The owner's line (27.09), the same as the receiver's and the corporate runtime's."""
    russian = owner_notice_locale(home) == "ru"
    if not reset_epoch_ms:
        return "Принял, отвечу чуть позже" if russian else "Прийняв, відповім трохи згодом"
    from datetime import datetime
    from zoneinfo import ZoneInfo
    zone = agent_time_zone(home)
    at = datetime.fromtimestamp(reset_epoch_ms / 1000, ZoneInfo(zone))
    today = datetime.fromtimestamp(now_ms / 1000, ZoneInfo(zone)).date()
    day = "" if at.date() == today else f" {at.day} {MONTHS['ru' if russian else 'uk'][at.month - 1]}"
    if zone in ("Europe/Kyiv", "Europe/Kiev"):
        where = "по киевскому времени" if russian else "за київським часом"
    else:
        where = f"({zone})"
    return f"{'Принял, отвечу после' if russian else 'Прийняв, відповім після'} {at:%H:%M}{day} {where}"


def notice_text(key: str, ukrainian: str, *, home: Path) -> str:
    if owner_notice_locale(home) == "ru":
        return RUSSIAN_NOTICES.get(key, ukrainian)
    return ukrainian
