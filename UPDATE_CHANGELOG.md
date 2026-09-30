# Оновлення Novsky Starter

- Реліз: `2026-09-30.5ebe8232a381`
- Продукт: `starter` — Novsky Starter
- Ревізія вихідного комплекту: `5ebe8232a3814ae7328dfa0879bac545af7bc9a4`
- Дата релізу: `2026-09-30`
- Режим оновлення: `reconcile-existing`; пакет дозволено застосовувати лише до
  того самого `productId`.

Цільовий стан визначає авторитетний маніфест продукту `starter`. Машинний опис цільового продукту міститься у
`PRODUCT.json`; `assets/product/runtime.json`,
`assets/product/managed-skills.json`, `assets/product/managed-plugins.json`
та `assets/product/managed-runtime.json` деталізують керовані складові. Не
визначай склад продукту за рекламним текстом або старими файлами інсталяції.

## Що змінилось у цьому релізі

Дослівна історія ревізій вихідного комплекту —
не перелік можливостей цього продукту. Заголовки можуть стосуватися інших
продуктів; точний склад цього пакета наведено нижче.

    An account switch ends the old account's limit hold; the same or an unknown account keeps it (task 48)
    Add failing checks that an account switch ends the old account's limit hold, and only a distinct account counts (task 48)
    Tests: an unknown bookkeeping attachment is judged the same with a cosmetic duplicate (v10 rule)
    Receiver: a request's own legacy obligation still waits for exact proof
    Tests: the canary's stalled user now ends delivered with its explanation
    Company runtime: the blocked alert's footer drops the uncertain_action rerun sentence
    Owner 29.09 (Codex, task 49 round 2 P2): the blocked alert no longer promises an unknown-result rerun (red)
    Tests: the fake curl may take longer than 2 s to start on a loaded Mac
    Stop guard: a person's local media by any media word, not two labels
    Owner 29.09 (Codex, task 47 v9 P0): a person's local media stops the search by any media word (red)
    Receiver: under guard and shadow a legacy worker moves to the request that registered it
    Owner 29.09 (Codex, task 46 round 3 P0): a worker rebuilt from history answers the request that took it (red)
    Company runtime: an unknown result is told in one commit through the durable reply path
    Owner 29.09 (Codex, task 49 round 2): an unknown result's explanation survives refusals, crashes and restarts (red)
    Receiver: under guard and shadow a reused worker moves to the request that registered it
    Owner 29.09 (Codex, task 46 round 2 P0): a reused worker's callback answers the request that took it (red)
    Stop guard: unknown bookkeeping continues the turn; task notices by kind; silence needs terminal proof
    Owner 29.09: the Stop guard reads Claude's records by kind, never by exact wording (red)
    Company runtime: only a result nobody knows is told and closed; other repeated failures keep their check
    Company runtime: an unknown action result ends the request with the truth told, never a rerun or a hold
    Owner 29.09: an unknown action result is told to its author at once and nothing waits for /unstick (red)
    Receiver golden for the receiver-only worker refusals and hang cap
    Receipt machinery refuses worker IDs only under the receiver; the three-hang cap is the receiver's policy
    Codex task 46 P0-1/P0-2: under guard and shadow a reused worker ID still defers its request, and a request that hangs a third time is recovered as before K (red)
    Receiver golden for the shadow-parity fix
    Shadow changes nothing live: an upgraded session keeps its background work under guard and shadow, and the «Отримано, зараз закінчую…» notice is gone (owner, 29.09)
    Owner 29.09: a message waiting behind long work gets no «Отримано, зараз закінчую…» notice (red)
    Knopa 29.09: a session resumed across the upgrade must keep handing work to its background task under guard and shadow (red)
    A second, different image in one employee request no longer holds the employee's chat: the bot says the next image comes with a new message
    Add failing checks that a second, different image in one employee request is refused as a proven no-write, so it never holds the employee's chat
    The alert about refused Claude Code access names both causes: the subscription, or a company administrator who switched access off
    Add failing checks that the alert about refused Claude Code access names both the subscription and the company administrator
    Owner alerts say in plain words what happened, what to do and where to look; the provider's own error text stays in the log
    Add failing checks that owner alerts about a refused request say in plain words what happened and what to do
    Gate checks follow the assembled receiver: a live lock stays fresh under load, a request in a topic names the bot, an offered message keeps its turn after a restart, and the reply harness knows the worker gates
    Reliability and settlement checks follow the assembled receiver: the edit reader, the configurable offer retry, the named video, the repeated-acknowledgement stub and the owner's limit line
    Company intake checks follow the receiver: a video reaches the worker named, and an unrecognized voice is refused to its author
    A frozen server refuses a standalone Codex install before its license, packages or bootstrap
    Add a failing check that a frozen server refuses a standalone Codex install before its license, packages or bootstrap
    Pin the receiver that keeps an owner's group off on promotion; history comments without trailing spaces

