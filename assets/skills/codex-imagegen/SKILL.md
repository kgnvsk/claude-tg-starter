---
name: codex-imagegen
description: Generate images via Codex CLI with model gpt-image-2. Use ALWAYS when user asks for any image generation — photos, illustrations, icons, avatars, posters, ad creatives, mockups, anything visual. Triggers on "generate image", "create picture", "make photo", "сгенерируй картинку", "создай изображение", "нарисуй", or when other code needs to produce an image file.
---

# Image Generation via Codex CLI

У Anthropic нет image-API. Картинки — только OpenAI Codex CLI с моделью `gpt-image-2`.

## ЖЕЛЕЗНО: промпт — в ФАЙЛ, команда — КОРОТКАЯ (иначе срыв формата tool_use)

НИКОГДА не пиши большой промпт инлайном в `codex exec "<огромный промпт>"`. Длинный аргумент с кавычками срывает сериализацию tool_use на Opus 4.8 → вызов уходит ТЕКСТОМ → не выполняется → бот молчит. Это уже клало бота. Поэтому — ВСЕГДА в два шага:

1. `Write` полный промпт в `/tmp/imgprompt.txt` (внутри текста промпта упомяни model gpt-image-2 + явный абсолютный путь сохранения).
2. Запусти codex, читая промпт ИЗ файла — команда остаётся короткой:

```bash
~/.npm-global/bin/codex exec --skip-git-repo-check --sandbox danger-full-access -m gpt-5.5 "$(cat /tmp/imgprompt.txt)"
```

`$(cat ...)` подставляет текст в рантайме — в самом tool-вызове большого текста НЕТ, срываться нечему. Codex генерит картинку и сохраняет по указанному в промпте пути.

## CRITICAL: бинарь — /home/claude/.npm-global/bin/codex (не /usr/bin/codex)
`/usr/bin/codex` застрял на 0.120.0 (нет gpt-5.5). npm-версия `~/.npm-global/bin/codex` (0.133+, сейчас 0.142) работает. Всегда полный путь.

## CRITICAL: --skip-git-repo-check ОБЯЗАТЕЛЕН (codex 0.142+)
Новый codex (0.142+) при запуске вне git-repo / в недоверенной папке падает: «Not inside a trusted directory and --skip-git-repo-check was not specified». Trust-конфиг `[projects."/tmp"]` в новой версии это уже НЕ лечит (в 0.133 работал запуск из вольта-git-repo; в 0.142 надёжнее флаг). Фикс — флаг **`--skip-git-repo-check` СРАЗУ после `exec`** (перед `--sandbox`). С ним codex генерит из любой папки, включая /tmp. Это «обход git repo check», буквально.

## CRITICAL: -m gpt-5.5 ОБЯЗАТЕЛЕН
ChatGPT-подписка задепрекейтила `gpt-5.2-codex`/`gpt-5`. Без `-m gpt-5.5` codex падает «model is not supported when using Codex with a ChatGPT account».

## CRITICAL: --sandbox danger-full-access ОБЯЗАТЕЛЕН
Без него codex read-only и падает на сохранении «Read-only file system».

## CRITICAL: 401 — НЕ лезь в ключ, сообщи владельцу и жди
Если codex вернул `401 Unauthorized` (auth протух) — **НЕ** логинься через `OPENAI_API_KEY` / `--with-api-key`. Правило: при отвале внешней авторизации ты СООБЩАЕШЬ владельцу («codex-auth отвалился, нужен перелогин codex») и ЖДЁШЬ. В ключи не лезешь молча — это жёсткое правило, без исключений. Перелогин делает владелец.

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

## Креатив / текст в картинке — доверяй codex, НЕ арт-режиссируй (updated 2026-07-01)

codex = gpt-5.5 с тем же `image_gen`, что и в ChatGPT. Передавай НАТУРАЛЬНЫЙ бриф — как человек пишет напрямую в ChatGPT: концепт + аудитория + ТОЧНЫЙ текст на креативе (по строкам) + вайб/стиль/бренд-цвета/референс + формат (4:5/1:1) + путь сохранения. Композицию, вёрстку, типографику, ГДЕ ЧТО разместить — codex + gpt-image-2 придумывают САМИ. Так делает ChatGPT, и так выходит дорого.

**Вайб — можно, геометрию — нельзя.** НЕ пиши зоны/проценты («top 55%», «lower 40%»), «solid color band spans full width», «flat solid colors / sharp edges», «3 bars», точные раскладки-шаблоны — это арт-режиссура, она и ломает результат в «пейнт» / чёрный слэб с швом. Не лезь в раскладку — codex сам.

**Скорость:** codex-агент перфекционист, может гонять регенерации из-за мелочи (кривая буква) и упереться в таймаут. В бриф добавляй строку «достаточно одной сильной генерации, мелкие несовершенства текста допустимы — сохрани и заверши»; команду гоняй с `timeout 420`.

## ЖЕЛЕЗНО: ВСЁ рендерит gpt-image-2, НИКАКОГО кода (added 2026-06-30)

codex (gpt-5.5) по своей воле дорисовывает текст через PIL/Python, если промпт ему это НЕ запретит (проверено: текст рисовался `from PIL import ImageDraw, ImageFont`). Запрети жёстко: **каждый промпт к codex ОБЯЗАН НАЧИНАТЬСЯ ровно с этого блока** (скопируй в самое начало `/tmp/<...>prompt.txt`, дословно):

> HARD CONSTRAINT (read first, obey strictly): Render the ENTIRE final image — photo, composition, layout, AND all text/typography — using the gpt-image-2 image model (the image_gen tool) ONLY. It is STRICTLY FORBIDDEN to use Python, PIL, Pillow, ImageDraw, ImageFont, cv2, OpenCV, numpy, ImageMagick, convert, mogrify, or ANY code/script to draw, render, overlay, composite, stamp or edit text or graphics. Do NOT post-process the generated image in any way. ALL text and its styling MUST be produced natively by the image model in a single generation. If the text comes out imperfect, REGENERATE with a clearer image prompt — never fix it with code.

После блока — дальше твой обычный промпт (сцена + текст + типографика). В промпт идут: СЦЕНА + ТЕКСТ (точные слова) + СТИЛЬ (характер шрифта, акцент-цвет, плашка). Кривая кириллица → переписывай ПРОМПТ (короче/чётче текст), НЕ кодом.

Проверка «codex не лез в код» (после генерации): в последней сессии `~/.codex/sessions/.../rollout-*.jsonl` инструменты должны быть только `image_gen` + пара `exec_command` (read-skill/find/cp/file). Если видишь shell-вызовы `python3 -c` / `from PIL` — промпт без HARD-CONSTRAINT-блока, перегенери с ним.
