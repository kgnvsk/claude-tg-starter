---
name: brand-fonts
description: Курируемый набор ХОРОШИХ шрифтов для видео/дизайна/веб-отчётов — с ГАРАНТИРОВАННОЙ поддержкой кириллицы. Use ВСЕГДА при выборе шрифта для ролика (HyperFrames), веб-страницы, отчёта, лендинга. НИКОГДА не бери generic (Arial/Inter/Roboto) как заголовочный и НИКОГДА не бери Latin-only шрифт для русского/украинского текста — он молча падает на системный фолбэк и выглядит дёшево.
---

# brand-fonts — только характерные шрифты, только с кириллицей

**Железное правило:** заголовки/крупный текст — ТОЛЬКО характерный display-шрифт из набора ниже. НИКОГДА generic (Arial, Inter, Roboto, Helvetica, system-ui) как hero.

**⚠️ Кириллица (RU/UA):** бери шрифт ТОЛЬКО если он реально поддерживает `cyrillic`. Latin-only шрифт на русском тексте молча заменяется системным → «обычный/уродский» вид (именно так спалился Anton).
**НЕ бери для кириллицы (Latin-only!):** `Anton`, `Bebas Neue`, `Syne`, `Bricolage Grotesque`, `Fraunces`, `Instrument Serif`, `Bowlby One`, `Clash Display`.
**Проверка нового шрифта:** `curl -s https://fonts.google.com/metadata/fonts | sed "s/^)]}'//" | python3 -c "import sys,json;d=json.load(sys.stdin);print([f['subsets'] for f in d['familyMetadataList'] if f['family']=='ИМЯ'])"` — в subsets должен быть `cyrillic`.

## ⭐ Премиум-фейсы (эффектнее Google-дефолта) — не с Google Fonts
Самые «дорогие» кириллические display-шрифты живут НЕ на Google. Бери их и вшивай (см. ниже):
| Шрифт | Характер | Источник (woff2) |
|---|---|---|
| **Fixel** (Display/Text, Thin→Black) | геометро-гуманистический гротеск, дизайнерский, MacPaw | `https://cdn.jsdelivr.net/gh/MacPaw/Fixel@main/fonts/webfonts/FixelDisplay-Black.woff2` (и др. начертания) |
| **Unbounded** | жирный округлый техно (есть и на Google) | `Unbounded:wght@800;900` |

Fixel Display Black — топ для hero-цифр/слов на тёмном фоне. Text — для body.

## Набор Google (все — кириллица ✅). Меняй hero от ролика к ролику.
### Display / hero — характерные, геометрические
| **Unbounded** | геометрический, округлый, техно | `Unbounded:wght@400;700;800;900` |
| **Russo One** | техно, угловатый | `Russo+One` |
| **Rubik Mono One** | блочный моноширинный display | `Rubik+Mono+One` |
| **Days One** | округлый, плотный | `Days+One` |
### Serif display — премиум/редакционный
| **Playfair Display** | высококонтрастная классика | `Playfair+Display:wght@600;800;900` |
| **Yeseva One** | элегантный серив | `Yeseva+One` |
### Condensed — постеры (замена Anton, с кириллицей)
| **Oswald** | конденс-гротеск | `Oswald:wght@500;700` |
| **Alumni Sans** | конденс с характером | `Alumni+Sans:wght@700;900` |
### Body / support
| **Manrope** | геометрический сан | `Manrope:wght@400;600;700` |
| **Onest** / **Golos Text** | нейтральные, кириллица-натив | `Onest` / `Golos+Text` |
### Mono / технический
| **JetBrains Mono** | техно-моно (таймкоды, метаданные) | `JetBrains+Mono:wght@500;700` |

## ⚠️ Для видео-рендера — ВШИВАЙ шрифт как base64 (не `<link>`)
При покадровом рендере (HyperFrames/headless Chrome) сетевой `<link>` шрифт может НЕ успеть подгрузиться → часть кадров с системным фолбэком. Надёжно — вшить woff2 в `@font-face` как data-URI:
```bash
# 1) скачать нужные woff2 (пример Fixel + JetBrains Mono с fontsource)
curl -sO https://cdn.jsdelivr.net/gh/MacPaw/Fixel@main/fonts/webfonts/FixelDisplay-Black.woff2
curl -so JBM-cyr.woff2 https://cdn.jsdelivr.net/fontsource/fonts/jetbrains-mono@latest/cyrillic-500-normal.woff2
# 2) сгенерить fonts.css с base64 — хелпер рядом в skill video-craft: embed-fonts.py
```
Подключение: `<link rel="stylesheet" href="fonts.css">` (локальный файл, грузится мгновенно), затем `font-family:'Fixel'` (900=Black) / `'JBM'`.

## Как подбирать (пары)
- Один **display-hero** + один **body** + опц. **mono**. Не мешай >2-3 семейств.
- Вайб: премиум/дорого → **Fixel** (+ JetBrains Mono мета); техно → Unbounded/Russo One; редакторский → Playfair/Yeseva + Manrope.
- Разным клиентам/роликам — РАЗНЫЕ пары. НЕ один шаблон на всех.
