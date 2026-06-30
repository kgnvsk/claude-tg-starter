---
name: codex-imagegen
description: Generate images via Codex CLI with model gpt-image-2. Use ALWAYS when user asks for any image generation — photos, illustrations, icons, avatars, posters, ad creatives, mockups, anything visual. Triggers on "generate image", "create picture", "make photo", "сгенерируй картинку", "создай изображение", "нарисуй", "fake portrait", or when other code needs to produce an image file.
---

# Image Generation via Codex CLI

У Anthropic нет image-API. Картинки — только OpenAI Codex CLI с моделью `gpt-image-2`.

## ЖЕЛЕЗНО: промпт — в ФАЙЛ, команда — КОРОТКАЯ (иначе срыв формата tool_use)

НИКОГДА не пиши большой промпт инлайном в `codex exec "<огромный промпт>"`. Длинный аргумент с кавычками срывает сериализацию tool_use на Opus 4.8 → вызов уходит ТЕКСТОМ → не выполняется → бот молчит. Это уже клало Кеша. Поэтому — ВСЕГДА в два шага:

1. `Write` полный промпт в `/tmp/imgprompt.txt` (внутри текста промпта упомяни model gpt-image-2 + явный абсолютный путь сохранения).
2. Запусти codex, читая промпт ИЗ файла — команда остаётся короткой:

```bash
~/.npm-global/bin/codex exec --skip-git-repo-check --sandbox danger-full-access -m gpt-5.5 "$(cat /tmp/imgprompt.txt)"
```

`$(cat ...)` подставляет текст в рантайме — в самом tool-вызове большого текста НЕТ, срываться нечему. Codex генерит картинку и сохраняет по указанному в промпте пути.

## CRITICAL: бинарь — /home/claude/.npm-global/bin/codex (не /usr/bin/codex)
`/usr/bin/codex` застрял на 0.120.0 (нет gpt-5.5). npm-версия `~/.npm-global/bin/codex` (0.133+, сейчас 0.142) работает. Всегда полный путь.

## CRITICAL: --skip-git-repo-check ОБЯЗАТЕЛЕН (codex 0.142+)
Новый codex (0.142+) при запуске вне git-repo / в недоверенной папке падает: «Not inside a trusted directory and --skip-git-repo-check was not specified». Trust-конфиг `[projects."/tmp"]` в новой версии это уже НЕ лечит (в 0.133 у Кэша работал запуск из вольта-git-repo; в 0.142 надёжнее флаг). Фикс — флаг **`--skip-git-repo-check` СРАЗУ после `exec`** (перед `--sandbox`). С ним codex генерит из любой папки, включая /tmp. Это «обход git repo check», буквально.

## CRITICAL: -m gpt-5.5 ОБЯЗАТЕЛЕН
ChatGPT-подписка задепрекейтила `gpt-5.2-codex`/`gpt-5`. Без `-m gpt-5.5` codex падает «model is not supported when using Codex with a ChatGPT account».

## CRITICAL: --sandbox danger-full-access ОБЯЗАТЕЛЕН
Без него codex read-only и падает на сохранении «Read-only file system».

## CRITICAL: 401 — НЕ лезь в ключ, сообщи Олексій и жди
Если codex вернул `401 Unauthorized` (auth протух) — **НЕ** логинься через `OPENAI_API_KEY` / `--with-api-key`. Правило: при отвале внешней авторизации ты СООБЩАЕШЬ Олексій («codex-auth отвалился, нужен перелогин codex») и ЖДЁШЬ. В ключи не лезешь молча — это жёсткое правило, без исключений. Перелогин делает Олексій.

## Rules
- Модель **всегда** `gpt-image-2`. Никогда gpt-image-1 / dall-e-3.
- Явный абсолютный путь сохранения — в тексте промпта (напр. `/home/claude/obsidian-vault/assets/images/hero.png`).
- Всегда `--skip-git-repo-check --sandbox danger-full-access`.
- Промпт — всегда через `/tmp/imgprompt.txt` + `"$(cat ...)"`, НИКОГДА инлайном.
- Никаких фоллбэков (thispersondoesnotexist / picsum / placeholder). Только codex.

## Пример (правильно — через файл)
```bash
# шаг 1: Write промпт в /tmp/imgprompt.txt, напр.:
#   Use model gpt-image-2 to generate a photorealistic portrait of a 35-year-old
#   Slavic male entrepreneur in a navy suit, soft studio lighting, neutral grey
#   background. Save to /home/claude/obsidian-vault/assets/portraits/founder.png
# шаг 2:
~/.npm-global/bin/codex exec --skip-git-repo-check --sandbox danger-full-access -m gpt-5.5 "$(cat /tmp/imgprompt.txt)"
```
Картинка на диске за ~30-60 сек (сложный многоблочный креатив — до ~2 мин).

## Параллельная генерация (карусели)
Для 5+ картинок — каждый промпт в свой файл (`/tmp/imgprompt-1.txt`, `-2`…), codex-вызовы параллельно с `run_in_background=true`. До 5 параллельно — без рейт-лимита.

## Текст в картинке — типографика (креативы / обложки / постеры)

Текст в картинке (реклама, обложка, постер) GPT-Image рендерит САМ — кодом не дорисовывать (Pillow/ImageMagick нельзя). Чтобы текст был ДИЗАЙНЕРСКИМ, а не «напечатанным сверху», задавай типографику в промпте КОНКРЕТНО, как дизайн-элемент. Структура промпта: Сцена → Идея/конфликт → Композиция → Текст-блок → Типографика → Стиль → Формат → Safe-frame.

