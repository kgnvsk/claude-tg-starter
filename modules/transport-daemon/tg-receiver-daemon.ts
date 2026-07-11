// tg-receiver-daemon.ts — OWNS the Telegram getUpdates consumer (receive-only).
//
// Runs as a lingered systemd-USER service, independent of the claude session, so the
// bot NEVER goes deaf when the claude/plugin process dies (orphan-watchdog, nested-claude
// SIGTERM, network blip — none reach this process). Each update is written durably to a
// filesystem inbox; the telegram plugin (in TG_TRANSPORT=daemon mode) drains that inbox
// via bot.handleUpdate, so ALL existing handlers/tools/sending stay unchanged.
//
// Pure bun: only `fetch` (getUpdates / sendMessage), `fs`, `child_process` — NO grammy,
// NO node_modules. A tiny, dependency-free process is the most robust thing to keep alive.
//
// Filesystem queue (no Redis/extra deps — both sides already have `fs`):
//   inbox:  $BASE/daemon-inbox/<update_id>.json   (raw Telegram Update, written atomically)
//   offset: $BASE/daemon-offset                    (last confirmed update_id)
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'

const TOKEN = process.env.TELEGRAM_BOT_TOKEN
if (!TOKEN) {
  process.stderr.write('tg-receiver-daemon: FATAL TELEGRAM_BOT_TOKEN not set\n')
  process.exit(1)
}

const API = `https://api.telegram.org/bot${TOKEN}`
const BASE = process.env.TG_DAEMON_BASE
  || join(process.env.HOME || '/home/claude', '.claude/channels/telegram')
const INBOX = join(BASE, 'daemon-inbox')
const OFFSET_FILE = join(BASE, 'daemon-offset')
mkdirSync(INBOX, { recursive: true })

function loadOffset(): number {
  try { return parseInt(readFileSync(OFFSET_FILE, 'utf8').trim(), 10) || 0 } catch { return 0 }
}
function saveOffset(o: number): void {
  const tmp = OFFSET_FILE + '.tmp'
  writeFileSync(tmp, String(o))
  renameSync(tmp, OFFSET_FILE)
}
function enqueue(update: { update_id: number }): void {
  // atomic: write tmp then rename, so the draining plugin never reads a half-written file
  const dst = join(INBOX, `${update.update_id}.json`)
  const tmp = dst + '.tmp'
  writeFileSync(tmp, JSON.stringify(update))
  renameSync(tmp, dst)
}

// Raw Bot API over fetch. GET for getUpdates (long-poll), POST for sendMessage. The 60s
// AbortSignal is just above Telegram's 50s long-poll hold, so a healthy poll never aborts.
async function tg(method: string, body?: Record<string, unknown>): Promise<any> {
  const init: RequestInit = { signal: AbortSignal.timeout(60000) }
  if (body) {
    init.method = 'POST'
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const r = await fetch(`${API}/${method}`, init)
  return r.json()
}

// ---- admin commands (owner-only) — work EVEN WHEN claude is dead, because the daemon is
// the SOLE process still polling Telegram. Authorized by access.json allowFrom (owner DM).
// Handled here and NOT forwarded to claude; everything else is enqueued as normal.
function loadAdmins(): string[] {
  try {
    const a = JSON.parse(readFileSync(join(BASE, 'access.json'), 'utf8'))
    return (a.allowFrom || []).map((x: unknown) => String(x))
  } catch { return [] }
}
function reply(chatId: number | string, text: string): void {
  void tg('sendMessage', { chat_id: chatId, text }).catch(() => {})
}
function run(cmd: string, args: string[], timeoutMs = 45000): Promise<{ out: string; err: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ out: (stdout || '').trim(), err: (stderr || '').trim() || (e ? String(e) : '') })
    })
  })
}
function sh(cmd: string, args: string[]): Promise<string> {
  return run(cmd, args).then(r => (r.out + (r.err ? '\n' + r.err : '')).trim() || 'ok')
}
async function handleAdmin(update: { message?: { text?: string; chat?: { id?: number } } }): Promise<boolean> {
  const msg = update.message
  if (!msg || typeof msg.text !== 'string' || msg.chat?.id == null) return false
  if (!loadAdmins().includes(String(msg.chat.id))) return false   // owner-only — others fall through to claude
  const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@\S+$/, '')
  if (cmd === '/restart') {
    reply(msg.chat.id, '♻️ Перезапускаю бота…')
    await sh('sudo', ['systemctl', 'restart', 'claude-telegram.service'])
    reply(msg.chat.id, '✅ claude-telegram перезапущен.')
    return true
  }
  if (cmd === '/doctor') {
    const out = await sh(join(process.env.HOME || '/home/claude', 'bin/cash-doctor'), [])
    reply(msg.chat.id, out.slice(0, 3500) || 'doctor: нет вывода')
    return true
  }
  if (cmd === '/fix') {
    reply(msg.chat.id, '🔧 Лечу (golden-restore + рестарт)…')
    const out = await sh(join(process.env.HOME || '/home/claude', 'bin/cash-fix'), [])
    reply(msg.chat.id, out.slice(0, 3500) || 'fix: нет вывода')
    return true
  }
  return false
}

// ---- /download fast-path (no claude): the daemon downloads + sends the video itself, like
// a dumb downloader (smmparsebot-style). The LLM is touched ONLY if the owner taps the
// inline "analyze" button, which injects a synthetic message into the inbox.
const HOME = process.env.HOME || '/home/claude'

function answerCb(id: string, text?: string): void {
  void tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {})
}

