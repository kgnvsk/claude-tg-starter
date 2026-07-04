#!/usr/bin/env python3
"""
StreamPost engine — Telegram channel auto-publisher.

Listens to TG source channels + RSS feeds, filters spam/dups, rewrites posts
through an LLM, publishes to one target channel. Sources, filters, target and
style live in configs/*.json — hot-reloaded, no restart needed.
"""

import os
import re
import sys
import json
import asyncio
import argparse
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from telethon import TelegramClient, events
from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument, MessageMediaWebPage
from telethon.extensions.html import unparse as entities_to_html
import httpx

# Allow `from core.config import Configs` when run as `python3 core/engine.py`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core.config import Configs

# === PATHS ===
ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = Path(os.environ.get('STREAMPOST_CONFIG_DIR', ROOT / 'configs'))
DATA_DIR = Path(os.environ.get('STREAMPOST_DATA_DIR', ROOT / 'data'))

# === .env ===
ENV_FILE = ROOT / '.env'
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            os.environ[key.strip()] = value.strip()

API_ID = int(os.environ.get('TELEGRAM_API_ID', '0'))
API_HASH = os.environ.get('TELEGRAM_API_HASH', '')
# Route LLM calls through the Claude Max proxy (localhost gateway, subscription — no API cost)
OPENCLAW_GATEWAY_URL = os.environ.get('OPENCLAW_GATEWAY_URL', 'http://127.0.0.1:3456')
OPENCLAW_GATEWAY_TOKEN = os.environ.get('OPENCLAW_GATEWAY_TOKEN', '')
OPENCLAW_MODEL = os.environ.get('OPENCLAW_MODEL', 'claude-sonnet-4-6')

BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')

# === State paths ===
SESSION_NAME = str(DATA_DIR / 'tg_listener_session')
MEDIA_DIR = DATA_DIR / 'tg_media'
BLOCKED_DIR = DATA_DIR / 'tg_blocked'
PUBLISHED_DIR = DATA_DIR / 'tg_published'
SEEN_ARTICLES_FILE = DATA_DIR / 'seen_articles.json'
DEDUP_CACHE_FILE = DATA_DIR / 'dedup_cache.json'

# === Hot-reloadable configs (the only source of truth for tunables) ===
CFG = Configs(CONFIG_DIR)

def _admin_cfg() -> dict: return CFG.admin.get() or {}
def _sources_cfg() -> dict: return CFG.sources.get() or {}
def _filters_cfg() -> dict: return CFG.filters.get() or {}

def get_target_channel() -> int:
    return int(_admin_cfg().get('target_channel_id', 0))

def get_safe_target_channel() -> int:
    # Same as target; guardrail kept for back-compat with publish_to_channel().
    return get_target_channel()

def get_enabled_tg_channels() -> list:
    return [c['username'] for c in _sources_cfg().get('telegram_channels', []) if c.get('enabled', True)]

def get_enabled_rss_feeds() -> list:
    return [f for f in _sources_cfg().get('rss_feeds', []) if f.get('enabled', True)]

def get_rss_check_interval() -> int:
    return int(_sources_cfg().get('rss_check_interval_min', 15)) * 60

def get_ad_indicators() -> list: return _filters_cfg().get('ad_indicators', [])
def get_banned_companies() -> list: return _filters_cfg().get('banned_companies', [])
def get_dedup_entities() -> list: return _filters_cfg().get('dedup_entities', [])
def get_key_entities() -> set: return set(_filters_cfg().get('key_entities', []))
def get_generic_brands() -> set: return set(_filters_cfg().get('generic_brands', []))
def get_ignore_for_dedup() -> set: return set(_filters_cfg().get('ignore_for_dedup', []))
def get_dedup_threshold() -> float: return float(_filters_cfg().get('dedup_threshold', 0.6))
def get_min_post_length() -> int: return int(_filters_cfg().get('min_post_length', 50))

# Back-compat shim: the codebase below references the old module-level constants
# in a handful of spots. These are properties that re-read configs on access, so
# hot-reload works transparently — but we keep the names for minimal diff.
class _LiveList:
    def __init__(self, getter): self._g = getter
    def __iter__(self): return iter(self._g())
    def __len__(self): return len(self._g())
    def __contains__(self, x): return x in self._g()

RUSSIAN_COMPANIES = _LiveList(get_banned_companies)
AD_INDICATORS = _LiveList(get_ad_indicators)
DEDUP_ENTITIES = _LiveList(get_dedup_entities)

def _lisbon_today_midnight_ts() -> float:
    """Return UNIX timestamp of today's 00:00 in Europe/Lisbon TZ.
    Dedup window = current calendar day. Posts published yesterday or earlier
    do NOT block today's posts on the same topic, even if <24h ago.
    """
    from datetime import datetime
    from zoneinfo import ZoneInfo
    tz = ZoneInfo('Europe/Lisbon')
    now_lisbon = datetime.now(tz)
    midnight_lisbon = now_lisbon.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight_lisbon.timestamp()

def extract_entities(text: str) -> set:
    """Extract key entities from text for deduplication."""
    # Too generic for AI news channels — appear in nearly every post
    IGNORE_FOR_DEDUP = {'claude', 'anthropic', 'антропік', 'openai', 'google', 'meta', 'microsoft', 'apple', 'amazon', 'nvidia'}
    text_lower = text.lower()
    found = set()
    for entity in DEDUP_ENTITIES:
        if entity in text_lower:
            # Normalize some variants
            normalized = entity.replace('маск', 'musk').replace('альтман', 'altman')
            if normalized not in IGNORE_FOR_DEDUP:
                found.add(normalized)

    # Extract versioned model names (e.g. "qwen3.5", "gpt-4o", "claude 3.5") as separate entities
    # This prevents different model versions from being treated as duplicates
    import re
    version_patterns = re.findall(r'((?:qwen|gpt|claude|gemini|llama|deepseek|mistral|o)\s*[\-.]?\s*\d[\w.\-]*)', text_lower)
    for vp in version_patterns:
        clean = re.sub(r'\s+', '', vp)  # "qwen 3.6" -> "qwen3.6"
        found.add(clean)

    return found

def load_dedup_cache() -> list:
    """Load recent posts cache for deduplication."""
    if DEDUP_CACHE_FILE.exists():
        try:
            data = json.loads(DEDUP_CACHE_FILE.read_text())
            return data.get('posts', [])
        except:
            pass
    return []

def save_dedup_cache(posts: list):
    """Save dedup cache, keeping only posts from today (Lisbon TZ) and yesterday.
    The 'yesterday' buffer covers edge cases right after midnight rollover.
    """
    import time
    # Keep posts from yesterday onwards (cutoff = today_midnight - 24h buffer)
    cutoff = _lisbon_today_midnight_ts() - 86400
    recent = [p for p in posts if p.get('timestamp', 0) > cutoff]
    recent = recent[-100:]
    DEDUP_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    DEDUP_CACHE_FILE.write_text(json.dumps({'posts': recent}, ensure_ascii=False))

