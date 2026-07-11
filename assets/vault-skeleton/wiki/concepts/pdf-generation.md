---
type: concept
title: "PDF-генерація (КП, звіти, інвойси)"
updated: 2026-07-05
tags:
  - pdf
  - html
  - infra
status: evergreen
---

# PDF-генерація — детальний гайд

Деталі до правила з `CLAUDE.md`: «PDF/КП/звіти: HTML → `~/bin/html-to-pdf` → відправити через reply.files».

## Коли треба

владелец просить: «зроби КП для клієнта X на $10k», «напиши звіт у PDF», «інвойс».

## Розрізняй одразу: клієнтський чи ні

**Wrapper `html-to-pdf` додає date+`file:///` штамп у footer.** Для клієнтських документів це неприпустимо. Тому спочатку визнач тип:

### Неклієнтські PDF (внутрішні звіти, drafts, вольт-експорти)

1. Написати HTML у `/tmp/<name>.html`.
2. `~/bin/html-to-pdf /tmp/<name>.html /tmp/<name>.pdf` — норм, footer не критичний.
3. Відправити через `reply files:["/tmp/<name>.pdf"]`.

### Клієнтські PDF (КП, інвойс, контракт, публічна пропозиція)

1. HTML у `/tmp/<name>.html`.
2. НЕ використовувати `html-to-pdf` wrapper — він додасть штамп.
3. Запустити Chrome вручну:
   ```
   google-chrome --headless --disable-gpu --no-pdf-header-footer \
     --print-to-pdf=/tmp/<name>.pdf file:///tmp/<name>.html
   ```
   Ключовий флаг: `--no-pdf-header-footer`.
4. Відправити через `reply files:["/tmp/<name>.pdf"]`.

Cleanup `/tmp/*.html` і `/tmp/*.pdf` якщо не потрібні далі.

## CSS-стек для обох варіантів

Розглянути skill `frontend-design` для стильових ідей. Для карток статистики — `apple-bento-grid`.

## CSS-поради для КП (комерційні пропозиції)

- A4 page: `@page { size: A4; margin: 20mm; }`
- Hero section з назвою компанії + logo placeholder.
- Чіткі секції: Задача, Рішення, Ціна, Терміни, Команда.
- `-webkit-print-color-adjust: exact` — зберігає background-и.
- Sans-serif сучасні шрифти: Inter, SF Pro, або system-ui.
- Розрив між секціями: `page-break-after: always` де треба.

## Що НЕ робити

- Слайди/презентації в PDF → використовуй skill `pptx` для цього.

## Історія

- Додано в CLAUDE.md ~2026-04.
- Винесено з CLAUDE.md у vault 2026-07-05.
