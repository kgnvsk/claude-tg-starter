import {
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { encodeConversationKey } from "./types";

const TELEGRAM_MESSAGE_LIMIT = 4096;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface TelegramClientOptions {
  fetch?: FetchLike;
  apiBase?: string;
  getUpdatesDeadlineGraceMs?: number;
  deadlines?: {
    sendMessageMs: number;
    getFileMs: number;
    downloadMs: number;
  };
}

export interface TelegramResponseParameters {
  retry_after?: number;
  migrate_to_chat_id?: number;
}

export interface AttachmentDownload {
  path: string;
  created: boolean;
}

export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: TelegramResponseParameters;
}

export class TelegramApiError extends Error {
  readonly status: number;
  readonly errorCode?: number;
  readonly parameters?: TelegramResponseParameters;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    status: number,
    errorCode?: number,
    parameters?: TelegramResponseParameters,
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.errorCode = errorCode;
    this.parameters = parameters;
    this.retryAfterSeconds = parameters?.retry_after;
  }
}

export function isTelegramConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; errorCode?: unknown };
  return candidate.status === 409 || candidate.errorCode === 409;
}

export class TelegramClient {
  private readonly fetch: FetchLike;
  private readonly apiBase: string;
  private readonly getUpdatesDeadlineGraceMs: number;
  private readonly sendMessageDeadlineMs: number;
  private readonly getFileDeadlineMs: number;
  private readonly downloadDeadlineMs: number;

  constructor(
    private readonly token: string,
    options: TelegramClientOptions = {},
  ) {
    if (!token) throw new Error("Telegram bot token is required");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiBase = (options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    this.getUpdatesDeadlineGraceMs = options.getUpdatesDeadlineGraceMs ?? 5_000;
    this.sendMessageDeadlineMs = options.deadlines?.sendMessageMs ?? 15_000;
    this.getFileDeadlineMs = options.deadlines?.getFileMs ?? 15_000;
    this.downloadDeadlineMs = options.deadlines?.downloadMs ?? 60_000;
    for (const deadline of [
      this.sendMessageDeadlineMs,
      this.getFileDeadlineMs,
      this.downloadDeadlineMs,
    ]) {
      if (!Number.isSafeInteger(deadline) || deadline <= 0) {
        throw new Error("Telegram operation deadlines must be positive safe integers");
      }
    }
    if (
      !Number.isSafeInteger(this.getUpdatesDeadlineGraceMs) ||
      this.getUpdatesDeadlineGraceMs <= 0
    ) {
      throw new Error("getUpdates deadline grace must be a positive safe integer");
    }
  }

  async getUpdates(
    offset: number,
    timeout = 50,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("Telegram offset must be a non-negative safe integer");
    }
    if (!Number.isInteger(timeout) || timeout < 0) {
      throw new Error("Telegram long-poll timeout must be a non-negative integer");
    }

    const url = new URL(`${this.apiBase}/bot${this.token}/getUpdates`);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("timeout", String(timeout));
    const deadlineMs = timeout * 1_000 + this.getUpdatesDeadlineGraceMs;
    if (!Number.isSafeInteger(deadlineMs)) {
      throw new Error("Telegram long-poll deadline exceeds safe integer range");
    }
    return withOperationDeadline(
      deadlineMs,
      signal,
      "Telegram getUpdates deadline exceeded",
      (operationSignal) =>
        this.request<unknown[]>(url, { signal: operationSignal }),
    );
  }

  // Bot API sendMessage has no caller-provided idempotency key. Retry policy must
  // therefore live in a durable outbox and accept possible post-send duplicates.
  async sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<void> {
    await withOperationDeadline(
      this.sendMessageDeadlineMs,
      signal,
      "Telegram sendMessage deadline exceeded",
      async (operationSignal) => {
        for (const chunk of splitTelegramMessage(text)) {
          await this.post("sendMessage", { chat_id: chatId, text: chunk }, operationSignal);
        }
      },
    );
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.post("sendChatAction", { chat_id: chatId, action: "typing" });
  }

  async getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile> {
    if (!fileId) throw new Error("Telegram file ID is required");
    return withOperationDeadline(
      this.getFileDeadlineMs,
      signal,
      "Telegram getFile deadline exceeded",
      (operationSignal) =>
        this.post<TelegramFile>("getFile", { file_id: fileId }, operationSignal),
    );
  }