Перелік складено з комітів комплекту між попереднім релізом і цим. Ревізію для
`git` беріть із поля «Ревізія вихідного комплекту» вище: мітка релізу — це не
git-об'єкт, і `git cat-file` на неї не спрацює.

Це історія спільного репозиторію: коміти можуть згадувати інші продукти або
вилучені навички. Точний склад цього пакета наведено нижче.

## Точний склад продукту

### Вбудовані навички

- `backup-recovery`
- `research`

### Зовнішні навички

- немає

### Функції

- `browser`

Перелік вище згенеровано безпосередньо з маніфесту цього продукту. Не додавай
навички або функції, яких немає у цих списках.

## Що покращено

1. Надійність відповідей у Telegram та Stop guard: коректніше завершується
   поточна робота, а зупинка не породжує прихований другий процес.
2. Точне й обмежене відновлення після підтвердженого ліміту сесії; повтори та
   рестарти мають жорстку межу й не маскують інший клас помилки.
3. Команди `/fix` і `/unstick` дають власнику безпечний діагностичний шлях
   для завислої або перерваної сесії.
4. Пам’ять поєднує семантичний пошук і пошук за ключовими словами, не
   замінюючи джерело пам’яті новою порожньою базою.
5. Нагадування та послідовності зберігаються довговічно й відновлюються після
   штатного рестарту.
6. Запланований worker детерміновано фільтрує та виконує заплановані завдання,
   не запускаючи другий блокуючий процес Claude.
7. Посилено transport, history, стан очікування і захист від дубльованої доставки
   повідомлень.

Це оновлення **не** виправляє автоматично помилки billing, auth або overload і
не дозволяє сліпу перевстановку чи overlay поверх живого дерева. Для цих станів
потрібна явна діагностика, а не цикл рестартів.

## ЗБЕРЕГТИ

Під час узгодження зберігай без перезапису:

- Novsky Vault, пам’ять, `USER.md`, цілі й інші дані власника у
  `/home/claude/obsidian-vault/`;
- створений власником текст у `CLAUDE.md`;
- `/etc/claude-tg-starter/agent.env`;
- Telegram env, секрети, правила доступу, групи, адміністраторів та інші
  налаштування каналу власника;
- власні skills, plugins, hooks і permissions власника поза керованим каталогом
  цього manifest;
- некеровані записи cron.

Ніколи не розкривай секрети в журналах, diff, звітах або чаті. Збереження не
означає сліпо копіювати все назад: до застосування будь-якої зміни класифікуй
кожен шлях як керований власником або manifest.

## КЕРОВАНЕ / УЗГОДЖЕННЯ

Узгоджуй із цільовим станом цього пакета лише kit binaries, product
persona/policy, керовані manifest skills, plugins, runtime, hooks, cron entries
і golden Telegram runtime. Джерела правди — `PRODUCT.json` та перелічені вище
керовані JSON projections.

Звичайне оновлення зберігає встановлені Claude/Codex CLI та кеш плагінів.
Перед першою мутацією `update.sh` вимагає байтової тотожності встановленої й
нової managed-plugin policy та plugin contract, незмінності зафіксованого
upstream Telegram і успішної локальної перевірки наявних плагінів. Перевірений
golden Telegram може оновитися без заміни плагіна чи його marketplace.
Воно не оновлює marketplace чи plugin через CLI. Зміна цих контрактів потребує
окремої перевіреної міграції зі знімком і відкатом, а не звичайного `update.sh`.

Запланований worker повинен використовувати детерміноване виконання та
фільтрування scheduled-worker і не запускати другий блокуючий процес Claude.