def check_duplicate(text: str, threshold: float = 0.6) -> tuple[bool, str]:
    """
    Check if post is duplicate based on entity overlap.
    Returns (is_duplicate, reason)
    """
    import time
    
    # Key entities that strongly indicate same story
    # NOTE: 'anthropic' and 'claude' removed — too generic for AI news, caused false positives
    KEY_ENTITIES = {'xai', 'musk', 'openai', 'altman', 'gpt-5', 'gemini', 'sora', 'spacex'}
    
    new_entities = extract_entities(text)
    if len(new_entities) < 2:
        # Not enough entities to compare, allow
        return False, None
    
    cache = load_dedup_cache()
    # Dedup window = current calendar day in Lisbon TZ.
    # Posts from yesterday or earlier no longer count as duplicates.
    cutoff = _lisbon_today_midnight_ts()

    for post in cache:
        if post.get('timestamp', 0) < cutoff:
            continue
        
        old_entities = set(post.get('entities', []))
        if not old_entities:
            continue
        
        # Calculate overlap
        intersection = new_entities & old_entities
        
        # If key entities overlap, use stricter threshold
        key_overlap = intersection & KEY_ENTITIES
        if len(key_overlap) >= 2:
            # Same key entities (e.g., xai + musk) = likely same story
            return True, f"duplicate:key entities match ({', '.join(key_overlap)})"
        
        # Standard overlap check
        if len(new_entities) > 0:
            overlap = len(intersection) / len(new_entities)
            # If only 2-3 entities match and they're generic brand names, require higher threshold
            # This prevents "Qwen 3.5 news" and "Qwen 3.6 news" from being treated as same story
            GENERIC_BRANDS = {'qwen', 'gemini', 'llama', 'deepseek', 'mistral', 'gpt', 'claude', 'sora', 'alibaba', 'baidu', 'tencent', 'bytedance'}
            if len(intersection) <= 3 and intersection.issubset(GENERIC_BRANDS):
                # All matching entities are generic brands — require near-perfect overlap
                effective_threshold = 0.85
            else:
                effective_threshold = threshold
            if overlap >= effective_threshold:
                return True, f"duplicate:{overlap:.0%} overlap with recent post ({', '.join(intersection)})"
    
    return False, None

def add_to_dedup_cache(text: str, source: str):
    """Add published post to dedup cache."""
    import time
    entities = extract_entities(text)
    cache = load_dedup_cache()
    cache.append({
        'timestamp': time.time(),
        'source': source,
        'entities': list(entities)
    })
    save_dedup_cache(cache)

AD_INDICATORS = [
    'реклама', 'промокод', 'promo', 'скидка до', 'скидка на',
    'успей купить', 'регистрируйся', 'записаться на',
    'бесплатный вебинар', 'бесплатный курс', 'безкоштовний курс',
    'платный курс', 'платний курс', 'мой курс', 'мій курс',
    'наш курс', 'наш вебинар', 'купить билет', 'билеты на',
    'собрал весь свой опыт', 'зібрав весь свій досвід',
    'упаковал это в', 'запакував це в',
    'партнерский', 'партнёрский', '#реклама', '#ad',
    'по промокоду', 'используй код', 'спонсор', 'sponsor',
    'erid:', 'erid', '4dev.com', 'weekend offer', 'hiring',
    'ищем в команду', 'ищем разработчика', 'ищем на позицию',
    'вакансия', 'vacancy', 'career', 'careers',
    # Note: removed standalone 'ищем' - too broad, catches digest posts
    'подписывайся на наш', 'канал автора',
    # Events/conferences
    'конференция', 'конференції', 'конфа', 'конфе',
    'я выступлю', 'я виступлю', 'буду выступать', 'буду виступати',
    'приходите на', 'приходьте на', 'присоединяйтесь',
    'мероприятие', 'захід',
    'регистрация по', 'реєстрація за', 'зарегистрироваться',
    'бесплатная онлайн', 'безкоштовна онлайн',
    'митап', 'meetup', 'meet-up',
    'community sprints', 'ai skills',
    # UTM tracking = ad
    'utm_source', 'utm_medium', 'utm_campaign',
    # Other ad patterns
    'marketplace/products', 'попробуйте бесплатно', 'спробуйте безкоштовно',
    # Self-promotion to personal channels (HARD block - entire post is promo)
    'в моем канале', 'в моєму каналі', 'мой тг канал', 'мій тг канал',
    'моем тг канале', 'моєму тг каналі', 'в моем телеграм',
    'подписывайся на меня', 'підписуйся на мене',
    # NOTE: t.me/+ links are STRIPPED, not blocked (see clean_promo_text)
    # Money-making / earnings content (not AI news)
    'заработать с нуля', 'заробити з нуля', 'сколько заработал',
    'скільки заробив', 'получилось заработать', 'вдалося заробити',
    'челендж заработка', 'челендж з заробітку',
    'зарабатывать на', 'заробляти на', 'начать зарабатывать', 'почати заробляти',
    'заработку на', 'заробітку на', 'дополнительно 100', 'додатково 100',
    'тысяч рублей', 'тисяч рублів', '500 тысяч', '500 тисяч',
    # Course/lesson promos
    'бесплатный урок', 'безкоштовний урок', 'пошаговое видео', 'покрокове відео',
    'марафон', 'онлайн-марафон', 'безкоштовний марафон', 'бесплатный марафон',
    'онлайн-интенсив', 'онлайн-інтенсив', 'интенсив по', 'інтенсив з',
    'потом удалю', 'потім видалю', 'только 10 дней', 'тільки 10 днів',
    'только 7 дней', 'только 3 дня', 'свободном доступе',
    # CTA / scarcity tactics
    'жми на кнопку', 'тисни на кнопку', 'нажми на кнопку',
    'получить доступ', 'отримати доступ', 'кнопку ниже', 'кнопку нижче',
    'выдам бонусы', 'видам бонуси', 'дам бонус',
    # Personal bot promos
    '_bot)', '_bot]', 'elfi0n',
    # Stream/webinar announcements
    'ссылку пришлю', 'посилання кину', 'ссылка на трансляцию',
    'через 3 часа', 'через 2 часа', 'через час', 'через годину',
    'сегодня в 1', 'сегодня в 2', 'сьогодні о 1', 'сьогодні об 1',
    'стартуем в', 'стартуємо о', 'начинаем в', 'починаємо о',
    'ждем вас', 'чекаємо вас', 'буду ждать',
    'присоединяйся', 'приєднуйся', 'join us',
    'подключайся', 'підключайся', 'live stream', 'лайв стрим',
    'эфир в', 'ефір о',
    # UGC rubrics / engagement bait
    'скидываем в комменты', 'кидаємо в коменти', 'скидывайте в комменты',
    'кидайте в коменти', 'делимся своими', 'ділимося своїми',
    'похвастаться', 'похвалитися', 'покажите свои', 'покажіть свої',
    'keisosubbota', 'кейсосуббота', 'кейсо-суббота',
    'рубрика где мы', 'рубрика, де ми', 'наша рубрика',
    'ставим реакцию', 'ставимо реакцію', 'ставьте реакции',
    # Hard block ecosystem promo that must never go to claw-posting stream
    'colony', 'thecolony', 'thecolony.cc', 'join colony',
    'ugig.net', 'ugig', 'agentmail.to',
    # Workshop / tutorial announcements
    'что сегодня будет', 'що сьогодні буде', 'план на сегодня',
    'каждый соберет', 'кожен зробить', 'каждый сделает',
    'покажу разные', 'покажу різні', 'расскажу как я',
]

def clean_promo_text(text: str) -> str:
    """
    Strip common promo/self-promotion patterns from the END of posts.
    These are often bot links, channel invites, etc. that can be removed
    while keeping the main content.
    """
    import re
    
    lines = text.strip().split('\n')
    cleaned_lines = []
    
    # Patterns to strip (usually at the end)
    promo_patterns = [
        r't\.me/\+',  # Private invite links
        r't\.me/[a-zA-Z0-9_]+_bot',  # Bot links
        r'🤖.*бот.*t\.me',  # Bot promo lines
        r'\[.*бот.*\]\(.*t\.me.*\)',  # Markdown bot links
        r'\[.*новини.*\]\(.*t\.me.*\)',  # "News" channel links
        r'@[a-zA-Z0-9_]+_bot',  # @bot mentions
        r'^@[a-zA-Z0-9_]+$',  # Standalone @channel at end
    ]
    
    # Process from end, stop stripping when we hit real content
    stripping = True
    for line in reversed(lines):
        line_stripped = line.strip()
        
        if not line_stripped:
            if stripping:
                continue  # Skip trailing empty lines
            cleaned_lines.insert(0, line)
            continue
        
        if stripping:
            is_promo = False
            for pattern in promo_patterns:
                if re.search(pattern, line_stripped, re.IGNORECASE):
                    is_promo = True
                    break
            
            if is_promo:
                continue  # Skip this promo line
            else:
                stripping = False  # Hit real content, stop stripping
        
        cleaned_lines.insert(0, line)
    
    return '\n'.join(cleaned_lines).strip()


