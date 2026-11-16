import { spawn, execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'bun:sqlite';


function telegramApiBase(): string {
  const home = process.env.HOME || homedir()
  const helper = join(home, 'bin/telegram-api')
  if (existsSync(helper)) return execFileSync('python3', [helper, 'base'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let configured = process.env.TELEGRAM_API_BASE || ''
  if (!configured) {
    try { configured = /^(?:export\s+)?TELEGRAM_API_BASE\s*=(.*)$/m.exec(readFileSync(join(process.env.TELEGRAM_STATE_DIR || join(home, '.claude/channels/telegram'), '.env'), 'utf8'))?.[1]?.trim() || '' } catch {}
  }
  if (configured && configured !== 'https://api.telegram.org') throw new Error('Telegram local API helper unavailable; no cloud fallback')
  return 'https://api.telegram.org'
}

// The owner's notice language (OWNER_NOTICE_LOCALE) from the kit's one catalog, next to this file;
// Ukrainian when the profile sets none or anything fails (owner, 02.11.2026: Brodsky fully in Russian).
const catalog = join(dirname(fileURLToPath(import.meta.url)), 'agent_notice_locale.py');
function localized(home: string, key: string, ukrainian: string, values: Record<string, string> = {}): string {
  let text = ukrainian;
  try {
    text = execFileSync('python3', [catalog, home, key, ukrainian], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) || ukrainian;
  } catch { /* The Ukrainian copy stays. */ }
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => Object.hasOwn(values, name) ? values[name]! : whole);
}

type Message = { message_id: number; text?: string; caption?: string; from?: { id: number }; chat: { id: number; type: string } };
type Owner = { home: string; ownerChatId: string; botToken: string };
type Options = Owner & { message: Message; text?: string; quoted?: boolean };
type Result = { ok: boolean; error?: string; text?: string; recoveryKey?: boolean; enable?: boolean; githubLogin?: boolean; nonce?: string };
// A GitHub token is a word of its own: «highs_and_lows.csv» or «laughs_count» is not one.
export const githubSecret = /(?<![A-Za-z0-9_])(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u;
// Owner, 13.11.2026: «Агент должен понимать по контексту смысл и сам вызывать эту команду. Что это за поиск по
// ключевым словам… Это агент или терминал». No phrase list decides the setup any more: the agent understands the
// owner in any words and calls the backup_setup tool with one of these steps. Only a pasted GitHub token is taken
// away before the model, because a secret must never reach it.
export const backupActions = ['connect', 'reconnect', 'connect-manually', 'repository', 'key-saved', 'run', 'cancel'] as const;

// The same check as currentOwnerPrivateRequest in modules/telegram-corporate/chat-policy.ts, kept here because the
// backup setup exists without the corporate module: deliveryId must be the owner's own open request in his private
// chat, in a turn that holds only his words (no forward, no other person).
export function ownerPrivateRequest(db: Database, ownerId: string, stamp: string | null, deliveryId: string): boolean {
  if (!stamp || !/^[1-9]\d{0,19}$/.test(ownerId) || !deliveryId) return false;
  try {
    const row = db.query(`SELECT r.chat_id, r.thread_id, r.request_payload, r.turn_id, t.turn_id AS current_turn FROM delivery_results r
      JOIN delivery_sessions s ON s.session_id=r.session_id AND s.stamp=r.stamp
      JOIN delivery_turns t ON t.turn_id=coalesce(r.response_turn_id,r.turn_id) AND t.session_id=r.session_id
      JOIN delivery_turn_messages m ON m.turn_id=r.turn_id AND m.delivery_id=r.delivery_id
      WHERE r.delivery_id=? AND r.stamp=? AND r.state IN ('pending','deferred') AND t.closed_at IS NULL`)
      .get(deliveryId, stamp) as { chat_id: string; thread_id: string | null; request_payload: string; turn_id: number; current_turn: number } | null;
    if (!row || row.chat_id !== ownerId || row.thread_id != null) return false;
    const turns = db.query(`SELECT r.request_payload FROM delivery_turn_messages m
      LEFT JOIN delivery_results r ON r.delivery_id=m.delivery_id WHERE m.turn_id IN (?,?)`)
      .all(row.turn_id, row.current_turn) as Array<{ request_payload: string | null }>;
    const own = (payload: string | null) => {
      const meta = JSON.parse(payload ?? 'null')?.params?.meta;
      return meta?.user_id === ownerId && meta.forward_from == null && meta.sender_chat_id == null;
    };
    if (!turns.length || !turns.every(turn => own(turn.request_payload))) return false;
    const meta = JSON.parse(row.request_payload)?.params?.meta;
    if (!meta || meta.user_id !== ownerId || meta.chat_id !== ownerId || meta.delivery_id !== deliveryId
      || meta.forward_from != null || meta.sender_chat_id != null || meta.thread_id != null) return false;
    const messageId = Number(meta.message_id);
    return Number.isSafeInteger(messageId) && messageId > 0;
  } catch { return false; }
}

function privateRead(path: string): Buffer {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    if (lstatSync(parent).isSymbolicLink()) throw new Error('private-path-unsafe');
    if (dirname(parent) === parent) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || (st.mode & 0o077) || st.uid !== process.getuid?.() || st.size > 131072) throw new Error('private-file-unsafe');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function run(home: string, name: string, args: string[], value?: unknown, timeout = 180_000, progress?: (value: Result) => void): Promise<Result> {
  return new Promise((resolve) => {
    // No shell, credential argv, credential environment, or raw child diagnostics.
    const child = spawn('python3', [join(home, 'bin', name), '--home', home, ...args], {
      cwd: home, env: { HOME: home, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONNOUSERSITE: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '', final: Result | undefined, ended = false;
    const finish = (value: Result) => { if (!ended) { ended = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish({ ok: false, error: 'setup-timeout' }); }, timeout);
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      output += data.toString();
      if (output.length > 131072) { child.kill(); finish({ ok: false }); return; }
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.progress === true) progress?.(event);
          else final = event;
        } catch { /* Raw subprocess output is never forwarded. */ }
      }
    });
    child.on('error', () => finish({ ok: false, error: 'helper-unavailable' }));
    child.on('close', () => { try { finish(final ?? JSON.parse(output)); } catch { finish({ ok: false }); } });
    child.stdin.end(value === undefined ? undefined : JSON.stringify(value));
  });
}

async function api(token: string, method: string, body: object | FormData): Promise<any> {
  const response = await fetch(telegramApiBase() + '/bot' + token + '/' + method, {
    method: 'POST', signal: AbortSignal.timeout(20_000),
    ...(body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json() as { ok?: boolean; result?: unknown };
  if (!response.ok || result.ok !== true) throw new Error('telegram-unconfirmed');
  return result.result;
}

export function createBackupChat(deps = { run, api, privateRead }) {
  const queues = new Map<string, Promise<void>>();
  const running = new Set<string>();
  // The nonce of the GitHub sign-in running for each owner: a newer setup gets its own sign-in.
  const logins = new Map<string, string>();
  const seen = new Set<string>();
  const words = (o: Owner) => ({
    say: (text: string) => deps.api(o.botToken, 'sendMessage', { chat_id: Number(o.ownerChatId), text }),
    tr: (key: string, ukrainian: string, values?: Record<string, string>) => localized(o.home, key, ukrainian, values),
  });
  // One owner's steps run one at a time, in order; a helper call never blocks the Telegram poller.
  function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const task = (queues.get(key) ?? Promise.resolve()).then(work);
    const settled = task.then(() => {}, () => {});
    queues.set(key, settled);
    void settled.finally(() => { if (queues.get(key) === settled) queues.delete(key); });
    return task;
  }
  function reason(o: Owner, error?: string): string {
    const { tr } = words(o);
    return error === 'github-login-expired' ? tr('backup.chat_login_expired', 'Час для входу в GitHub минув.')
      : error === 'github-cli-missing' ? tr('backup.chat_cli_missing', 'На сервері ще немає GitHub CLI. Потрібне оновлення встановлення.')
      : error?.startsWith('github-login') ? tr('backup.chat_login_unfinished', 'Вхід у GitHub не завершено.')
      : error === 'github-repository-public' ? tr('backup.chat_public', 'Репозиторій публічний. Обери Private у GitHub.')
      : error === 'busy' ? tr('backup.chat_busy', 'Зараз виконується бекап. Спробуй після його завершення.')
      : error === 'repository-invalid' ? tr('backup.chat_repository_needed', 'Потрібне посилання на приватний репозиторій GitHub з README, наприклад https://github.com/логін/my-agent-backup.')
      : tr('backup.chat_setup_failed', 'Не вдалося завершити налаштування. Перевір адресу приватного репозиторію та права й строк дії токена.');
  }
  // What a step starts besides its words: the GitHub sign-in, the recovery key file, the first copy. The sign-in
  // link with its code and the key file go to the owner from here, never through the model.
  async function follow(o: Owner, result: Result, current = () => true): Promise<void> {
    const key = o.home + ':' + o.ownerChatId, { say, tr } = words(o);
    if (result.githubLogin) {
      const nonce = result.nonce ?? '', mine = () => logins.get(key) === nonce;
      logins.set(key, nonce);
      // The one-time code is the owner's only way in: a failed send is tried again, while the sign-in is still his.
      const code = async (text: string) => {
        for (let attempt = 0; attempt < 3 && mine(); attempt++) {
          try { await say(text); return; } catch { await new Promise(resolve => setTimeout(resolve, 2000)); }
        }
        // Refused three times: close this sign-in (its helper sees its nonce gone and stops), so the owner's next
        // request starts a fresh one instead of waiting ten minutes for a code he never got. If it cannot be closed,
        // it runs on and ends by itself: one code never gets two sign-ins.
        for (let attempt = 0; attempt < 3 && mine(); attempt++) {
          const ended = await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'login-ended', nonce: result.nonce }).catch(() => ({ ok: false }));
          if (ended.ok) { if (mine()) logins.delete(key); return; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      };
      void deps.run(o.home, 'agent-backup-github-login', [], { owner: o.ownerChatId, nonce: result.nonce }, 660_000,
        event => { if (event.text && mine()) void code(event.text); },
      ).then(async login => {
        // Codex 13.11: a sign-in the owner closed or replaced meanwhile sends no code, key or first copy.
        if (!mine()) return;
        // A login that failed or expired closes its setup: one notice, then the chat is the model's.
        if (!login.ok && login.error !== 'setup-cancelled') await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'login-ended', nonce: result.nonce });
        if (mine()) await later(o, login, mine);
      }).catch(() => {}).finally(() => { if (mine()) logins.delete(key); });
      return;
    }
    if (!current()) return;
    if (result.recoveryKey) {
      const bytes = deps.privateRead(join(o.home, '.local/state/agent-full-backup/recovery-key.txt'));
      const form = new FormData(); form.set('chat_id', o.ownerChatId);
      form.set('document', new Blob([new Uint8Array(bytes)]), 'agent-recovery-key.txt');
      await deps.api(o.botToken, 'sendDocument', form);
      if (!current()) return;
      await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'key-delivered' });
    }
    if (result.enable && current()) {
      running.add(key);
      // This script installs the existing schedule and verifies the first upload.
      void deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'wait-context' }).then(ready =>
        ready.ok ? deps.run(o.home, 'agent-full-backup', ['enable'], undefined, 24 * 3600_000) : ready,
      ).then(async completed => {
        const finished = await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'finished' });
        await say(completed.ok && finished.ok
          ? tr('backup.chat_done', 'Готово: першу копію завантажено й перевірено. Далі автобекап працює раз на добу о 22:00 за часом Лісабона й зберігає 14 останніх копій у приватному репозиторії. Ключі доступу до сервісів не входять у копію.')
          : tr('backup.chat_unconfirmed', 'Першу копію не підтверджено. Налаштування збережено. Попроси мене перевірити бекап — подивлюся, що з ним.'));
      }).catch(() => {}).finally(() => running.delete(key));
    }
  }
  // A result with no agent turn to carry it (the GitHub sign-in ended, a pasted token was used): its words go to the owner.
  async function later(o: Owner, result: Result, current = () => true): Promise<void> {
    const { say, tr } = words(o);
    if (result.error === 'setup-cancelled') return;
    if (!result.ok) { await say(tr('backup.chat_continue', '{reason} Щоб продовжити, просто скажи мені.', { reason: reason(o, result.error) })); return; }
    if (result.text) await say(result.text);
    await follow(o, result, current);
  }
  // A step the agent chose after understanding the owner. Its words come back for the agent to answer him with.
  async function act(o: Owner & { action: string; repository?: string }): Promise<Result> {
    const key = o.home + ':' + o.ownerChatId, { tr } = words(o);
    if (!/^[1-9]\d*$/.test(o.ownerChatId) || !(backupActions as readonly string[]).includes(o.action)) return { ok: false, error: 'invalid-request' };
    return enqueue(key, async () => {
      if (running.has(key)) return { ok: true, text: tr('backup.chat_first_running', 'Перша копія ще створюється. Повідомлю результат після перевірки завантаження.') };
      // These steps close a pending sign-in: from now on it no longer speaks to the owner, even mid-delivery.
      // If the step itself fails, the sign-in is still his and gets its voice back.
      const pending = logins.get(key), closing = ['cancel', 'connect-manually', 'repository'].includes(o.action);
      if (closing) logins.delete(key);
      const result = await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: o.action, ...(o.repository === undefined ? {} : { repository: o.repository }) });
      if (!result.ok) {
        if (closing && pending !== undefined && !logins.has(key)) logins.set(key, pending);
        return { ok: false, error: result.error, text: reason(o, result.error) };
      }
      // A sign-in already waiting on GitHub is not started twice.
      if (!(result.githubLogin && logins.get(key) === (result.nonce ?? ''))) await follow(o, result);
      return { ok: true, text: result.text };
    }).catch(() => ({ ok: false, error: 'setup-failed', text: tr('backup.chat_unfinished', 'Налаштування не завершено.') }));
  }
  // Only a message that carries a GitHub token stops here: it is deleted before the model sees it.
  async function handle(o: Options): Promise<boolean> {
    // The receiver passes the words it gives the model: a Telegram 10.1+ rich message has no `text`.
    const m = o.message, text = o.text ?? m.text ?? m.caption ?? '';
    if (!githubSecret.test(text)) return false;
    const owner = /^[1-9]\d*$/.test(o.ownerChatId) && m.chat.type === 'private'
      && String(m.from?.id) === o.ownerChatId && String(m.chat.id) === o.ownerChatId;
    const { say, tr } = words(o);
    let deleted = false;
    try { await deps.api(o.botToken, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }); deleted = true; } catch { /* Fail closed: no token storage or model fallback. */ }
    // A forward or an edit is a quote, not the owner handing over his token: it is only taken away.
    if (!owner || !deleted || o.quoted) {
      if (m.chat.type === 'private' && !(owner && deleted)) await deps.api(o.botToken, 'sendMessage', { chat_id: m.chat.id, text: deleted
        ? tr('backup.chat_token_deleted', 'Повідомлення з токеном видалено. Налаштувати бекап може лише власник у своєму особистому чаті.')
        : tr('backup.chat_token_not_deleted', 'Не вдалося видалити повідомлення з токеном. Видали його та відклич токен у GitHub. Токен не передано моделі й не використано.') }).catch(() => {});
      return true;
    }
    const key = o.home + ':' + o.ownerChatId;
    const id = key + ':' + m.message_id;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 2048) seen.delete(seen.values().next().value!);
    // Claim the input immediately. Network/setup work must not block the Telegram poller.
    void enqueue(key, async () => {
      try {
        if (running.has(key)) { await say(tr('backup.chat_first_running', 'Перша копія ще створюється. Повідомлю результат після перевірки завантаження.')); return; }
        await later(o, await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, text, deleted }));
      } catch {
        await say(tr('backup.chat_continue', '{reason} Щоб продовжити, просто скажи мені.', { reason: tr('backup.chat_unfinished', 'Налаштування не завершено.') })).catch(() => {});
      }
    });
    return true;
  }
  return { handle, act, idle: () => Promise.all([...queues.values()]) };
}

const chat = createBackupChat();
export const handleBackupMessage = chat.handle;
export const backupAction = chat.act;