Будь-яка власна зміна в керованому шляху або під керованою назвою потребує
явного diff/merge. Якщо безпечне злиття не можна довести, це жорстка зупинка:
нічого не перезаписуй і надай власникові короткий очищений diff для ручної
перевірки.

## КАНОНІЧНА ТОПОЛОГІЯ

Автоматичне узгодження дозволено лише для одного канонічного instance:

- HOME агента — `/home/claude`;
- збережений env — `/etc/claude-tg-starter/agent.env`;
- служба — `claude-telegram.service` зі стандартним користувачем і transport;
- існує рівно один стандартний Bun poller без другого процесу Claude або poller.

Визначай поточний `productId` за встановленими/runtime metadata. Відсутній
legacy `/opt/claude-tg-starter/PRODUCT.json` сам по собі не є збоєм, якщо
узгоджені `/home/claude/.claude/product/runtime.json` або
`/opt/claude-tg-starter/assets/product/runtime.json` однозначно підтверджують
ідентичність.

## ЖОРСТКІ ЗУПИНКИ

Зупинися **до будь-якої зміни**, якщо виконується хоча б одна умова:

- поточний `productId` відрізняється від `starter` або джерела
  metadata суперечать одне одному;
- HOME спільний, топологія містить кілька instances або service/user/transport
  нестандартні;
- дерево комплекту брудне, стороннє або є символьним посиланням;
- збережений env, SSH або перевірена резервна копія недоступні;
- існує другий процес poller/Claude або немає рівно одного стандартного Bun
  poller;
- власні правки перетинають керований шлях чи назву, а безпечне злиття не
  доведено;
- plugin policy/contract або зафіксоване джерело Telegram не збігаються з установленими
  або локальна перевірка встановлених плагінів не пройшла;
- архів неповний, пошкоджений, підмінений або не проходить перевірку цілісності.

Жорстка зупинка означає: не запускай installer/update, не зупиняй службу й не
торкайся живого дерева. Поверни лише очищене пояснення без секретів.

## БЕЗПЕЧНА ПОСЛІДОВНІСТЬ ОНОВЛЕННЯ

1. Виконай повністю read-only preflight для identity, topology, ownership,
   symlinks, git state, processes, service/drop-ins, transport, managed drift,
   free space та package integrity.
2. Створи й перевір `agent-backup` без секретів. Окремо створи точний
   root-only snapshot живого комплекту, config, systemd unit/drop-ins, cron і
   managed runtime state. Цей snapshot може містити чутливі дані, тому ніколи
   не надсилай його в чат або звичайні журнали.
3. Установи чинне блокування перезапуску, а потім зупини службу. Не утримуй lifecycle
   lock під час оновлення.
4. Розпакуй свіжий архів поза живим шляхом, перевір його й окремо підготуй нове
   дерево. Overlay заборонено. Атомарно поміняй каталоги місцями, зберігши
   старий kit для rollback.
5. Запусти цільову команду
   `CLAUDE_UPDATE_MAINTENANCE=1 bash update.sh` із нового комплекту. Вона має
   використовувати перевірену staged revision без живої Git authentication або
   pull, узгоджувати лише manifest-managed state і нічого не змінювати у
   ЗБЕРЕГТИ.

## ПЕРЕВІРКА

Кожна перевірка після оновлення обов’язкова:

- `PRODUCT.json` та встановлені/runtime metadata підтверджують product/release;
- product, skill і memory doctors працюють успішно, а
  `onboarding-status --strict` завершується успішно;
- працює рівно один стандартний Bun poller і немає другого процесу Claude;
- журнали не містять Telegram `409` або concurrent polling;
- один реальний запит у Telegram отримує рівно одну коректну відповідь;
- збережені memory, USER, goals, secrets/access/groups/admins і власний стан
  власника лишилися неушкодженими.

Фінальний очищений звіт може містити лише категорії `installed`, `preserved`,
`skipped` і `manual-review` та результати перевірок. Ніколи не додавай
секрети або повний вміст environment.

## ВІДКАТ

Якщо будь-яка перевірка не пройшла, не продовжуй із частковим станом. Зупини
новий runtime, атомарно поверни старий kit, віднови точні
config/runtime/systemd/drop-ins/cron state з root-only snapshot, видали блокування
перезапуску, запусти одну канонічну службу й повтори перевірку реальної відповіді в
Telegram. Не видаляй старий kit або snapshot, доки ця відповідь не буде
успішною.