// Upload a local mp4 as a playable video + inline "analyze" button. Multipart (FormData)
// because the file is on disk — tg() only sends JSON.
async function sendVideoFile(chatId: number | string, filePath: string, analyzeId: string): Promise<boolean> {
  try {
    const fd = new FormData()
    fd.set('chat_id', String(chatId))
    fd.set('supports_streaming', 'true')
    fd.set('reply_markup', JSON.stringify({
      inline_keyboard: [[{ text: '🔍 Проаналізувати це відео', callback_data: `a:${analyzeId}` }]],
    }))
    fd.set('video', new Blob([readFileSync(filePath)], { type: 'video/mp4' }), filePath.split('/').pop() || 'v.mp4')
    const r = await fetch(`${API}/sendVideo`, { method: 'POST', body: fd, signal: AbortSignal.timeout(180000) })
    return !!(await r.json()).ok
  } catch { return false }
}

// Inject a synthetic owner message into the inbox — the claude session drains it like a real
// Telegram message (drain deletes after processing, no offset tracking → safe).
function enqueueMessage(chatId: number, fromId: number, text: string): void {
  const uid = Date.now()   // unique; sorts after real (~1e9) ids, never collides
  enqueue({
    update_id: uid,
    message: { message_id: uid % 1_000_000_000, date: Math.floor(uid / 1000),
      chat: { id: chatId, type: 'private' }, from: { id: fromId, is_bot: false, first_name: 'owner' }, text },
  } as { update_id: number })
}

async function handleDownload(update: { message?: { text?: string; chat?: { id?: number } } }): Promise<boolean> {
  const msg = update.message
  if (!msg || typeof msg.text !== 'string' || msg.chat?.id == null) return false
  const cmd = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@\S+$/, '')
  if (cmd !== '/download' && cmd !== '/dl') return false
  if (!loadAdmins().includes(String(msg.chat.id))) return false   // owner-only
  const url = msg.text.trim().replace(/^\S+\s*/, '').trim()
  if (!/^https?:\/\//.test(url)) { reply(msg.chat.id, 'Пришли так: /download <ссылка на видео>'); return true }
  reply(msg.chat.id, '🔄 Качаю…')
  const { out, err } = await run(join(HOME, 'bin/media-dl'), [url], 150000)
  const path = out.split('\n').map(s => s.trim()).filter(Boolean).pop() || ''
  if (!/^\/.+\.mp4$/.test(path)) { reply(msg.chat.id, `❌ Не вышло: ${(err || out).slice(-300)}`); return true }
  const id = path.replace(/^.*\/dl-/, '').replace(/\.mp4$/, '')
  if (!(await sendVideoFile(msg.chat.id, path, id)))
    reply(msg.chat.id, `⚠️ Скачал, но не смог отправить (возможно >50 МБ). Файл на сервере: ${path}`)
  return true
}

// Inline "analyze" button tap → hand the downloaded video to the LLM (only now).
async function handleCallback(update: { callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } }; from?: { id?: number } } }): Promise<boolean> {
  const cq = update.callback_query
  if (!cq || typeof cq.data !== 'string' || !cq.data.startsWith('a:')) return false
  const chatId = cq.message?.chat?.id
  if (chatId == null || !loadAdmins().includes(String(chatId))) { answerCb(cq.id); return true }
  answerCb(cq.id, '🔍 Передаю агенту на разбор…')
  enqueueMessage(chatId, cq.from?.id ?? chatId, `Проанализируй это видео: /tmp/dl-${cq.data.slice(2)}.mp4`)
  return true
}

let shuttingDown = false
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { shuttingDown = true })
}

void (async () => {
  let offset = loadOffset()
  process.stderr.write(`tg-receiver-daemon: started at offset ${offset}\n`)
  // Own the Telegram command menu: in daemon mode the plugin's bot.start() never
  // fires, so its setMyCommands never runs and the menu shows stale defaults. Set
  // the real commands here (same scope the plugin used, to override them).
  void tg('setMyCommands', {
    commands: [
      { command: 'restart', description: 'Перезапустить бота' },
      { command: 'doctor', description: 'Проверка состояния' },
      { command: 'fix', description: 'Починить (golden + рестарт + отчёт)' },
      { command: 'research', description: 'Ресёрч по теме (допиши «deep» — в фоне, ссылкой)' },
      { command: 'download', description: 'Скачать видео по ссылке (мгновенно, без анализа)' },
    ],
    scope: { type: 'all_private_chats' },
  }).catch(() => {})
  while (!shuttingDown) {
    try {
      const j = await tg(`getUpdates?offset=${offset}&timeout=50`)
      if (!j.ok) throw Object.assign(new Error(j.description || 'getUpdates failed'), { error_code: j.error_code })
      for (const u of j.result as Array<{ update_id: number }>) {
        // owner fast-paths handled HERE (no claude): analyze-button, /download, admin cmds.
        const handled = await handleCallback(u) || await handleDownload(u) || await handleAdmin(u)
        if (!handled) enqueue(u)   // everything else → durable inbox for the claude session
        offset = u.update_id + 1
      }
      if (j.result.length) saveOffset(offset)
    } catch (err) {
      const is409 = (err as { error_code?: number })?.error_code === 409
      const delay = is409 ? 3000 : 2000
      process.stderr.write(`tg-receiver-daemon: getUpdates ${is409 ? '409 conflict (another poller?)' : 'error: ' + err}, retry in ${delay}ms\n`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  process.stderr.write('tg-receiver-daemon: shutting down\n')
})()
