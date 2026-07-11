# Module: vault-web — Obsidian-style web view of the vault (Vercel, password-gated)

Publishes the bot's Obsidian vault (`~/obsidian-vault/wiki/`) as a **read-only web app**
on Vercel — **graph view, rendered notes, backlinks, search, dark mode** (the
Obsidian-desktop feel) — so the owner can open it from the phone. Uses
[Quartz v4](https://github.com/jackyzha0/quartz); no custom app, no Obsidian clone.

`setup.sh` bakes in the **proven "vault-web" design** (the one that's live in
production), not stock Quartz.

## 🔴 Privacy first

The vault is the bot's **private memory** (your facts, people, conversation snippets).
A Vercel URL puts the rendered site on the public internet. So the whole site is gated
with **HTTP Basic Auth** (a password you set) via a free Vercel Routing Middleware
([`middleware.ts`](middleware.ts)) — runs on every route before the cache, returns 401
without the password. The source repo stays **private**. The vault content does transit
Vercel's build/hosting — acceptable for a personal site, but know it.

## Design (baked into setup.sh)

Not stock Quartz — the kit applies a deliberate brand + layout:

- **Fonts:** `Unbounded` (headers) + `Onest` (body) + `JetBrains Mono` (code), via Google
  Fonts. Both Unbounded and Onest cover **Latin + Cyrillic**, so the theme is
  language-agnostic (works for an English or Ukrainian/Russian vault unchanged).
- **Palette:** warm paper background + **amber** accent (`#b45309` light / `#f5b14d` dark).
  Internal links get an amber underline that fills on hover (not Quartz's heavy chip).
- **Graph below content (full width).** The local graph is moved to `afterBody` — a real,
  tall map of connections under the note instead of a cramped sidebar box
  (`localGraph: { depth: -1, scale: 0.7, … }`, height `clamp(300px, 42vh, 440px)`).
- **Own footer.** Replaces Quartz's "Created with Quartz" with
  `<AgentName> · private assistant memory · © <year>`.
- **Homepage** (`wiki/index.md`): a short English map of the vault (Maps / Now / Entities).

Two **graph rendering fixes** are patched into Quartz's `graph.inline.ts` (string-replace,
each guarded so it's idempotent and aborts loudly if Quartz changed the file):

1. **Wait-for-layout** — before reading `graph.offsetWidth`, wait (ResizeObserver, 3s cap)
   until the container has a width. Fixes the graph rendering **blank until you resize** the
   window when it's in `afterBody`.
2. **Center-preserving initial zoom** — extracts the zoom behaviour and applies an initial
   `zoomIdentity.translate(((1-scale)*width)/2, ((1-scale)*height)/2).scale(scale)` so the
   whole graph **fits centered** in the (now wide) container instead of being cropped
   top-left.

Per-owner values (`AGENT_NAME`, `OWNER_NAME`, `VAULT_LOCALE`) come from the inputs
install-core persisted to `~/.cash-agent.env`; `setup.sh` reads them (env overrides win).
`VAULT_LOCALE` defaults to `en-US`.

## How it works

```
bot writes wiki/  ──vault-sync──▶  private GitHub repo (vault)  ──▶  Vercel
                                                                       │ quartz build -d wiki
                                                                       │ middleware.ts = password gate
                                                                       ▼
                                                                graph + notes (auth'd)
```

Every vault push (the bot writing memory) auto-rebuilds the Vercel site → it stays live.
`cleanUrls: true` (in `vercel.json`) drops the `.html` from URLs (`/hot`, not `/hot.html`).

## Setup

**On the server** (vendors Quartz into the vault repo + applies the design + the gate):

```bash
sudo -u claude bash modules/vault-web/setup.sh <your-vercel-domain>
# e.g.  ... setup.sh my-vault.vercel.app   (domain WITHOUT https://)
```

If a Vercel token exists at `~/.config/vercel-token` **and** `SITE_PASSWORD` is set (env or
in `~/.cash-agent.env`), `setup.sh` also **auto-deploys**: `vercel deploy --prod`, sets
`SITE_PASSWORD` in the project via the **Vercel API** (not `vercel env add` stdin — that
silently stores empty), and aliases the deploy to your domain. Otherwise it commits/pushes
and prints the manual Vercel steps below.

### 🔑 CRITICAL: vault git author must match your Vercel account

Vercel rejects deploys whose **commit author email** isn't a verified email on the account,
with the error **`COMMIT_AUTHOR_REQUIRED`**. `setup.sh` therefore sets, in the vault repo:

```bash
git config user.email "<OWNER_EMAIL>"   # ← must be an email verified on your Vercel account
git config user.name  "<OWNER_NAME>"
```

It reads `OWNER_EMAIL` from `~/.cash-agent.env` (onboard.sh collects it). **If `OWNER_EMAIL`
is empty, setup.sh skips this and warns** — your first `vercel deploy` will then fail with
`COMMIT_AUTHOR_REQUIRED` until you set the author by hand in `~/obsidian-vault` and re-commit.

**On Vercel** (your account — one-time, only if you didn't auto-deploy):

1. **vercel.com → Add New → Project →** import your private vault repo.
   Vercel's GitHub App reads private repos it's authorized for.
2. Build settings are already pinned in `vercel.json` (Framework **Other**, Build
   `npx quartz build -d wiki`, Output `public`) — leave them.
3. **Settings → Environment Variables:** add **`SITE_PASSWORD`** = your password
   (Production + Preview). Optional **`SITE_USER`** (default `admin`).
4. **Deploy.** Open the URL → browser asks for login/password → graph + notes.

That's it. The bot writes → repo pushes → Vercel rebuilds → site updates.

## How the owner views it

- Open **`https://<your-vercel-domain>`** on phone or desktop.
- The browser pops a login box: user **`admin`** (or your `SITE_USER`) + your `SITE_PASSWORD`.
- You land on the homepage map → click around, search with `Ctrl/Cmd + K`, scroll to the
  graph under each note. Read-only — the bot writes, you browse.
- The bot also knows the URL (`setup.sh` writes it into `hot.md`, injected every session) —
  just ask in Telegram ("дай ссылку на vault" / "link to my vault") and it replies with it.

## Notes / gotchas

- **Quartz v4, not v5.** Build is `npx quartz build -d wiki` (v5's `quartz plugin install`
  step would fail). `vercel.json` pins the right command.
- **Read-only.** Editing in the browser is a much bigger project — out of scope. The bot
  edits the vault; you view it.
- **Patch anchors.** The two `graph.inline.ts` patches match Quartz v4's vendored source
  exactly (verified). If a future Quartz reshuffles that file, `setup.sh` **aborts loudly**
  with a `FATAL: … ABORT` message rather than producing a half-patched file — re-pin the
  anchor strings if that happens.
- **Build frequency.** Vercel rebuilds on every vault push. For a personal bot that's a
  handful of builds/day — under the free tier. If memory writes get very frequent, switch
  to a debounced deploy hook (not needed by default).
- **Basic-Auth has no "log out"** (browser caches creds for the session) — fine for a
  personal private wiki.