def check_filter(text: str) -> tuple[bool, str]:
    """Returns (should_block, reason) - keyword-based fast filter"""
    if not text:
        return False, None
    
    # Clean promo content first before checking filters
    cleaned_text = clean_promo_text(text)
    text_lower = cleaned_text.lower()
    
    for indicator in AD_INDICATORS:
        if indicator.lower() in text_lower:
            return True, f"ad:{indicator}"
    
    for company in RUSSIAN_COMPANIES:
        if company.lower() in text_lower:
            return True, f"ru_company:{company}"
    
    return False, None


AI_AD_CHECK_PROMPT = '''Analyze this Telegram post. Is it PROMOTIONAL/ADVERTISING content or REAL NEWS/INFO?

PROMOTIONAL (AD) - блокировать:
- Курсы, уроки, вебинары (платные или бесплатные)
- "Как заработать" / обещания заработка
- Продажа товаров/услуг с ценами
- Партнерские ссылки, промокоды, скидки
- "Ограниченное время" / искусственный дефицит
- Отзывы о заработках, кейсы успеха
- Явная реклама продуктов (не AI инструментов)

NEWS (не блокировать):
- Релизы AI моделей (GPT, Claude, Grok, Gemini, etc.)
- Анонсы от OpenAI, Google, Anthropic, xAI, Meta, etc.
- Новые AI инструменты и их обзоры
- Исследования, статьи, открытия
- Технические объяснения
- Авторский стиль ("попробуйте", "пишите в комментах", личный опыт) - это НЕ реклама
- Ссылки на официальные сайты продуктов (grok.com, openai.com, etc.) - это НЕ реклама
- Подборки open-source ресурсов, GitHub-репозиториев, бесплатных dev-tools - это НЕ реклама
- Рекомендации полезных сайтов/сервисов БЕЗ призыва "купи/заплати/запишись" - это НЕ реклама
- Awesome-листы, библиотеки промптов, шаблоны (DESIGN.md, prompt-templates, etc.) - это НЕ реклама

ВАЖНО: Если пост рассказывает о НОВОМ AI продукте/модели и предлагает попробовать - это NEWS, не AD!
ВАЖНО: Если пост рекомендует БЕСПЛАТНЫЙ ресурс/инструмент без коммерческого CTA (нет цены, нет промокода, нет "запишись на курс") - это NEWS, не AD!

POST:
{text}

Reply with ONLY one word: AD or NEWS'''


async def ai_check_ad(text: str) -> tuple[bool, str]:
    """
    Use AI to determine if post is promotional.
    Routes through OpenClaw gateway (subscription).
    Returns (is_ad, reason)
    """
    if not OPENCLAW_GATEWAY_TOKEN:
        return False, None
    
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                f"{OPENCLAW_GATEWAY_URL}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": os.environ.get('AUTO_PUBLISHER_AD_CHECK_MODEL', OPENCLAW_MODEL),
                    "messages": [{"role": "user", "content": AI_AD_CHECK_PROMPT.format(text=text[:2000])}],
                    "max_completion_tokens": 50,
                }
            )

            if response.status_code != 200:
                print(f"⚠️ AI ad check failed: {response.status_code}")
                print(f"⚠️ Response body: {response.text[:500]}")
                return True, "ai_check_failed"
            
            result = response.json()
            answer = result['choices'][0]['message']['content'].strip().upper()
            
            if 'AD' in answer and 'NEWS' not in answer:
                return True, "ai_detected_ad"
            
            return False, None
            
    except Exception as e:
        print(f"⚠️ AI ad check error: {e} - blocking to be safe")
        return True, "ai_check_error"

# === REWRITE PROMPT (compact checklist) ===
def get_rewrite_prompt(text: str) -> str:
    """Compose the rewrite prompt from configs/style.md + few-shot examples.

    The checklist (configs/style.md) is read live via ConfigWatcher.
    Up to 3 example posts from configs/examples/*.md are appended as few-shot.
    """
    checklist = CFG.style.get() or ""
    examples = CFG.examples()
    few_shot = ""
    if examples:
        # take up to 3 examples to stay within context budget
        picks = examples[:3]
        few_shot = "\n\nSTYLE EXAMPLES (target voice — match tone and structure):\n"
        for i, ex in enumerate(picks, 1):
            few_shot += f"\n--- Example {i} ---\n{ex.strip()}\n"

    return f"""{checklist}{few_shot}

ORIGINAL POST:
{text}"""

def normalize_dashes(text: str) -> str:
    """Replace em-dashes (—, U+2014) and en-dashes (–, U+2013) with hyphens.
    Em-dash is a strong marker of AI-generated text. Always strip."""
    if not text:
        return text
    return text.replace('\u2014', '-').replace('\u2013', '-')

def strip_markdownv2_escapes(text: str) -> str:
    """LLM sometimes outputs MarkdownV2-escaped chars (\\-, \\., \\(, \\~ etc)
    even though the channel publishes with parse_mode=HTML. Strip those.
    Preserves literal backslashes only when followed by a non-reserved char."""
    if not text:
        return text
    import re
    return re.sub(r"\\([_*\[\]()~`>#+\-=|{}.!])", r"\1", text)


def markdown_to_html_inline(text: str) -> str:
    """Defensive post-processing: LLM sometimes outputs *bold* / _italic_ /
    [text](url) markdown even though the prompt says HTML-only. Channel
    publishes with parse_mode=HTML, so raw markdown renders as text.
    Convert single-asterisk, underscore, and markdown links to HTML tags.
    Skips already-tagged code spans and existing <a href> tags."""
    if not text:
        return text
    import re
    placeholders = []
    def stash(m):
        placeholders.append(m.group(0))
        return f"\x00CODE{len(placeholders)-1}\x00"
    text = re.sub(r"<code>.*?</code>", stash, text, flags=re.DOTALL)
    text = re.sub(r"<a\s[^>]*>.*?</a>", stash, text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"\[([^\]\n]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', text)
    text = re.sub(r"(?<!\*)\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?!\*)", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w_])_([^\s_][^_\n]*?[^\s_])_(?![\w_])", r"<i>\1</i>", text)
    for i, raw in enumerate(placeholders):
        text = text.replace(f"\x00CODE{i}\x00", raw)
    return text

def strip_llm_meta(text: str) -> str:
    """Strip LLM meta-commentary and code fences that leak into the rewrite.

    Despite "OUTPUT: тільки переписаний пост" the model sometimes prefixes a
    note ("The tg-escape is for... Let me output the clean HTML directly:") and
    wraps the real post in a ```html ... ``` fence. That junk shipped verbatim
    (incident 2026-06-04). Here we: (1) if there's a fenced block, keep only its
    contents; (2) else drop a leading meta-paragraph that ends with a colon and
    contains no post-like content.
    """
    if not text:
        return text
    import re
    t = text.strip()
    # 1) If a fenced code block exists, the real post is almost always inside it.
    m = re.search(r"```(?:html|markdown|md|text)?\s*\n?(.*?)```", t, flags=re.DOTALL | re.IGNORECASE)
    if m and m.group(1).strip():
        t = m.group(1).strip()
    else:
        # stray unpaired fences
        t = re.sub(r"^```(?:html|markdown|md|text)?\s*\n?", "", t, flags=re.IGNORECASE)
        t = re.sub(r"\n?```\s*$", "", t)
    # 2) Drop a leading meta/preamble line: short first line that ends with ':'
    #    and looks like an instruction to itself (Let me / I'll / The ... is/are).
    lines = t.split("\n")
    while lines:
        first = lines[0].strip()
        meta = (
            first.endswith(":")
            and not first.startswith(("•", "-", "🍎", "🎨", "⚡", "🔥", "🧩", "🎯"))
            and re.match(r"^(the|let me|i'?ll|i will|here(?:'s| is)|note:|output|вот|ось|зараз|давай)\b",
                         first, flags=re.IGNORECASE)
        )
        if meta:
            lines.pop(0)
            while lines and not lines[0].strip():
                lines.pop(0)
        else:
            break
    return "\n".join(lines).strip()

