#!/usr/bin/env bash
# setup.sh — vendor Quartz v4 into the bot's vault repo, apply the PROVEN "vault-web"
# brand + layout + graph fixes (the design that's live on the Cash server), add the
# password gate, and (optionally) auto-deploy to Vercel.
#
# The vault becomes a password-protected READ-ONLY web app on Vercel: graph view +
# rendered notes + backlinks + search + dark mode — the Obsidian-desktop feel. The bot
# WRITES the vault; the owner VIEWS it.
#
# Run as the vault owner ON THE SERVER (the vault repo is ~/obsidian-vault):
#   sudo -u claude bash modules/vault-web/setup.sh <your-vercel-domain>
#   # e.g. ... setup.sh my-vault.vercel.app   (domain WITHOUT https://)
# Then connect the repo to Vercel + set the password — see README.md.
#
# Per-owner values (agent name, owner name/email, locale) are read from the persisted
# inputs install-core wrote to ~/.cash-agent.env. They can also be overridden via env.
set -euo pipefail
MOD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="${VAULT_DIR:-$HOME/obsidian-vault}"
DOMAIN="${1:-your-project.vercel.app}"

[ -d "$VAULT/.git" ] || { echo "FATAL: $VAULT — не git-репо. vault не настроен (см. DEPLOY.md Фаза 5)."; exit 1; }
[ -d "$VAULT/wiki" ] || { echo "FATAL: $VAULT/wiki не найден — это не наш vault."; exit 1; }

# ── owner inputs (source of truth = ~/.cash-agent.env from install-core) ──
[ -f "$HOME/.cash-agent.env" ] && { set -a; . "$HOME/.cash-agent.env"; set +a; }
AGENT_NAME="${AGENT_NAME:-Assistant}"
OWNER_NAME="${OWNER_NAME:-Owner}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
VAULT_LOCALE="${VAULT_LOCALE:-en-US}"
SITE_PASSWORD="${SITE_PASSWORD:-}"
YEAR="$(date +%Y)"

cd "$VAULT"

# ── 1. vendor Quartz v4 (functional files only; NOT its sample content, .git, docs) ──
if [ ! -d quartz ]; then
  TMP="$(mktemp -d)"
  git clone --depth 1 -b v4 https://github.com/jackyzha0/quartz "$TMP/q" >/dev/null 2>&1
  rsync -a --exclude '.git' --exclude 'content' --exclude '.github' --exclude 'docs' \
           --exclude 'README.md' "$TMP/q/" ./
  rm -rf "$TMP"
  echo "✅ Quartz v4 встроен в репо"
else
  echo "✅ Quartz уже есть — пропускаю vendor"
fi

# ── 2. our files: auth middleware + Vercel build config (cleanUrls) ──
cp "$MOD/middleware.ts" ./middleware.ts
cp "$MOD/vercel.json" ./vercel.json
echo "✅ middleware.ts + vercel.json (cleanUrls)"

# ── 3. point Quartz at the domain (for sitemap/canonical; graph works regardless) ──
[ -f quartz.config.ts ] && sed -i "s|baseUrl: \"[^\"]*\"|baseUrl: \"$DOMAIN\"|" quartz.config.ts || true

# ── 4. BRAND + LAYOUT + GRAPH: apply the proven vault-web design ──
#    (a) inject theme block, (b) locale+pageTitle, (c) custom.scss, (d) Footer.tsx,
#    (e) quartz.layout.ts, (f) two graph.inline.ts patches, (g) homepage. All idempotent;
#    each string-replace ABORTS LOUD if Quartz's vendored code no longer matches the anchor.
python3 - "$AGENT_NAME" "$OWNER_NAME" "$VAULT_LOCALE" "$YEAR" <<'PYEOF'
import sys, pathlib

AGENT_NAME, OWNER_NAME, VAULT_LOCALE, YEAR = sys.argv[1:5]

def read(p):  return pathlib.Path(p).read_text()
def write(p, s): pathlib.Path(p).write_text(s)