**Типографику пиши явно** — характер шрифта + цвет + обводка + АКЦЕНТ + обработка. Строки-образцы (в промпте — по-английски):
- `huge bold condensed grotesque, white with deep-red stroke, key word in <accent> color`
- `thick italic display font, yellow-to-white gradient, dark stroke, strong shadow`
- `heavy poster sans, black on <brand color>, accent word in a boxed highlight`

**Правила текста:**
- 2–4 слова в блоке, один жирный блок, текст ОГРОМНЫЙ и читаемый на телефоне.
- **Акцент-цвет на ключевом слове/цифре** — главный приём, что цепляет взгляд (как жёлтый на «STOP», огромная «4»).
- Safe-margins 5–10% — ничего не обрезается. Орфография корректная (кириллица е/и/і/ї/є — без фейка). Без watermark/лого/мусорного текста.
- Текст ДОБАВЛЯЕТ смысл (причина / враг / ставка / интрига), не повторяет очевидное.
- 2–3 доминирующих цвета, сильное цветоразделение фон↔герой↔текст, макс 3 визуальных акцента, rim-light на герое.

**Эталон-стиль:** есть сильный креатив-референс → передай его картинкой-рефом (codex `-i`, если поддерживается) и в промпте укажи «later image = STYLE only: композиция/типографика/контраст, контент НЕ копировать». Бренд-канон продукта (шрифт/акцент/настроение) держи, но бриф/рефы текущей задачи его побеждают.

## Рекламный креатив — GOLD-структура промпта (проверено, премиум — НЕ «пейнт»)

Для рекламного креатива с несколькими блоками текста (FB/IG ad, лендинг-hero, постер: верх + заголовок + саб + выгоды + CTA) — **НЕ микро-режиссируй геометрию**. Опиши ЛУК и дай ТОЧНЫЙ текст, размеченный по ролям; вёрстку, иконки, плашки gpt-image-2 соберёт сам на премиум-уровне. **Доверяй модели** — это и есть разница между gold-креативом и «пейнтом».

Скелет промпта (идёт ПОСЛЕ HARD-CONSTRAINT-блока):

    Create a high-converting [Facebook/Instagram] ad creative for [продукт].

    Format: vertical 4:5 social media ad, premium modern design, dark background with [accent] accents, strong bold typography, clean layout, high visual contrast.

    Main idea:
    [1–2 фразы позиционирования — чем НЕ генерик, какая боль/обещание]

    Visual:
    [герой-сцена: кто, среда, настроение; напр. «serious, premium, practical, not exaggerated or manipulative»]

    Text on creative in Russian:
    Top small text: [мелкий верхний]
    Main headline: [ГЛАВНОЕ, 1–2 слова, огромное]
    Subheadline: [подзаголовок]
    Benefit blocks:
    [ЗАГОЛОВОК БЛОКА] / [одна строка выгоды]      ← ×3, с иконками
    CTA: [действие] / [срочность]

    Style: Bold editorial advertising, modern [ниша] branding, premium but aggressive enough for paid ads, clean Russian typography, readable text, [явные негативы под нишу: no before-after, no unrealistic claims, no body shaming].

Почему работает: модель получает (1) лук премиум-рекламы, (2) цвет-акцент, (3) ВСЕ тексты размечены по ролям (верх / заголовок / саб / выгоды / CTA), (4) бренд-прилагательные + запреты. gpt-image-2 сам рендерит чистую кириллицу, иконки и плашку CTA — дизайнерски. Проверено на «ПОХУДЕЙ НАВСЕГДА»: вышло вровень с ChatGPT-эталоном.

**АНТИ-ПАТТЕРН (убивает креатив в «пейнт») — так НЕ надо:** микро-режиссура геометрии — «TOP 38%… THREE solid color bars edge-to-edge… FLAT solid yellow on FLAT solid black… sharp corners… exact pixel layout». Плоские блоки как в Paint. Вместо — «premium modern design, clean layout, high visual contrast, bold editorial advertising» + доверие модели.

## ЖЕЛЕЗНО: ВСЁ рендерит gpt-image-2, НИКАКОГО кода (added 2026-06-30)

codex (gpt-5.5) по своей воле дорисовывает текст через PIL/Python, если промпт ему это НЕ запретит (проверено: текст рисовался `from PIL import ImageDraw, ImageFont`). Запрети жёстко: **каждый промпт к codex ОБЯЗАН НАЧИНАТЬСЯ ровно с этого блока** (скопируй в самое начало `/tmp/<...>prompt.txt`, дословно):

> HARD CONSTRAINT (read first, obey strictly): Render the ENTIRE final image — photo, composition, layout, AND all text/typography — using the gpt-image-2 image model (the image_gen tool) ONLY. It is STRICTLY FORBIDDEN to use Python, PIL, Pillow, ImageDraw, ImageFont, cv2, OpenCV, numpy, ImageMagick, convert, mogrify, or ANY code/script to draw, render, overlay, composite, stamp or edit text or graphics. Do NOT post-process the generated image in any way. ALL text and its styling MUST be produced natively by the image model in a single generation. If the text comes out imperfect, REGENERATE with a clearer image prompt — never fix it with code.

После блока — дальше твой обычный промпт (сцена + текст + типографика). В промпт идут: СЦЕНА + ТЕКСТ (точные слова) + СТИЛЬ (характер шрифта, акцент-цвет, плашка). Кривая кириллица → переписывай ПРОМПТ (короче/чётче текст), НЕ кодом.

Проверка «codex не лез в код» (после генерации): в последней сессии `~/.codex/sessions/.../rollout-*.jsonl` инструменты должны быть только `image_gen` + пара `exec_command` (read-skill/find/cp/file). Если видишь shell-вызовы `python3 -c` / `from PIL` — промпт без HARD-CONSTRAINT-блока, перегенери с ним.