def is_llm_refusal(text: str) -> tuple:
    """Detect when LLM returned a meta-explanation instead of a rewritten post.
    Returns (is_refusal, reason). LLM should rewrite OR return empty, never explain.
    """
    if not text:
        return False, None
    t = text.lower()
    refusal_markers = [
        # English
        "this is an advertisement", "not relevant", "doesn't fit",
        "not suitable for", "does not match", "i cannot", "i can't",
        "as an ai", "i'm sorry", "unable to rewrite",
        # Ukrainian
        "це рекламний", "не підходить", "не релевант", "не новина",
        "не ai-контент", "не ai контент", "не підходить за форматом",
        "не варто публікувати", "не відповідає", "немає сенсу",
        "не маю доступу", "не можу переписати", "як ai",
        # Russian
        "это рекламный", "не подходит", "не релевант", "не новость",
        "как ии", "не могу переписать", "это реклама",
    ]
    for m in refusal_markers:
        if m in t:
            return True, f"llm_refusal: '{m}' in output"

    # Detect thinking aloud / self-correction (LLM rewriting itself in same output)
    thinking_markers = [
        "погано, почну заново", "почну заново", "спробую ще раз",
        "плохо, начну заново", "попробую еще раз", "начну заново",
        "let me start over", "let me restart", "let me try again",
        "ой, ні", "стоп, це",
    ]
    for m in thinking_markers:
        if m in t:
            return True, f"llm_thinking_aloud: '{m}' in output"

    # Note: --- with double <b> headline is now auto-collapsed in rewrite_post
    # (post-processing takes the last section). is_llm_refusal here is safety net only.

    # Real posts have HTML markup. Short text without <b> or <a> is suspicious.
    if len(text.strip()) < 200 and "<b>" not in text and "<a " not in text:
        return True, f"llm_refusal: too short ({len(text)} chars) and no HTML markup"

    # Pre-amble markers — LLM telling what it's about to do instead of just doing it.
    preamble_markers = [
        "припускаю що є медіа", "пишу під", "пишу до", "пишу в межах",
        "буду писати", "ось мій варіант", "ось переписаний",
        "тут моя версія", "мій варіант:",
        "припускаю что есть медиа", "пишу до", "вот мой вариант",
        "i'll write", "here is my", "here's my rewrite",
    ]
    head = t[:250]  # only check the first 250 chars
    for m in preamble_markers:
        if m in head:
            return True, f"llm_preamble: '{m}' in opening"

    return False, None


def is_rewrite_irrelevant(original: str, rewritten: str) -> tuple:
    """Sanity check: rewrite must share at least one meaningful long word with original.
    Otherwise LLM hallucinated / returned cached context from another session.
    Returns (is_irrelevant, reason)."""
    import re
    if not original or not rewritten:
        return False, None
    # Pull tokens of 5+ chars from both, lowercase, alphanumeric only
    def tokens(s):
        return {w for w in re.findall(r"[A-Za-zА-Яа-яҐЄІЇґєіїЁё0-9]{5,}", s.lower())}
    orig_t = tokens(original)
    rew_t = tokens(rewritten)
    if not orig_t:
        return False, None  # original too short to check
    overlap = orig_t & rew_t
    # Strip generic protocol/platform tokens that overlap by accident
    common = {"http", "https", "telegram", "youtube", "сегодня", "сьогодні", "today"}
    overlap_meaningful = overlap - common
    if not overlap_meaningful:
        return True, f"rewrite has no 5+ char word overlap with original (orig sample: {list(orig_t)[:5]}, rew sample: {list(rew_t)[:5]})"
    return False, None


def _extract_urls(s: str) -> list:
    """All http(s) URLs in a string (href values + bare), order-preserving, deduped."""
    import re
    urls = re.findall(r'href=["\']([^"\']+)["\']', s)
    urls += re.findall(r'(?<!["\'])(https?://[^\s<>"\')]+)', s)
    seen, out = set(), []
    for u in urls:
        u = u.rstrip('.,);')
        if u not in seen:
            seen.add(u); out.append(u)
    return out


async def sanitize_links(original: str, rewritten: str) -> str:
    """Guard against the LLM mangling URLs while rewriting.

    The model rewrites links 'from memory' and can corrupt a character in a
    long URL (e.g. a YouTube id), producing a dead link that still looks valid.
    For every URL in the rewritten output:
      1. If it appears verbatim in the original → trust it, leave it.
      2. Else try to repair: if exactly one original URL shares the same host,
         swap the corrupted one for the original.
      3. Else ping it; if it doesn't return < 400, unwrap the <a> tag so the
         post still publishes but without a broken link.
    Returns the (possibly corrected) rewritten text. Never blocks the post.
    """
    import re
    out_urls = _extract_urls(rewritten)
    if not out_urls:
        return rewritten
    orig_urls = _extract_urls(original)
    orig_set = set(orig_urls)

    def host(u):
        m = re.match(r'https?://([^/]+)', u)
        return (m.group(1).lower().replace('www.', '') if m else '')

    result = rewritten
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        for u in out_urls:
            if u in orig_set:
                continue  # verbatim from source → trust
            # try host-based repair
            same_host = [o for o in orig_urls if o and host(o) == host(u)]
            if len(same_host) == 1 and same_host[0] != u:
                print(f"🔗 link repaired: {u} → {same_host[0]} (host match w/ original)")
                result = result.replace(u, same_host[0])
                continue
            # last resort: ping; if dead, unwrap the <a> so no broken link ships
            alive = False
            try:
                r = await client.get(u, headers={'User-Agent': 'Mozilla/5.0'})
                alive = r.status_code < 400
            except Exception:
                alive = False
            if not alive:
                print(f"🔗 link DEAD, unwrapping: {u}")
                # <a href="u">label</a> → label  (drop the dead anchor, keep text)
                result = re.sub(
                    r'<a\s+href=["\']' + re.escape(u) + r'["\']\s*>(.*?)</a>',
                    r'\1', result, flags=re.DOTALL)
                # also strip a bare occurrence
                result = result.replace(u, '')
    return result


async def rewrite_post(text: str, source: str = "", has_media: bool = False) -> str:
    """Rewrite post via OpenClaw gateway (subscription). Retries if too long for media caption."""
    if not OPENCLAW_GATEWAY_TOKEN:
        print("ERROR: No OpenClaw gateway token")
        return None
    
    prompt = get_rewrite_prompt(text)
    max_len = 1024 if has_media else 4000  # Telegram caption hard limit (1024); body limit (4096)
    
    async with httpx.AsyncClient(timeout=180) as client:
        for attempt in range(2):  # Max 2 attempts
            response = await client.post(
                f"{OPENCLAW_GATEWAY_URL}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENCLAW_GATEWAY_TOKEN}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": OPENCLAW_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                }
            )

            if response.status_code != 200:
                print(f"OpenClaw gateway error: {response.text}")
                return None
            
            result = response.json()
            rewritten = result['choices'][0]['message']['content']
            rewritten = strip_llm_meta(rewritten)
            rewritten = normalize_dashes(rewritten)
            rewritten = strip_markdownv2_escapes(rewritten)
            rewritten = markdown_to_html_inline(rewritten)
            # Post-process: LLM thought-aloud + --- separator → keep last <b>-bearing section.
            # Common patterns:
            #   "thinking text\n---\n<b>real post</b>" — first part has no <b>, drop it
            #   "<b>v1</b>\n---\n<b>v2</b>" — multiple attempts, keep last
            if "---" in rewritten:
                parts = [p.strip() for p in rewritten.split("---") if p.strip()]
                bold_parts = [p for p in parts if "<b>" in p]
                if bold_parts and len(parts) >= 2:
                    rewritten = bold_parts[-1]
                    print(f"⚠️ LLM emitted --- separator, kept last <b>-bearing section ({len(rewritten)} chars)")
                elif len(parts) >= 2:
                    # No bold anywhere — defensively keep just the last block
                    rewritten = parts[-1]
                    print(f"⚠️ LLM emitted --- with no bold parts, kept last block ({len(rewritten)} chars)")

            # Check length
            if len(rewritten) <= max_len:
                return rewritten
            
            if attempt == 0 and has_media:
                print(f"⚠️ Post too long ({len(rewritten)} chars), asking for shorter version...")
                prompt = f"""Цей текст занадто довгий ({len(rewritten)} символів). Максимум 1024 символи (це caption до медіа).

Скороти мінімально, на стільки скільки треба щоб влізти в 1024. Не ріж смисл - прибери лише зайве слово/підрядне речення. Об'єм має лишитись близько 1000 знаків.

ТЕКСТ:
{rewritten}

Виведи ТІЛЬКИ скорочений текст (до 1024 символів), без пояснень."""
        
        return markdown_to_html_inline(strip_markdownv2_escapes(normalize_dashes(strip_llm_meta(rewritten))))  # Return even if too long on 2nd attempt

