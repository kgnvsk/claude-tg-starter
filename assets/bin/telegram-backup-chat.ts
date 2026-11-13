import { spawn, execFileSync } from 'node:child_process';
import { constants, lstatSync, openSync, closeSync, readFileSync, fstatSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


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
type Options = { home: string; ownerChatId: string; botToken: string; message: Message; text?: string };
type Result = { ok: boolean; error?: string; text?: string; recoveryKey?: boolean; enable?: boolean; githubLogin?: boolean; nonce?: string };
// A GitHub token is a word of its own: «highs_and_lows.csv» or «laughs_count» is not one.
export const githubSecret = /(?<![A-Za-z0-9_])(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u;
// A backup command is a whole message in the kit's words: «хочу підключити бекап», «…вручну»,
// «увімкни / перевір / повтори бекап», «онови токен бекапу», or their ru/en forms. Any other
// message that mentions a backup, e.g. «зроби бекап таблиці», is ordinary work for the model.
const lead = String.raw`(?:(?:я\s+)?хочу|давай|будь\s+ласка|пожалуйста|chc[eę]|please|i\s+want\s+to)[\s,]+`;
const verb = String.raw`(?:підключ|налашт|увімкн|ввімкн|включ|перевір|повтор|онов|замін|подключ|настро|провер|обнов|замен|pod[łl][aą]cz|w[łl][aą]cz|sprawd|pon[óo]w|skonfiguruj|zaktualizuj|wymie[ńn])\S*|connect|set\s*up|enable|turn\s+on|check|retry|update|renew|replace`;
const noun = String.raw`(?:(?:мені|мне|my|the|a|токен|token)\s+)*(?:(?:авто|auto)\S*\s*)?(?:б[еэ]к[аі]п|backup|резервн\S*\s+коп|kopi\S*\s+zapasow)\S*`;
const tail = String.raw`вручн\S*|manually|через\s+токен|токен\S*|token|(?:(?:на|в|у|через|to|on|via)\s+)?(?:github|гітхаб\S*|гитхаб\S*)|агент\S*|бот\S*|знову|again|будь\s+ласка|пожалуйста|please`;
export const backupCommand = new RegExp(String.raw`^(?:${lead})?(?:${verb})\s+${noun}(?:[\s,]+(?:${tail}))*[\s.,!?]*$`, 'iu');
// The answers a setup step asks for, as agent-backup-chat reads them. Only an explicit cancel
// ends a step («скасуй бекап», «cancel backup»): a bare «стоп» is how the owner stops the agent.
const setup = String.raw`(?:налаштування|підключення|настройк\S*|подключени\S*|setup)`;
const cancelReply = new RegExp(String.raw`^(?:скасу|відмін|отмен|anul|cancel|стоп|stop)\S*\s+(?:${setup}\s+)?${noun}(?:\s+${setup})?[\s.!]*$`, 'iu');
// A GitHub link, or a bare owner/repo with letters and three characters on each side: not «yes/no» or «50/50».
const repositoryReply = /^(?:https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}|(?=[^\/]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{2,38}\/(?=[^\/]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9_.-]{2,99})\/?$/u;
// Only a whole short «saved» confirms the key: a question, a request quoting the phrase or a «not» goes to the
// model (Codex, PR 421: «Как сохранить ключ?», «Напиши «ключ сохранён»» turned the backup on). As agent-backup-chat reads it.
const savedForm = String.raw`(?:збережено|збережений|збережена|зберіг|зберегла|зберегли|сохранил|сохранила|сохранили|сохранено|сохранён|сохранен|сохранена|zapisa(?:[łl](?:em|am|i[śs]my)|ny|na|ne|no)|saved)`;
const keyWord = String.raw`(?:ключ|klucz|the\s+key|key|it)`;
const keySaved = new RegExp(String.raw`^\s*(?:(?:я|i|да|так|tak|yes|ok|окей|ок|уже|вже|już|juz|already)[\s,]+){0,2}(?:${keyWord}\s+${savedForm}|${savedForm}(?:\s+${keyWord})?)\s*[.!]*\s*$`, 'iu');

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
  const logins = new Set<string>();
  const seen = new Set<string>();
  async function handle(o: Options): Promise<boolean> {
    // The receiver passes the words it gives the model: a Telegram 10.1+ rich message has no `text`.
    const m = o.message, text = o.text ?? m.text ?? m.caption ?? '';
    const secret = githubSecret.test(text);
    const owner = /^[1-9]\d*$/.test(o.ownerChatId) && m.chat.type === 'private'
      && String(m.from?.id) === o.ownerChatId && String(m.chat.id) === o.ownerChatId;
    const pending = queues.has(o.home + ':' + o.ownerChatId);
    let phase = '';
    if (owner) {
      try {
        const state = JSON.parse(deps.privateRead(join(o.home, '.local/state/agent-full-backup/chat.json')).toString());
        if (state.owner === o.ownerChatId && state.expires > Date.now() / 1000) phase = String(state.phase ?? '');
      } catch { /* No setup yet. */ }
    }
    // Only a command or the answer the current step asks for belongs to the setup; everything
    // else goes to the model. While a helper call is in flight the next step is not written yet.
    const t = text.trim(), step = (...names: string[]) => pending || names.includes(phase);
    const flow = backupCommand.test(t)
      || (pending || phase !== '') && cancelReply.test(t)
      || step('repository', 'token') && repositoryReply.test(t)
      || step('key', 'ready') && keySaved.test(t);
    if (!secret && (!owner || !flow)) return false;
    const say = (text: string) => deps.api(o.botToken, 'sendMessage', { chat_id: m.chat.id, text });
    const tr = (key: string, ukrainian: string, values?: Record<string, string>) => localized(o.home, key, ukrainian, values);
    let deleted = false;
    if (secret) {
      try { await deps.api(o.botToken, 'deleteMessage', { chat_id: m.chat.id, message_id: m.message_id }); deleted = true; } catch { /* Fail closed: no token storage or model fallback. */ }
      if (!owner || !deleted) {
        if (m.chat.type === 'private') await say(deleted
          ? tr('backup.chat_token_deleted', 'Повідомлення з токеном видалено. Налаштувати бекап може лише власник у своєму особистому чаті.')
          : tr('backup.chat_token_not_deleted', 'Не вдалося видалити повідомлення з токеном. Видали його та відклич токен у GitHub. Токен не передано моделі й не використано.')).catch(() => {});
        return true;
      }
    }
    if (!owner) return true;
    const key = o.home + ':' + o.ownerChatId;
    const id = key + ':' + m.message_id;
    if (seen.has(id)) return true;
    seen.add(id);
    if (seen.size > 2048) seen.delete(seen.values().next().value!);
    // Claim the input immediately. Network/setup work must not block the Telegram poller.
    const task = (queues.get(key) ?? Promise.resolve()).then(async () => {
      if (running.has(key)) { await say(tr('backup.chat_first_running', 'Перша копія ще створюється. Повідомлю результат після перевірки завантаження.')); return; }
      const result = await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, text, deleted });
      async function deliver(result: Result) {
        if (result.error === 'setup-cancelled') return;
        if (!result.ok) {
          const reason = result.error === 'github-login-expired' ? tr('backup.chat_login_expired', 'Час для входу в GitHub минув.')
            : result.error === 'github-cli-missing' ? tr('backup.chat_cli_missing', 'На сервері ще немає GitHub CLI. Потрібне оновлення встановлення.')
            : result.error?.startsWith('github-login') ? tr('backup.chat_login_unfinished', 'Вхід у GitHub не завершено.')
            : result.error === 'github-repository-public' ? tr('backup.chat_public', 'Репозиторій публічний. Обери Private у GitHub.')
            : result.error === 'busy' ? tr('backup.chat_busy', 'Зараз виконується бекап. Спробуй після його завершення.')
            : tr('backup.chat_setup_failed', 'Не вдалося завершити налаштування. Перевір адресу приватного репозиторію та права й строк дії токена.');
          await say(tr('backup.chat_continue', '{reason} Напиши «хочу підключити бекап», щоб продовжити.', { reason }));
          return;
        }
        if (result.githubLogin) {
          if (logins.has(key)) { await say(tr('backup.chat_waiting_login', 'Очікую підтвердження входу на сторінці GitHub.')); return; }
          logins.add(key);
          if (result.text) await say(result.text);
          void deps.run(o.home, 'agent-backup-github-login', [], { owner: o.ownerChatId, nonce: result.nonce }, 660_000,
            event => { if (event.text) void say(event.text).catch(() => {}); },
          ).then(async login => {
            // A login that failed or expired closes its setup: one notice, then the chat is the model's.
            if (!login.ok && login.error !== 'setup-cancelled') await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'login-ended', nonce: result.nonce });
            await deliver(login);
          }).catch(() => {}).finally(() => logins.delete(key));
          return;
        }
        if (result.text) await say(result.text);
        if (result.recoveryKey) {
          const bytes = deps.privateRead(join(o.home, '.local/state/agent-full-backup/recovery-key.txt'));
          const form = new FormData(); form.set('chat_id', o.ownerChatId);
          form.set('document', new Blob([new Uint8Array(bytes)]), 'agent-recovery-key.txt');
          await deps.api(o.botToken, 'sendDocument', form);
          await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'key-delivered' });
        }
        if (result.enable) {
          running.add(key);
          // This script installs the existing schedule and verifies the first upload.
          void deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'wait-context' }).then(ready =>
            ready.ok ? deps.run(o.home, 'agent-full-backup', ['enable'], undefined, 24 * 3600_000) : ready,
          ).then(async completed => {
            await deps.run(o.home, 'agent-backup-chat', [], { owner: o.ownerChatId, operation: 'finished' });
            await say(completed.ok
              ? tr('backup.chat_done', 'Готово: першу копію завантажено й перевірено. Далі автобекап працює раз на добу о 22:00 за часом Лісабона й зберігає 14 останніх копій у приватному репозиторії. Ключі доступу до сервісів не входять у копію.')
              : tr('backup.chat_unconfirmed', 'Першу копію не підтверджено. Налаштування збережено. Напиши «перевір бекап» — перевіримо стан.'));
          }).catch(() => {}).finally(() => running.delete(key));
        }
      }
      await deliver(result);
    }).catch(async () => { await say(tr('backup.chat_continue', '{reason} Напиши «хочу підключити бекап», щоб продовжити.', { reason: tr('backup.chat_unfinished', 'Налаштування не завершено.') })).catch(() => {}); })
      .finally(() => { if (queues.get(key) === task) queues.delete(key); });
    queues.set(key, task);
    return true;
  }
  return { handle, idle: () => Promise.all([...queues.values()]) };
}

const chat = createBackupChat();
export const handleBackupMessage = chat.handle;