# ---------- (a) theme block: fonts (Unbounded/Onest/JetBrains Mono) + amber palette ----------
THEME_NEW = '''    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Unbounded",
        body: "Onest",
        code: "JetBrains Mono",
      },
      colors: {
        lightMode: {
          light: "#f3f0e9",
          lightgray: "#e2ddd1",
          gray: "#9c9484",
          darkgray: "#2a2620",
          dark: "#171411",
          secondary: "#b45309",
          tertiary: "#d97706",
          highlight: "rgba(180, 83, 9, 0.08)",
          textHighlight: "#fcd34d99",
        },
        darkMode: {
          light: "#15130f",
          lightgray: "#2b2820",
          gray: "#736b5c",
          darkgray: "#d8d2c4",
          dark: "#f3efe6",
          secondary: "#f5b14d",
          tertiary: "#e0913a",
          highlight: "rgba(245, 177, 77, 0.10)",
          textHighlight: "#b3aa0288",
        },
      },
    },'''

cfg_p = "quartz.config.ts"
cfg = read(cfg_p)
if "Unbounded" in cfg and "#b45309" in cfg:
    print("config: theme already amber — skip")
else:
    # Replace the FIRST `theme: { ... },` block (the site theme, not the syntax-highlight
    # `theme:` that lives inside the SyntaxHighlighting plugin). We match from the
    # `theme: {\n      fontOrigin` marker up to the matching `\n    },` to be robust to
    # Quartz tweaking individual default colors between releases.
    import re
    m = re.search(r'    theme: \{\n      fontOrigin.*?\n    \},', cfg, flags=re.S)
    if not m:
        print("FATAL: site `theme: { fontOrigin ... },` block not found in quartz.config.ts — Quartz layout changed. ABORT.")
        sys.exit(2)
    cfg = cfg[:m.start()] + THEME_NEW + cfg[m.end():]
    write(cfg_p, cfg)
    print("config: theme block injected (Unbounded/Onest + amber)")

# ---------- (b) locale + pageTitle ----------
cfg = read(cfg_p)
import re
cfg2 = re.sub(r'pageTitle: "[^"]*"', f'pageTitle: "{AGENT_NAME}"', cfg, count=1)
cfg2 = re.sub(r'locale: "[^"]*"',    f'locale: "{VAULT_LOCALE}"', cfg2, count=1)
if cfg2 == cfg:
    print("WARN: pageTitle/locale anchors not found — left as-is")
else:
    write(cfg_p, cfg2)
    print(f"config: pageTitle={AGENT_NAME!r}, locale={VAULT_LOCALE!r}")

# ---------- (c) custom.scss — our brand styles + graph-container height fix ----------
CUSTOM_SCSS = '''@use "./base.scss";

// ── Assistant memory · "living memory" — Unbounded + Onest + amber ──

h1, .page-title {
  font-family: var(--headerFont);
  font-weight: 700;
  letter-spacing: -0.02em;
}
h1 {
  font-size: clamp(1.9rem, 1.4rem + 2vw, 2.9rem);
  line-height: 1.08;
  text-wrap: balance;
}
.page-title {
  font-size: 1.3rem;
  font-weight: 800;
  color: var(--secondary);
}

h2 { font-weight: 700; letter-spacing: -0.015em; }
h3, h4 {
  font-family: var(--bodyFont);
  font-weight: 600;
  letter-spacing: -0.005em;
}

article { line-height: 1.72; }
article p { text-wrap: pretty; }

a.internal {
  background-color: transparent;
  color: var(--secondary);
  padding: 0;
  border-radius: 0;
  font-weight: 500;
  box-shadow: inset 0 -0.09em 0 color-mix(in oklab, var(--secondary) 40%, transparent);
  transition: box-shadow 0.18s ease, color 0.18s ease;
  &:hover { box-shadow: inset 0 -0.55em 0 color-mix(in oklab, var(--secondary) 16%, transparent); }
}

.explorer ul li > a.active { color: var(--secondary); font-weight: 600; }

// Graph moved below content — a real, tall map of connections
.graph {
  margin-top: 2rem;
  .graph-outer {
    height: clamp(300px, 42vh, 440px);
    border-radius: 12px;
    border: 1px solid var(--lightgray);
  }
  .graph-container { height: 100%; }
}
'''
write("quartz/styles/custom.scss", CUSTOM_SCSS)
print("custom.scss: written (brand + .graph-container height:100%)")