# === RSS/BLOG FUNCTIONS ===

def load_seen_articles() -> dict:
    """Load already-processed article URLs as an insertion-ordered dict.

    Must be ordered (not a set) so save_seen_articles' [-500:] trim keeps the
    *most recent* URLs. With a plain set, list(urls)[-500:] drops arbitrary
    members once the cache exceeds 500, which evicted freshly-published URLs
    and caused the same article to be re-published every cycle.
    """
    if SEEN_ARTICLES_FILE.exists():
        try:
            data = json.loads(SEEN_ARTICLES_FILE.read_text())
            # dict.fromkeys preserves order and dedups
            return dict.fromkeys(data.get('urls', []))
        except:
            pass
    return {}

def save_seen_articles(urls: dict):
    """Save processed article URLs, keeping the 500 most recently added."""
    SEEN_ARTICLES_FILE.parent.mkdir(parents=True, exist_ok=True)
    # dict preserves insertion order, so this keeps the newest 500
    urls_list = list(urls.keys())[-500:]
    SEEN_ARTICLES_FILE.write_text(json.dumps({'urls': urls_list}, indent=2))

async def fetch_rss(feed_url: str) -> list[dict]:
    """Fetch RSS 2.0 or Atom feed and return list of articles (unified dict)."""
    articles = []
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(feed_url)
            if response.status_code != 200:
                print(f"RSS fetch error: {response.status_code}")
                return []

            root = ET.fromstring(response.text)
            media_ns = {'media': 'http://search.yahoo.com/mrss/'}
            atom_ns = 'http://www.w3.org/2005/Atom'

            rss_items = root.findall('.//item')
            atom_entries = root.findall(f'.//{{{atom_ns}}}entry')

            if rss_items:
                # --- RSS 2.0 ---
                for item in rss_items:
                    media_img = None
                    mc = item.find('media:content', media_ns)
                    if mc is not None:
                        media_img = mc.get('url')
                    articles.append({
                        'title': item.findtext('title', ''),
                        'url': item.findtext('link', ''),
                        'description': item.findtext('description', ''),
                        'pub_date': item.findtext('pubDate', ''),
                        'rss_image': media_img,
                    })
            elif atom_entries:
                # --- Atom ---
                for entry in atom_entries:
                    link_href = ''
                    for l in entry.findall(f'{{{atom_ns}}}link'):
                        rel = l.get('rel', 'alternate')
                        if rel == 'alternate':
                            link_href = l.get('href', '')
                            break
                    if not link_href:
                        l = entry.find(f'{{{atom_ns}}}link')
                        if l is not None:
                            link_href = l.get('href', '')

                    description = (
                        entry.findtext(f'{{{atom_ns}}}summary', '')
                        or entry.findtext(f'{{{atom_ns}}}content', '')
                    )
                    pub_date = (
                        entry.findtext(f'{{{atom_ns}}}published', '')
                        or entry.findtext(f'{{{atom_ns}}}updated', '')
                    )
                    articles.append({
                        'title': entry.findtext(f'{{{atom_ns}}}title', ''),
                        'url': link_href,
                        'description': description,
                        'pub_date': pub_date,
                        'rss_image': None,
                    })
    except Exception as e:
        print(f"RSS parse error: {e}")

    return articles

async def fetch_article_content(url: str) -> tuple[str, str]:
    """Fetch article and extract content + best image URL"""
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(url)
            html = response.text
            
            # Extract best image - prioritize og:image (usually hero)
            best_image = None
            
            # 1. Try og:image first (most reliable for hero)
            og_match = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
            if not og_match:
                og_match = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', html, re.IGNORECASE)
            
            if og_match:
                best_image = og_match.group(1)
            else:
                # 2. Fallback to high-res storage URLs
                image_patterns = [
                    r'https://storage\.googleapis\.com/[^"<>\s]+social-shar[^"<>\s]+\.(?:jpg|png|webp)',
                    r'https://storage\.googleapis\.com/[^"<>\s]+hero[^"<>\s]+\.(?:jpg|png|webp)',
                    r'https://storage\.googleapis\.com/[^"<>\s]+width-1[0-9]{3}[^"<>\s]+\.(?:jpg|png|webp)',
                ]
                
                for pattern in image_patterns:
                    matches = re.findall(pattern, html, re.IGNORECASE)
                    if matches:
                        best_image = matches[0]
                        break
            
            # Extract text content (simplified - real implementation might use readability)
            # Remove scripts, styles
            content = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
            content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL | re.IGNORECASE)
            # Get text from paragraphs
            paragraphs = re.findall(r'<p[^>]*>(.*?)</p>', content, re.DOTALL | re.IGNORECASE)
            text_content = '\n\n'.join(re.sub(r'<[^>]+>', '', p) for p in paragraphs)
            
            return text_content[:5000], best_image
            
    except Exception as e:
        print(f"Article fetch error: {e}")
        return None, None

async def download_image(url: str, save_path: str) -> bool:
    """Download image from URL"""
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(url)
            if response.status_code == 200:
                Path(save_path).parent.mkdir(parents=True, exist_ok=True)
                Path(save_path).write_bytes(response.content)
                print(f"📷 Downloaded image: {save_path}")
                return True
    except Exception as e:
        print(f"Image download error: {e}")
    return False

async def process_rss_article(article: dict, feed_name: str):
    """Process a single RSS article"""
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    
    print(f"\n{'='*60}")
    print(f"[{timestamp}] New article from {feed_name}")
    print(f"📰 {article['title']}")
    print(f"🔗 {article['url']}")
    
    # Fetch full article content
    content, image_url = await fetch_article_content(article['url'])
    
    # Use RSS image if article image not found
    if not image_url and article.get('rss_image'):
        image_url = article['rss_image']
    
    # Prepare text for rewriting
    full_text = f"Title: {article['title']}\n\n"
    if content:
        full_text += content
    elif article.get('description'):
        full_text += article['description']

    # Make the source article URL available to the rewriter so it can sew the
    # link into the post (checklist: website/article links are preserved).
    # Also lands the URL in sanitize_links' trusted set (full_text = "original").
    full_text += f"\n\nДжерело статті (зашити лінк у текст поста): {article['url']}"
    
    if len(full_text) < 100:
        print("⏭️ Skipped: too short")
        return
    
    # Deduplication check (no API tokens used)
    is_dup, dup_reason = check_duplicate(full_text)
    if is_dup:
        print(f"🚫 BLOCKED (dedup): {dup_reason}")
        return
    
    # Add to dedup cache IMMEDIATELY to prevent batch duplicates
    add_to_dedup_cache(full_text, feed_name)
    
    # Download image
    media_path = None
    if image_url:
        ext = '.jpg' if '.jpg' in image_url.lower() else '.webp' if '.webp' in image_url.lower() else '.png'
        media_path = str(MEDIA_DIR / f"{timestamp}_blog{ext}")
        if not await download_image(image_url, media_path):
            media_path = None
    
    # Rewrite
    print("✍️ Rewriting...")
    rewritten = await rewrite_post(full_text, f"{feed_name} ({article['url']})", has_media=bool(media_path))
    
    if not rewritten:
        print("❌ Rewrite failed")
        return

    # Detect LLM meta-refusal (e.g. "Це рекламний пост, не підходить") instead of real post
    is_refusal, refusal_reason = is_llm_refusal(rewritten)
    if is_refusal:
        print(f"🚫 BLOCKED ({refusal_reason}): {rewritten[:120]}")
        return

    # Sanity: rewrite must talk about the same thing as the original
    is_irrel, irrel_reason = is_rewrite_irrelevant(full_text, rewritten)
    if is_irrel:
        print(f"🚫 BLOCKED ({irrel_reason}): {rewritten[:120]}")
        return

    # Guard: repair/strip any URL the LLM mangled while rewriting
    rewritten = await sanitize_links(full_text, rewritten)

    print(f"✅ Rewritten ({len(rewritten)} chars): {rewritten[:80]}...")

    # Publish
    print("📤 Publishing...")
    success = await publish_to_channel(rewritten, media_path, is_video=False)
    
    if success:
        pub_file = PUBLISHED_DIR / f"{timestamp}_blog.json"
        with open(pub_file, 'w') as f:
            json.dump({
                'source': feed_name,
                'url': article['url'],
                'original_title': article['title'],
                'rewritten': rewritten,
                'media': media_path,
                'date': timestamp,
                'channel_id': get_target_channel(),
                'message_id': success if isinstance(success, int) else None
            }, f, ensure_ascii=False, indent=2)
        # Add to dedup cache
        add_to_dedup_cache(full_text + " " + rewritten, feed_name)
    
    print(f"{'='*60}\n")

