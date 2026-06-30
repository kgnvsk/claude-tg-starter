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
~/.npm-global/bin/codex exec --sandbox danger-full-access -m gpt-5.5 "$(cat /tmp/imgprompt.txt)"
```

`$(cat ...)` подставляет текст в рантайме — в самом tool-вызове большого текста НЕТ, срываться нечему. Codex генерит картинку и сохраняет по указанному в промпте пути.

## CRITICAL: бинарь — /home/claude/.npm-global/bin/codex (не /usr/bin/codex)
`/usr/bin/codex` застрял на 0.120.0 (нет gpt-5.5). npm-версия `~/.npm-global/bin/codex` (0.133.0+) работает. Всегда полный путь.

## CRITICAL: -m gpt-5.5 ОБЯЗАТЕЛЕН
ChatGPT-подписка задепрекейтила `gpt-5.2-codex`/`gpt-5`. Без `-m gpt-5.5` codex падает «model is not supported when using Codex with a ChatGPT account».

## CRITICAL: --sandbox danger-full-access ОБЯЗАТЕЛЕН
Без него codex read-only и падает на сохранении «Read-only file system».

## CRITICAL: 401 — НЕ лезь в ключ, сообщи {{OWNER_NAME}} и жди
Если codex вернул `401 Unauthorized` (auth протух) — **НЕ** логинься через `OPENAI_API_KEY` / `--with-api-key`. Правило: при отвале внешней авторизации ты СООБЩАЕШЬ {{OWNER_NAME}} («codex-auth отвалился, нужен перелогин codex») и ЖДЁШЬ. В ключи не лезешь молча — это жёсткое правило, без исключений. Перелогин делает {{OWNER_NAME}}.

## Rules
- Модель **всегда** `gpt-image-2`. Никогда gpt-image-1 / dall-e-3.
- Явный абсолютный путь сохранения — в тексте промпта (напр. `/home/claude/obsidian-vault/assets/images/hero.png`).
- Всегда `--sandbox danger-full-access`.
- Промпт — всегда через `/tmp/imgprompt.txt` + `"$(cat ...)"`, НИКОГДА инлайном.
- Никаких фоллбэков (thispersondoesnotexist / picsum / placeholder). Только codex.

## Пример (правильно — через файл)
```bash
# шаг 1: Write промпт в /tmp/imgprompt.txt, напр.:
#   Use model gpt-image-2 to generate a photorealistic portrait of a 35-year-old
#   Slavic male entrepreneur in a navy suit, soft studio lighting, neutral grey
#   background. Save to /home/claude/obsidian-vault/assets/portraits/founder.png
# шаг 2:
~/.npm-global/bin/codex exec --sandbox danger-full-access -m gpt-5.5 "$(cat /tmp/imgprompt.txt)"
```
Картинка на диске за ~30-60 сек.

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

**Анти-паттерн (так НЕ надо):** `white bold sans-serif font with drop-shadow` — генерик, даёт плоский «вставленный кодом» текст (ровно эта ошибка убила weight-loss-креатив). Всегда — конкретный характер шрифта + акцент-цвет на ключевом слове.