# ---------- (d) Footer.tsx — our footer (no "Created with Quartz") ----------
FOOTER_TSX = '''import { QuartzComponent, QuartzComponentConstructor, QuartzComponentProps } from "./types"
import style from "./styles/footer.scss"

interface Options {
  links: Record<string, string>
}

export default ((opts?: Options) => {
  const Footer: QuartzComponent = ({ displayClass }: QuartzComponentProps) => {
    const year = new Date().getFullYear()
    return (
      <footer class={`${displayClass ?? ""}`}>
        <p>__AGENT_NAME__ · private assistant memory · © {year}</p>
      </footer>
    )
  }

  Footer.css = style
  return Footer
}) satisfies QuartzComponentConstructor
'''.replace("__AGENT_NAME__", AGENT_NAME)
write("quartz/components/Footer.tsx", FOOTER_TSX)
print("Footer.tsx: written (genericized)")

# ---------- (e) quartz.layout.ts — Graph in afterBody (full-width below content) ----------
LAYOUT_TS = '''import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [],
  afterBody: [Component.Graph({ localGraph: { depth: -1, scale: 0.7, repelForce: 0.4, centerForce: 0.4, linkDistance: 25, focusOnHover: true } })],
  footer: Component.Footer({
    links: {},
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.Breadcrumbs(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ArticleTitle(),
    Component.ContentMeta(),
    Component.TagList(),
  ],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
        { Component: Component.ReaderMode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [
    Component.DesktopOnly(Component.TableOfContents()),
    Component.Backlinks(),
  ],
}

// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.Breadcrumbs(), Component.ArticleTitle(), Component.ContentMeta()],
  left: [
    Component.PageTitle(),
    Component.MobileOnly(Component.Spacer()),
    Component.Flex({
      components: [
        {
          Component: Component.Search(),
          grow: true,
        },
        { Component: Component.Darkmode() },
      ],
    }),
    Component.Explorer(),
  ],
  right: [],
}
'''
write("quartz.layout.ts", LAYOUT_TS)
print("quartz.layout.ts: written (Graph in afterBody)")

# ---------- (f) graph.inline.ts — TWO patches (exact anchors from proven scripts) ----------
gp = "quartz/components/scripts/graph.inline.ts"
g = read(gp)

# PATCH #1: wait-for-layout before reading offsetWidth (fixes blank-until-resize)
anchor1 = "  const width = graph.offsetWidth\n"
patch1 = (
"  if (graph.offsetWidth === 0) {\n"
"    await new Promise<void>((resolve) => {\n"
"      const ro = new ResizeObserver(() => {\n"
"        if (graph.offsetWidth > 0) {\n"
"          ro.disconnect()\n"
"          resolve()\n"
"        }\n"
"      })\n"
"      ro.observe(graph)\n"
"      setTimeout(() => {\n"
"        ro.disconnect()\n"
"        resolve()\n"
"      }, 3000)\n"
"    })\n"
"  }\n"
)
if "graph.offsetWidth === 0" in g:
    print("graph.inline #1: already patched (wait-for-layout) — skip")
elif anchor1 in g:
    g = g.replace(anchor1, patch1 + anchor1, 1)
    print("graph.inline #1: wait-for-layout inserted")
else:
    print("FATAL: graph.inline.ts anchor `const width = graph.offsetWidth` not found — Quartz changed. ABORT.")
    sys.exit(3)

# PATCH #2: center-preserving initial zoom (replace the `if (enableZoom) { ... }` block)
old_zoom = '''  if (enableZoom) {
    select<HTMLCanvasElement, NodeData>(app.canvas).call(
      zoom<HTMLCanvasElement, NodeData>()
        .extent([
          [0, 0],
          [width, height],
        ])
        .scaleExtent([0.25, 4])
        .on("zoom", ({ transform }) => {
          currentTransform = transform
          stage.scale.set(transform.k, transform.k)
          stage.position.set(transform.x, transform.y)

          // zoom adjusts opacity of labels too
          const scale = transform.k * opacityScale
          let scaleOpacity = Math.max((scale - 1) / 3.75, 0)
          const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)

          for (const label of labelsContainer.children) {
            if (!activeNodes.includes(label)) {
              label.alpha = scaleOpacity
            }
          }
        }),
    )
  }'''