async def check_rss_feeds():
    """Check all RSS feeds for new articles"""
    seen_urls = load_seen_articles()

    for feed in get_enabled_rss_feeds():
        print(f"🔍 Checking {feed['name']}...")
        articles = await fetch_rss(feed['url'])
        
        new_count = 0
        for article in articles[:5]:  # Process max 5 newest
            if article['url'] in seen_urls:
                continue

            seen_urls[article['url']] = True
            new_count += 1
            
            await process_rss_article(article, feed['name'])
            await asyncio.sleep(10)  # Rate limit between posts
        
        if new_count:
            print(f"✅ Processed {new_count} new articles from {feed['name']}")
        else:
            print(f"📭 No new articles from {feed['name']}")
    
    save_seen_articles(seen_urls)

async def rss_monitor_loop():
    """Background loop to check RSS feeds periodically"""
    while True:
        try:
            await check_rss_feeds()
        except Exception as e:
            print(f"RSS check error: {e}")
        
        interval = get_rss_check_interval()
        print(f"💤 Next RSS check in {interval // 60} minutes...")
        await asyncio.sleep(interval)


# === TELEGRAM POLLING (backup for missed events) ===
SEEN_TG_FILE = DATA_DIR / 'seen_tg_messages.json'
TG_POLL_INTERVAL = 5 * 60  # 5 minutes

def load_seen_tg() -> dict:
    """Load seen message IDs per channel"""
    if SEEN_TG_FILE.exists():
        try:
            return json.loads(SEEN_TG_FILE.read_text())
        except:
            pass
    return {}

def save_seen_tg(seen: dict):
    """Save seen message IDs"""
    # Keep only last 100 per channel
    for ch in seen:
        if len(seen[ch]) > 100:
            seen[ch] = seen[ch][-100:]
    SEEN_TG_FILE.write_text(json.dumps(seen, indent=2))

async def process_tg_message(msg, source: str):
    """Process a single Telegram message (from polling or backfill)"""
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')

    # Mark seen up-front so any later call path (live listener, poll, backfill)
    # treats this message as already handled — independent of filter/publish outcome.
    seen = load_seen_tg()
    channel_key = source.lstrip('@')
    if channel_key not in seen:
        seen[channel_key] = []
    if msg.id not in seen[channel_key]:
        seen[channel_key].append(msg.id)
        save_seen_tg(seen)

    # Preserve inline HTML links (a href), bold/italic — same as live handler
    raw_text = msg.message or msg.text or ''
    text = entities_to_html(raw_text, msg.entities) if msg.entities else raw_text
    
    # Clean promo content (bot links, invite links at the end)
    text_cleaned = clean_promo_text(text)
    
    # Check filters on cleaned text
    should_block, block_reason = check_filter(text_cleaned)
    
    # Block videos from sources
    is_video = False
    if msg.media:
        from telethon.tl.types import MessageMediaDocument
        if isinstance(msg.media, MessageMediaDocument):
            mime = getattr(msg.media.document, 'mime_type', '')
            if 'video' in mime:
                is_video = True
    
    if should_block:
        print(f"  🚫 BLOCKED (keyword): {block_reason}")
        return
    
    if not text_cleaned or len(text_cleaned) < 50:
        return  # Skip silently for polling
    
    # AI-based ad detection (runs only if keyword filter passed)
    is_ad, ad_reason = await ai_check_ad(text_cleaned)
    if is_ad:
        print(f"  🚫 BLOCKED (AI): {ad_reason}")
        return
    
    # Deduplication check (no API tokens used)
    is_dup, dup_reason = check_duplicate(text_cleaned)
    if is_dup:
        print(f"  🚫 BLOCKED (dedup): {dup_reason}")
        return
    
    # Add to dedup cache IMMEDIATELY to prevent batch duplicates
    add_to_dedup_cache(text_cleaned, source)
    
    print(f"\n{'='*60}")
    print(f"[POLL] New post from {source}")
    print(f"📝 Text: {text_cleaned[:100]}...")
    
    # Download media (photo or video)
    media_path = None
    from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument
    if msg.media:
        try:
            if isinstance(msg.media, MessageMediaPhoto):
                media_path = await msg.download_media(
                    file=str(MEDIA_DIR / f"{timestamp}_{source.replace('@','')}_{msg.id}")
                )
                print(f"📷 Downloaded photo: {media_path}")
            elif isinstance(msg.media, MessageMediaDocument):
                mime = getattr(msg.media.document, 'mime_type', '')
                if 'video' in mime:
                    media_path = await msg.download_media(
                        file=str(MEDIA_DIR / f"{timestamp}_{source.replace('@','')}_{msg.id}")
                    )
                    print(f"🎬 Downloaded video: {media_path}")
        except Exception as e:
            print(f"⚠️ Media download failed: {e}")
    
    # Rewrite (using cleaned text without promo)
    print("✍️ Rewriting...")
    rewritten = await rewrite_post(text_cleaned, source, has_media=bool(media_path))
    
    if not rewritten:
        print("❌ Rewrite failed")
        return

    # Detect LLM meta-refusal
    is_refusal, refusal_reason = is_llm_refusal(rewritten)
    if is_refusal:
        print(f"🚫 BLOCKED ({refusal_reason}): {rewritten[:120]}")
        return

    # Sanity: rewrite must talk about the same thing as the original
    is_irrel, irrel_reason = is_rewrite_irrelevant(text_cleaned, rewritten)
    if is_irrel:
        print(f"🚫 BLOCKED ({irrel_reason}): {rewritten[:120]}")
        return

    # Guard: repair/strip any URL the LLM mangled while rewriting
    rewritten = await sanitize_links(text_cleaned, rewritten)

    print(f"✅ Rewritten ({len(rewritten)} chars): {rewritten[:80]}...")

    # Drop oversized media — publish text only (Telegram Bot API: 50MB for video, 10MB for photo)
    if media_path and os.path.exists(media_path):
        size_limit = 50 * 1024 * 1024 if is_video else 10 * 1024 * 1024
        if os.path.getsize(media_path) > size_limit:
            print(f"⚠️ Media {os.path.getsize(media_path)//1024//1024}MB > {size_limit//1024//1024}MB limit, dropping media, text only")
            media_path = None
            is_video = False

    # Publish
    print("📤 Publishing...")
    success = await publish_to_channel(rewritten, media_path, is_video=is_video)
    
    if success:
        pub_file = PUBLISHED_DIR / f"{timestamp}_{source.replace('@','')}_{msg.id}.json"
        with open(pub_file, 'w') as f:
            json.dump({
                'source': source,
                'original': text,
                'rewritten': rewritten,
                'media': media_path,
                'date': timestamp,
                'channel_id': get_target_channel(),
                'message_id': success if isinstance(success, int) else None
            }, f, ensure_ascii=False, indent=2)
        # Add to dedup cache
        add_to_dedup_cache(text + " " + rewritten, source)

    print(f"{'='*60}\n")