  async downloadAttachment(
    baseDirectory: string,
    conversationKey: string,
    telegramFilePath: string,
    originalFileName?: string,
    attachmentIdentity?: string,
    signal?: AbortSignal,
  ): Promise<AttachmentDownload> {
    return withOperationDeadline(
      this.downloadDeadlineMs,
      signal,
      "Telegram attachment download deadline exceeded",
      async (operationSignal) => {
    if (!isSafeTelegramFilePath(telegramFilePath)) {
      throw new Error("Telegram file path is invalid");
    }
    if (!attachmentIdentity || !/^\d+:/.test(attachmentIdentity)) {
      throw new Error("attachment identity must start with its Telegram update ID");
    }
    const uploadRoot = prepareUploadRoot(baseDirectory, conversationKey);
    const safeName = sanitizeFileName(originalFileName ?? basename(telegramFilePath));
    const updateId = attachmentIdentity.slice(0, attachmentIdentity.indexOf(":"));
    const identityHash = createHash("sha256")
      .update(attachmentIdentity)
      .digest("hex")
      .slice(0, 24);
    const artifactName = buildArtifactName(`${updateId}-${identityHash}-`, safeName);
    const finalPath = join(uploadRoot, artifactName);
    const temporaryPath = join(uploadRoot, `.${artifactName}.part`);
    assertContained(uploadRoot, finalPath);
    assertContained(uploadRoot, temporaryPath);
    if (isRegularFile(finalPath)) return { path: finalPath, created: false };
    await rm(temporaryPath, { force: true });

    const encodedRemotePath = telegramFilePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const response = await this.fetch(
      `${this.apiBase}/file/bot${this.token}/${encodedRemotePath}`,
      { signal: operationSignal },
    );
    if (!response.ok) {
      throw new TelegramApiError(
        `Telegram attachment download failed with HTTP ${response.status}`,
        response.status,
      );
    }

    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(new Uint8Array(await response.arrayBuffer()));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await handle.close();

    try {
      assertUploadRootStillSafe(baseDirectory, conversationKey, uploadRoot);
      await rename(temporaryPath, finalPath);
      return { path: finalPath, created: true };
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
      },
    );
  }

  async removeAttachment(
    baseDirectory: string,
    conversationKey: string,
    attachmentPath: string,
  ): Promise<void> {
    const uploadRoot = prepareUploadRoot(baseDirectory, conversationKey);
    const candidate = resolve(attachmentPath);
    assertContained(uploadRoot, candidate);
    if (dirname(candidate) !== uploadRoot) {
      throw new Error("attachment cleanup path is outside the upload root");
    }
    if (!pathExists(candidate)) return;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("attachment cleanup target is not a regular file");
    }
    assertContained(uploadRoot, realpathSync(candidate));
    await rm(candidate);
  }

  private post<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>(`${this.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  private async request<T>(
    input: string | URL,
    init?: RequestInit,
  ): Promise<T> {
    const response = await this.fetch(input, init);
    let envelope: TelegramEnvelope<T>;
    try {
      envelope = (await response.json()) as TelegramEnvelope<T>;
    } catch {
      throw new TelegramApiError(
        `Telegram API returned invalid JSON with HTTP ${response.status}`,
        response.status,
      );
    }
    if (!response.ok || !envelope.ok) {
      throw new TelegramApiError(
        envelope.description ?? `Telegram API request failed with HTTP ${response.status}`,
        response.status,
        envelope.error_code,
        envelope.parameters,
      );
    }
    if (!("result" in envelope)) {
      throw new TelegramApiError("Telegram API response is missing result", response.status);
    }
    return envelope.result as T;
  }
}

export function splitTelegramMessage(text: string): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function prepareUploadRoot(baseDirectory: string, conversationKey: string): string {
  const encodedConversation = encodeConversationKey(conversationKey);

  const requestedBase = resolve(baseDirectory);
  mkdirSync(requestedBase, { recursive: true, mode: 0o700 });
  const base = realpathSync(requestedBase);
  const workspaces = join(base, "workspaces");
  const workspace = join(workspaces, encodedConversation);
  const uploads = join(workspace, "uploads");
  for (const directory of [workspaces, workspace, uploads]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertDirectoryWithoutSymlink(directory);
    assertContained(base, realpathSync(directory));
  }
  return realpathSync(uploads);
}

function assertUploadRootStillSafe(
  baseDirectory: string,
  conversationKey: string,
  expectedUploadRoot: string,
): void {
  const expected = resolve(expectedUploadRoot);
  const actual = prepareUploadRoot(baseDirectory, conversationKey);
  if (actual !== expected) throw new Error("conversation workspace changed during download");
}

function assertDirectoryWithoutSymlink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error("conversation workspace may not contain symlinks");
  if (!stat.isDirectory()) throw new Error("conversation workspace component is not a directory");
}

function assertContained(root: string, candidate: string): void {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error("attachment path escapes conversation workspace");
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isRegularFile(path: string): boolean {
  if (!pathExists(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("deterministic attachment path is not a regular file");
  }
  return true;
}

function isSafeTelegramFilePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((component) => component !== "" && component !== "." && component !== "..");
}

function sanitizeFileName(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const name = basename(portable)
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[/:]/g, "_")
    .trim();
  if (!name || name === "." || name === "..") return "attachment";
  return name;
}

function buildArtifactName(prefix: string, safeName: string): string {
  // Reserve six bytes for the atomic ".<name>.part" temporary component too.
  const maximumBytes = 234;
  const extension = extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  const prefixBytes = utf8Length(prefix);
  const extensionBudget = Math.max(0, maximumBytes - prefixBytes);
  const safeExtension = truncateUtf8(extension, extensionBudget);
  const stemBudget = Math.max(
    0,
    maximumBytes - prefixBytes - utf8Length(safeExtension),
  );
  const safeStem = truncateUtf8(stem, stemBudget) || truncateUtf8("attachment", stemBudget);
  return `${prefix}${safeStem}${safeExtension}`;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = utf8Length(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function withOperationDeadline<T>(
  milliseconds: number,
  callerSignal: AbortSignal | undefined,
  timeoutMessage: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(callerSignal?.reason ?? new DOMException("aborted", "AbortError"));
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException(timeoutMessage, "TimeoutError")),
    milliseconds,
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