new_zoom = '''  if (enableZoom) {
    const zoomBehaviour = zoom<HTMLCanvasElement, NodeData>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .scaleExtent([0.25, 4])
      .on("zoom", ({ transform }) => {
        currentTransform = transform
        stage.scale.set(transform.k, transform.k)
        stage.position.set(transform.x, transform.y)

        // zoom adjusts opacity of labels too
        const zscale = transform.k * opacityScale
        let scaleOpacity = Math.max((zscale - 1) / 3.75, 0)
        const activeNodes = nodeRenderData.filter((n) => n.active).flatMap((n) => n.label)

        for (const label of labelsContainer.children) {
          if (!activeNodes.includes(label)) {
            label.alpha = scaleOpacity
          }
        }
      })
    const graphSel = select<HTMLCanvasElement, NodeData>(app.canvas)
    graphSel.call(zoomBehaviour)
    // initial center-preserving zoom so the full graph fits the (possibly wide) container
    graphSel.call(
      zoomBehaviour.transform,
      zoomIdentity.translate(((1 - scale) * width) / 2, ((1 - scale) * height) / 2).scale(scale),
    )
  }'''

if "zoomBehaviour" in g and "center-preserving" in g:
    print("graph.inline #2: already patched (center zoom) — skip")
elif old_zoom in g:
    g = g.replace(old_zoom, new_zoom, 1)
    print("graph.inline #2: center-preserving initial zoom patched")
else:
    print("FATAL: graph.inline.ts `if (enableZoom) { ... }` block not found — Quartz changed. ABORT.")
    sys.exit(4)

write(gp, g)

# ---------- (g) homepage (genericized English) ----------
INDEX_MD = f'''---
title: {AGENT_NAME}
---

External memory of the assistant — what it knows and how it connects.

## Maps
- [[Wiki Map|Topic map]] — the big picture
- [[Concepts Map|Concepts]] · [[Sources Map|Sources]] · [[Task Loop|Tasks]]

## Now
- [[active-thread|Active thread]] — recent conversations
- [[hot|Hot cache]] — what's in focus

## Entities
- [[People and Companies|People & companies]] · [[{OWNER_NAME}|Owner]]

Search — `Ctrl/Cmd + K`. Graph nodes are clickable — they open the note.
'''
pathlib.Path("wiki").mkdir(exist_ok=True)
write("wiki/index.md", INDEX_MD)
print("wiki/index.md: written (genericized)")
PYEOF
echo "✅ brand + layout + graph patches applied"

# ── 5. CRITICAL: vault repo git author MUST match the owner's Vercel account ──
#    Without this, `vercel deploy` is rejected with COMMIT_AUTHOR_REQUIRED (Vercel
#    requires the commit author email to match a verified email on the account).
if [ -n "$OWNER_EMAIL" ]; then
  git config user.email "$OWNER_EMAIL"
  git config user.name  "$OWNER_NAME"
  echo "✅ git author set: $OWNER_NAME <$OWNER_EMAIL> (avoids COMMIT_AUTHOR_REQUIRED)"
else
  echo "⚠️  OWNER_EMAIL пуст — git author НЕ выставлен. Vercel-деплой упрётся в"
  echo "    COMMIT_AUTHOR_REQUIRED. Поставь вручную в $VAULT:"
  echo "      git config user.email <твой-email-на-Vercel>"
  echo "      git config user.name  \"$OWNER_NAME\""
fi

# ── 6. never commit build output / deps ──
for ig in public/ node_modules/ .quartz-cache/; do
  grep -qxF "$ig" .gitignore 2>/dev/null || echo "$ig" >> .gitignore
done

# ── 7. tell the bot the URL: a file + a line in hot.md (hot.md is injected EVERY session,
#    so the bot always knows it and can share it when the owner asks for the link) ──
mkdir -p "$HOME/.claude/channels/telegram"
echo "https://$DOMAIN" > "$HOME/.claude/channels/telegram/vault-url"
HOT="$VAULT/wiki/hot.md"
if [ -f "$HOT" ] && ! grep -q "Веб-vault" "$HOT"; then
  printf -- '- Веб-vault (граф/заметки, по запросу дай ссылку): https://%s\n' "$DOMAIN" >> "$HOT"