async def poll_telegram_channels():
    """Poll channels for missed messages"""
    seen = load_seen_tg()

    for channel in get_enabled_tg_channels():
        try:
            source = f"@{channel}"
            if channel not in seen:
                seen[channel] = []
            
            # Get last 10 messages
            msgs_found = 0
            async for msg in client.iter_messages(channel, limit=10):
                msgs_found += 1
                if msg.id in seen[channel]:
                    continue
                print(f"  [DEBUG] {channel} new msg ID={msg.id} text={str(msg.text or '')[:50]}")
                
                seen[channel].append(msg.id)
                
                # Skip if part of media group without text
                text = msg.text or msg.message or ''
                if msg.grouped_id and not text:
                    continue
                
                await process_tg_message(msg, source)
                await asyncio.sleep(5)  # Rate limit

            print(f"  [DEBUG] {channel} total={msgs_found} seen={len(seen.get(channel,[]))}")
                
        except Exception as e:
            print(f"Poll error for {channel}: {e}")
    
    save_seen_tg(seen)

async def tg_poll_loop():
    """Background polling loop"""
    await asyncio.sleep(60)  # Wait 1 min before first poll
    while True:
        try:
            print("🔄 Polling Telegram channels...")
            await poll_telegram_channels()
            print("✅ Poll complete")
        except Exception as e:
            print(f"Poll error: {e}")
        
        await asyncio.sleep(TG_POLL_INTERVAL)


def truncate_caption(text: str, max_len: int = 1024) -> str:
    """Truncate caption to Telegram limit while preserving HTML tags."""
    if len(text) <= max_len:
        return text
    # Truncate and add ellipsis
    truncated = text[:max_len - 3].rsplit(' ', 1)[0] + '...'
    # Try to close any open HTML tags
    import re
    open_tags = re.findall(r'<(b|i|a|code|pre)(?:\s[^>]*)?>', truncated)
    close_tags = re.findall(r'</(b|i|a|code|pre)>', truncated)
    for tag in open_tags:
        if open_tags.count(tag) > close_tags.count(tag):
            truncated += f'</{tag}>'
    return truncated


async def publish_to_channel(text: str, media_path: str = None, is_video: bool = False, media_paths: list = None):
    """Publish to target channel via Bot API. Supports single photo, video, or media group."""
    target = get_target_channel()
    if not target:
        print("ERROR: target_channel_id not set in configs/admin.json")
        return False
    if not BOT_TOKEN:
        print("ERROR: No bot token")
        return False

    # Drop oversized media files immediately (Telegram limit: 50MB for video, 10MB for photo)
    if media_path and os.path.exists(str(media_path)):
        file_size = os.path.getsize(str(media_path))
        is_vid = str(media_path).endswith(('.mp4', '.mov', '.avi', '.mkv'))
        size_limit = 50 * 1024 * 1024 if is_vid else 10 * 1024 * 1024
        if file_size > size_limit:
            print(f"⚠️ OVERSIZED: {file_size//1024//1024}MB — publishing text only")
            media_path = None
            is_video = False
    
    # Truncate caption if needed (Telegram limit: 1024 for captions, 4096 for messages)
    if media_path or media_paths:
        text = truncate_caption(text, 1024)
    else:
        text = truncate_caption(text, 4096)
    
    async with httpx.AsyncClient(timeout=60) as client:
        # Media group (multiple photos)
        if media_paths and len(media_paths) > 1:
            # Build media group JSON
            media_group = []
            files = {}
            for i, path in enumerate(media_paths):
                if os.path.exists(path):
                    attach_name = f"photo{i}"
                    media_item = {
                        "type": "photo",
                        "media": f"attach://{attach_name}"
                    }
                    if i == 0:  # Caption only on first photo
                        media_item["caption"] = text
                        media_item["parse_mode"] = "HTML"
                    media_group.append(media_item)
                    files[attach_name] = open(path, 'rb')
            
            if media_group:
                response = await client.post(
                    f"https://api.telegram.org/bot{BOT_TOKEN}/sendMediaGroup",
                    data={
                        "chat_id": target,
                        "media": json.dumps(media_group)
                    },
                    files=files
                )
                # Close files
                for f in files.values():
                    f.close()
        elif media_path and os.path.exists(media_path):
            file_size = os.path.getsize(media_path)
            # Bot API limits: 50MB for sendVideo, 10MB for sendPhoto. Fall back to sendDocument only if over the relevant limit.
            max_size = 50 * 1024 * 1024 if is_video else 10 * 1024 * 1024
            if file_size > max_size:
                kind = "video" if is_video else "photo"
                print(f"⚠️ File {file_size//1024//1024}MB > {max_size//1024//1024}MB {kind} limit, sending as document")
                with open(media_path, 'rb') as f:
                    response = await client.post(
                        f"https://api.telegram.org/bot{BOT_TOKEN}/sendDocument",
                        data={
                            "chat_id": target,
                            "caption": text,
                            "parse_mode": "HTML",
                        },
                        files={"document": f}
                    )
            else:
                endpoint = "sendVideo" if is_video else "sendPhoto"
                media_key = "video" if is_video else "photo"

                with open(media_path, 'rb') as f:
                    data = {
                        "chat_id": target,
                        "caption": text,
                        "parse_mode": "HTML",
                        "disable_web_page_preview": "true",
                    }
                    if is_video:
                        # supports_streaming=true -> inline playable video with preview
                        data["supports_streaming"] = "true"
                    response = await client.post(
                        f"https://api.telegram.org/bot{BOT_TOKEN}/{endpoint}",
                        data=data,
                        files={media_key: f}
                    )
        else:
            response = await client.post(
                f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
                data={
                    "chat_id": target,
                    "text": text,
                    "parse_mode": "HTML",
                    "disable_web_page_preview": "true"
                }
            )
        
        result = response.json()
        if result.get('ok'):
            # Capture the channel message_id so posts can be edited later.
            # sendMediaGroup returns a list; the caption lives on the first message.
            res = result.get('result')
            if isinstance(res, list):
                msg_id = res[0].get('message_id') if res else None
            else:
                msg_id = (res or {}).get('message_id')
            print(f"✅ Published to channel! (message_id={msg_id})")
            return msg_id if msg_id is not None else True
        else:
            print(f"❌ Publish error: {result}")
            return False

# Ensure directories
MEDIA_DIR.mkdir(parents=True, exist_ok=True)
BLOCKED_DIR.mkdir(parents=True, exist_ok=True)
PUBLISHED_DIR.mkdir(parents=True, exist_ok=True)

client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

