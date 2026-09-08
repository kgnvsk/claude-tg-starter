# Розгортання Novsky Starter

Цей репозиторій є повним приватним дистрибутивом `Novsky Starter`.
Джерело його оновлень — `https://github.com/kgnvsk/claude-tg-starter.git`.

## Перед встановленням

Використовуй VPS з Ubuntu 24.04 і root-доступом. Підготуй токен Telegram-бота,
Telegram ID власника, часовий пояс та ім’я агента. Для входу в
Claude використовуються окремі браузерні процеси авторизації;
ніколи не проси власника надати паролі від акаунтів.

Novsky Starter безкоштовний: ключ покупки не потрібен, інсталятор
не звертається до сервісу активації.

## Встановлення

1. Клонуй цей репозиторій до `/opt/claude-tg-starter`. Для приватного
   GitHub-репозиторію використовуй `scripts/clone-product.sh` із файлом
   repository-scoped read-only token.
2. Запусти `bash onboard.sh` від root і проходь по одному етапу початкового
   налаштування за раз. Скрипт підготує системні пакети та Node runtime, а потім
   встановить ядро агента; не готуй сервер вручну.

Після `onboard.sh` агент уже існує, але ще не обслуговує запити. Виконай
наступні кроки по черзі — кожен із них обов’язковий для
`onboarding-status --strict`.

3. **Вхід власника.** Команда
   `runuser -l claude -c '~/bin/claude-login'` виводить OAuth URL. Власник
   відкриває його, входить зі своєю підпискою та повертає код; заверши командою
   `runuser -l claude -c '~/bin/claude-login <code>'`. Перевір:
   `runuser -l claude -c 'claude auth status'` повідомляє
   `"loggedIn": true`.

4. **Telegram plugin 0.0.7 і виправлений poller.** Спочатку встановлюється
   upstream plugin, а потім provenance-aware reconciler накладає golden copy з
   комплекту. Він дозволяє лише exact official 0.0.7 або вже перевірений golden;
   невідома чи майбутня версія зупиняє установлення без запису:
   ```bash
   runuser -l claude -c '~/.local/bin/claude plugin marketplace add anthropics/claude-plugins-official'
   runuser -l claude -c '~/.local/bin/claude plugin install telegram@claude-plugins-official'
   runuser -l claude -c '~/bin/reconcile-telegram-plugin --apply'
   ```
   Синхронізація marketplace може відновити exact official `server.ts`;
   healthcheck повертає golden лише через той самий reconciler. Не копіюй patch
   вручну й не перенось його на `0.0.8+` без нового three-way review.

5. **Skill plugins.** `runuser -l claude -c '~/bin/install-plugins'`.

6. **Ізольований браузер.** Запусти `bash scripts/install-browser.sh`, після
   чого `runuser -u claude -- /home/claude/bin/browser-doctor` має завершитися
   повністю успішно.

7. **Початок обслуговування.** Виконай
   `systemctl daemon-reload && systemctl enable --now claude-telegram`.
   Перевір, що власник отримує відповідь у Telegram, а
   `/home/claude/logs/claude-screen.log` містить `polling as @<botname>`.

8. За потреби посиль захист сервера командою
   `bash scripts/harden-server.sh`, а потім запусти
   `~/bin/onboarding-status --strict` і виконай обмежену першу перевірку з
   `ONBOARDING.md`.

Технічні збої опрацьовує інсталятор. Новачка-власника слід просити лише про
короткі браузерні авторизації або продуктові рішення, які не можна
автоматизувати.
