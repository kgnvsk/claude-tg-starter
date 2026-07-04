---
name: brand-fonts
description: Курируемый набор ХОРОШИХ шрифтов для видео/дизайна/веб-отчётов — с ГАРАНТИРОВАННОЙ поддержкой кириллицы. Use ВСЕГДА при выборе шрифта для ролика (HyperFrames), веб-страницы, отчёта, лендинга. НИКОГДА не бери generic (Arial/Inter/Roboto) как заголовочный и НИКОГДА не бери Latin-only шрифт для русского/украинского текста — он молча падает на системный фолбэк и выглядит дёшево.
---

# brand-fonts — только характерные шрифты, только с кириллицей

**Железное правило:** заголовки/крупный текст — ТОЛЬКО характерный display-шрифт из набора ниже. НИКОГДА generic (Arial, Inter, Roboto, Helvetica, system-ui) как hero.

**⚠️ Кириллица (RU/UA):** бери шрифт ТОЛЬКО если он реально поддерживает `cyrillic`. Latin-only шрифт на русском тексте молча заменяется системным → «обычный/уродский» вид (именно так спалился Anton). 
**НЕ бери для кириллицы (Latin-only!):** `Anton`, `Bebas Neue`, `Syne`, `Bricolage Grotesque`, `Fraunces`, `Instrument Serif`, `Bowlby One`, `Clash Display`. 
**Проверка нового шрифта:** `curl -s https://fonts.google.com/metadata/fonts | sed "s/^)]}'//" | python3 -c "import sys,json;d=json.load(sys.stdin);print([f['subsets'] for f in d['familyMetadataList'] if f['family']=='ИМЯ'])"` — в subsets должен быть `cyrillic`.

## Набор (все — кириллица ✅). Меняй hero от ролика к ролику — НЕ используй один и тот же.

### Display / hero — характерные, геометрические
| Шрифт | Характер | Google Fonts family |
|---|---|---|
| **Unbounded** | геометрический, округлый, техно (дружелюбный) | `Unbounded:wght@400;700;800;900` |
| **Russo One** | техно, угловатый, «гейм/спорт» | `Russo+One` |
| **Rubik Mono One** | блочный, моноширинный display, жирный | `Rubik+Mono+One` |
| **Days One** | округлый, плотный, геометрический | `Days+One` |

### Serif display — премиум/редакционный
| **Playfair Display** | высококонтрастная классика | `Playfair+Display:wght@600;800;900` |
| **Yeseva One** | элегантный дисплейный серив | `Yeseva+One` |

### Condensed — постеры, крупный удар (замена Anton, НО с кириллицей)
| **Oswald** | конденс-гротеск | `Oswald:wght@500;700` |
| **Alumni Sans** | конденс с характером | `Alumni+Sans:wght@700;900` |

### Body / support — чистые, современные
| **Manrope** | геометрический сан, чистый | `Manrope:wght@400;600;700` |
| **Onest** | нейтральный современный | `Onest:wght@400;600` |
| **Golos Text** | кириллица-натив, нейтральный | `Golos+Text:wght@400;600` |

### Mono / технический
| **JetBrains Mono** | техно-моно (ридауты, таймкоды) | `JetBrains+Mono:wght@500;700` |

## Как подбирать (пары)
- Один **display-hero** (крупные слова) + один **body** (мелкий текст) + опц. **mono** (техно-детали). Не мешай больше 2-3 семейств.
- Вайб: техно/стартап → Unbounded/Russo One/Rubik Mono One; премиум/экспертный → Playfair/Yeseva + Manrope; хлёсткий постер → Alumni Sans/Oswald.
- Разным клиентам/роликам — РАЗНЫЕ пары (не один шаблон на всех).

## Подключение (HyperFrames / веб)
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Russo+One&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
```
Пример пары для ролика: `font-family:"Russo One",sans-serif` (hero) + `"JetBrains Mono",monospace` (детали).