@client.on(events.NewMessage(chats=CHANNELS))
async def handler(event):
    """Handle new messages from monitored channels"""
    message = event.message
    chat = await event.get_chat()
    
    timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    source = f"@{chat.username}" if chat.username else chat.title
    channel_key = chat.username or str(chat.id)
    
    # Mark as seen immediately to prevent duplicate processing by polling
    seen = load_seen_tg()
    if channel_key not in seen:
        seen[channel_key] = []
    if message.id not in seen[channel_key]:
        seen[channel_key].append(message.id)
        save_seen_tg(seen)
    
    print(f"\n{'='*60}")
    print(f"[{timestamp}] New post from {source}")
    
    # Get text (handle forwards where .text might be None but .message exists)
    raw_text = message.text or message.message or ''
    # Convert entities to HTML to preserve formatting (blockquotes, bold, etc)
    text = entities_to_html(raw_text, message.entities) if message.entities else raw_text
    
    # Clean promo content (bot links, invite links at the end)
    text_cleaned = clean_promo_text(text)
    
    # Check filters on cleaned text
    should_block, block_reason = check_filter(text_cleaned)
    
    # Block all videos from Russian sources
    is_video = False
    if message.media:
        if isinstance(message.media, MessageMediaDocument):
            mime = getattr(message.media.document, 'mime_type', '')
            if 'video' in mime:
                is_video = True
    
    if should_block:
        print(f"🚫 BLOCKED (keyword): {block_reason}")
        # Save to blocked
        blocked_file = BLOCKED_DIR / f"{timestamp}_{chat.username}_{message.id}.json"
        with open(blocked_file, 'w') as f:
            json.dump({
                'source': source,
                'text': text,
                'reason': f"keyword:{block_reason}",
                'date': timestamp
            }, f, ensure_ascii=False, indent=2)
        return
    
    if not text_cleaned or len(text_cleaned) < 50:
        print(f"⏭️ Skipped: too short or no text (len={len(text_cleaned) if text_cleaned else 0})")
        return
    
    # AI-based ad detection (runs only if keyword filter passed)
    print(f"🤖 AI checking for ads...")
    is_ad, ad_reason = await ai_check_ad(text_cleaned)
    if is_ad:
        print(f"🚫 BLOCKED (AI): promotional content detected")
        blocked_file = BLOCKED_DIR / f"{timestamp}_{chat.username}_{message.id}.json"
        with open(blocked_file, 'w') as f:
            json.dump({
                'source': source,
                'text': text,
                'reason': "ai:promotional_content",
                'date': timestamp
            }, f, ensure_ascii=False, indent=2)
        return
    
    # Deduplication check (no API tokens used)
    is_dup, dup_reason = check_duplicate(text_cleaned)
    if is_dup:
        print(f"🚫 BLOCKED (dedup): {dup_reason}")
        blocked_file = BLOCKED_DIR / f"{timestamp}_{chat.username}_{message.id}.json"
        with open(blocked_file, 'w') as f:
            json.dump({
                'source': source,
                'text': text,
                'reason': dup_reason,
                'date': timestamp
            }, f, ensure_ascii=False, indent=2)
        return
    
    # Add to dedup cache IMMEDIATELY to prevent batch duplicates
    add_to_dedup_cache(text_cleaned, source)
    
    print(f"📝 Text: {text_cleaned[:100]}...")
    
    # Download media - handle media groups
    media_path = None
    media_paths = []
    
    if message.grouped_id:
        # This is part of a media group - fetch all messages in the group
        print(f"📎 Media group detected (grouped_id: {message.grouped_id})")
        try:
            # Get messages around this one to find group members
            async for msg in client.iter_messages(chat, limit=10, max_id=message.id + 5, min_id=message.id - 5):
                if msg.grouped_id == message.grouped_id and msg.media:
                    if isinstance(msg.media, MessageMediaPhoto):
                        path = await msg.download_media(
                            file=str(MEDIA_DIR / f"{timestamp}_{chat.username}_{msg.id}")
                        )
                        if path:
                            media_paths.append(path)
                            print(f"📷 Downloaded group photo: {path}")
            # Sort by message id to maintain order
            media_paths.sort()
        except Exception as e:
            print(f"⚠️ Media group download failed: {e}")
    elif message.media:
        # Single photo or video
        try:
            if isinstance(message.media, MessageMediaPhoto):
                media_path = await message.download_media(
                    file=str(MEDIA_DIR / f"{timestamp}_{chat.username}_{message.id}")
                )
                print(f"📷 Downloaded photo: {media_path}")
            elif isinstance(message.media, MessageMediaDocument):
                mime = getattr(message.media.document, 'mime_type', '')
                if 'video' in mime:
                    media_path = await message.download_media(
                        file=str(MEDIA_DIR / f"{timestamp}_{chat.username}_{message.id}")
                    )
                    is_video = True
                    print(f"🎬 Downloaded video: {media_path}")
        except Exception as e:
            print(f"⚠️ Media download failed: {e}")
    
    # Rewrite post (using cleaned text without promo)
    print("✍️ Rewriting...")
    rewritten = await rewrite_post(text_cleaned, source, has_media=bool(media_path or media_paths))
    
    if not rewritten:
        print("❌ Rewrite failed")
        return

    # Detect LLM meta-refusal
    is_refusal, refusal_reason = is_llm_refusal(rewritten)
    if is_refusal:
        print(f"🚫 BLOCKED ({refusal_reason}): {rewritten[:120]}")
        return

    # Sanity: rewrite must talk about the same thing as the original
    is_irrel, irrel_reason = is_rewrite_irrelevant(text_cleaned, rewritten)
    if is_irrel:
        print(f"🚫 BLOCKED ({irrel_reason}): {rewritten[:120]}")
        return

    # Guard: repair/strip any URL the LLM mangled while rewriting
    rewritten = await sanitize_links(text_cleaned, rewritten)

    print(f"✅ Rewritten ({len(rewritten)} chars): {rewritten[:80]}...")

    # Publish
    print("📤 Publishing...")
    if media_paths:
        success = await publish_to_channel(rewritten, media_paths=media_paths)
    else:
        success = await publish_to_channel(rewritten, media_path, is_video=is_video)
    
    if success:
        # Save to published
        pub_file = PUBLISHED_DIR / f"{timestamp}_{chat.username}_{message.id}.json"
        with open(pub_file, 'w') as f:
            json.dump({
                'source': source,
                'original': text,
                'rewritten': rewritten,
                'media': media_path if media_path else media_paths,
                'date': timestamp,
                'channel_id': get_target_channel(),
                'message_id': success if isinstance(success, int) else None
            }, f, ensure_ascii=False, indent=2)
        # Add to dedup cache
        add_to_dedup_cache(text + " " + rewritten, source)
    
    print(f"{'='*60}\n")

async def main():
    chans = get_enabled_tg_channels()
    feeds = get_enabled_rss_feeds()
    print("=" * 60)
    print("🚀 STREAMPOST STARTED")
    print("=" * 60)
    print(f"Config dir: {CONFIG_DIR}")
    print(f"Data dir:   {DATA_DIR}")
    print(f"Target:     {get_target_channel()}")
    print(f"TG Sources: {', '.join(chans)}")
    print(f"RSS Sources: {[f['name'] for f in feeds]}")
    print("=" * 60)
    
    # Use existing user session for MTProto (needed for GetHistoryRequest on channels)
    # Bot token is used separately via HTTP API for posting
    await client.start()
    
    # Verify channels
    for channel in get_enabled_tg_channels():
        try:
            entity = await client.get_entity(channel)
            print(f"✓ @{channel}")
        except Exception as e:
            print(f"✗ @{channel}: {e}")
    
    print("=" * 60)
    print("👂 Listening for new posts...")
    print("🔄 RSS check every 15 minutes")
    print("🔄 TG polling every 5 minutes (backup)")
    print("=" * 60)
    
    # Run Telegram listener, RSS monitor, and TG polling concurrently
    await asyncio.gather(
        client.run_until_disconnected(),
        rss_monitor_loop(),
        tg_poll_loop()
    )

def _parse_cli():
    parser = argparse.ArgumentParser(description="StreamPost engine")
    parser.add_argument('--config-dir', default=None, help='Path to configs/ (default: repo root /configs)')
    parser.add_argument('--data-dir', default=None, help='Path to data/ (default: repo root /data)')
    return parser.parse_args()


if __name__ == '__main__':
    args = _parse_cli()
    if args.config_dir:
        CONFIG_DIR = Path(args.config_dir)
        CFG = Configs(CONFIG_DIR)
    if args.data_dir:
        DATA_DIR = Path(args.data_dir)
        SESSION_NAME = str(DATA_DIR / 'tg_listener_session')
        MEDIA_DIR = DATA_DIR / 'tg_media'
        BLOCKED_DIR = DATA_DIR / 'tg_blocked'
        PUBLISHED_DIR = DATA_DIR / 'tg_published'
        SEEN_ARTICLES_FILE = DATA_DIR / 'seen_articles.json'
        DEDUP_CACHE_FILE = DATA_DIR / 'dedup_cache.json'
        SEEN_TG_FILE = DATA_DIR / 'seen_tg_messages.json'

    # Ensure data subdirs exist
    for d in (MEDIA_DIR, BLOCKED_DIR, PUBLISHED_DIR):
        d.mkdir(parents=True, exist_ok=True)

    asyncio.run(main())