fi

# ── 8. commit (vault-sync would too; do it explicitly + immediately) ──
git add -A
git commit -q -m "vault-web: Quartz + amber brand + graph fixes + Basic-Auth gate" 2>/dev/null \
  || echo "(нечего коммитить)"

# ── 9. (optional) auto-deploy to Vercel if a token is present ──
#    Needs ~/.config/vercel-token (owner's Vercel token) and SITE_PASSWORD (env or
#    ~/.cash-agent.env). Sets SITE_PASSWORD via the Vercel API — NOT `vercel env add`
#    stdin (that silently stores an empty value), then aliases to $DOMAIN.
TOKEN_FILE="$HOME/.config/vercel-token"
if [ -s "$TOKEN_FILE" ]; then
  VT="$(cat "$TOKEN_FILE")"
  VC="$(command -v vercel || echo "$HOME/.npm-global/bin/vercel")"
  if [ ! -x "$VC" ] && ! command -v vercel >/dev/null 2>&1; then
    echo "⚠️  vercel CLI не найден — пропускаю авто-деплой (подключи репо к Vercel вручную, см. README)."
  else
    echo "=== Vercel auto-deploy ==="
    git push -q 2>&1 | head -3 || echo "(push не прошёл — проверь remote/ключ; деплой может взять старый коммит)"
    DEP_LOG="$(mktemp)"
    timeout 200 "$VC" deploy --prod --yes --token "$VT" > "$DEP_LOG" 2>&1 || true
    URL="$(grep -oE 'https://[a-z0-9-]+\.vercel\.app' "$DEP_LOG" | tail -1)"
    DEPID="$(grep -oE '[A-Za-z0-9_-]+/[A-Za-z0-9]+' "$DEP_LOG" | tail -1 | cut -d/ -f2)"
    echo "deploy url: ${URL:-?}"
    # Set SITE_PASSWORD via the Vercel API (the reliable path).
    if [ -n "$SITE_PASSWORD" ]; then
      PROJECT_ID="$(grep -oE '"projectId":"[^"]+"' "$VAULT/.vercel/project.json" 2>/dev/null | cut -d'"' -f4)"
      if [ -n "$PROJECT_ID" ]; then
        for tgt in production preview; do
          curl -s -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env" \
            -H "Authorization: Bearer $VT" -H "Content-Type: application/json" \
            -d "{\"key\":\"SITE_PASSWORD\",\"value\":\"$SITE_PASSWORD\",\"type\":\"encrypted\",\"target\":[\"$tgt\"]}" \
            >/dev/null 2>&1 || true
        done
        echo "✅ SITE_PASSWORD set via Vercel API (production+preview)"
      else
        echo "⚠️  projectId не найден (.vercel/project.json) — поставь SITE_PASSWORD в дашборде вручную."
      fi
    else
      echo "⚠️  SITE_PASSWORD пуст — выставь его в Vercel env вручную (сайт без пароля = открытая память!)."
    fi
    # Alias the fresh deploy to the requested domain.
    if [ -n "$URL" ] && [ "$DOMAIN" != "your-project.vercel.app" ]; then
      "$VC" alias set "$URL" "$DOMAIN" --token "$VT" 2>&1 | tail -1 || true
    fi
    rm -f "$DEP_LOG"
  fi
else
  # No token: push so a Vercel-connected repo rebuilds; finish with manual instructions.
  git push -q 2>&1 | head -3 || echo "(push не прошёл — проверь remote/ключ)"
fi

echo
echo "✅ Репо готово (Quartz + бренд + граф-фиксы + пароль-гейт)."
echo "   Если авто-деплоя не было — подключи репо к Vercel (детали в README.md):"
echo "   1. vercel.com → Add New → Project → импортируй репо vault"
echo "   2. Framework=Other · Build='npx quartz build -d wiki' · Output=public (уже в vercel.json)"
echo "   3. Env: SITE_PASSWORD=<пароль>  (опц. SITE_USER, по умолч. admin)"
echo "   4. Deploy → открой https://$DOMAIN → логин/пароль → граф + заметки"
