import { AdminController, type AdminStore, type EmergencyControls } from "./admin";
import { resolveIdentity } from "./policy";
import { TelegramApiError, splitTelegramMessage } from "./telegram";
import type {
  AcceptedIdentity,
  AttachmentIngressContext,
  IdentityLookup,
  MultiUserConfig,
  NormalizedAttachment,
  NormalizedMessage,
  NormalizedUpdate,
  StoredOutboundReply,
} from "./types";

const OFFSET_SETTING = "telegram_offset";
const ATTACHMENT_INGRESS_STALE_MS = 120_000;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 90_000;

interface TelegramIngress {
  getUpdates(
    offset: number,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<unknown[]>;
  sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<unknown>;
  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string }>;
  downloadAttachment(
    baseDirectory: string,
    conversationKey: string,
    telegramFilePath: string,
    originalFileName?: string,
    attachmentIdentity?: string,
    signal?: AbortSignal,
  ): Promise<{ path: string; created: boolean }>;
  removeAttachment(
    baseDirectory: string,
    conversationKey: string,
    attachmentPath: string,
  ): Promise<void>;
}

interface ReceiverStore extends AdminStore {
  lookupIdentity: IdentityLookup;
  hasUpdate(updateId: number): boolean;
  recordTerminalUpdate(
    updateId: number,
    state: "ignored" | "rejected",
    payload: unknown,
  ): boolean;
  recordRejectedUpdateWithReply(
    updateId: number,
    payload: unknown,
    chatId: number,
    text: string,
  ): boolean;
  claimOutboundReply(
    leaseOwner: string,
    now: number,
    leaseMs: number,
    maxAttempts: number,
  ): StoredOutboundReply | null;
  markOutboundReplyDelivered(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    now: number,
  ): boolean;
  advanceOutboundReplyChunk(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    nextChunkIndex: number,
    now: number,
  ): boolean;
  renewOutboundReplyLease(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    now: number,
    leaseMs: number,
  ): boolean;
  failOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now: number,
  ): boolean;
  releaseOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now: number,
  ): boolean;
  retryOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
    now: number,
  ): boolean;
  claimAttachmentIngress(
    conversationKey: string,
    now: number,
    claimTimeoutMs: number,
  ): string | null;
  recoverStaleAttachmentIngress?(
    conversationKey: string,
    now: number,
    claimTimeoutMs: number,
  ): boolean;
  releaseAttachmentIngress(conversationKey: string, token: string, now: number): boolean;
  acceptUpdate(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    now?: number,
    ingress?: AttachmentIngressContext,
  ): boolean;
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

interface ReceiverOptions {
  telegram: TelegramIngress;
  store: ReceiverStore;
  config: MultiUserConfig;
  baseDirectory: string;
  longPollSeconds?: number;
  backoff?: { initialMs: number; maxMs: number };
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onPollError?: (error: unknown, conflict: boolean, retryInMs: number) => void;
  clock?: () => number;
  outbound?: {
    leaseOwner: string;
    leaseMs: number;
    sendTimeoutMs?: number;
    maxAttempts: number;
    initialBackoffMs: number;
    maxBackoffMs: number;
  };
  emergency?: EmergencyControls;
}

interface RawFile {
  file_id?: unknown;
  file_name?: unknown;
  mime_type?: unknown;
  file_size?: unknown;
}

export class Receiver {
  private readonly telegram: TelegramIngress;
  private readonly store: ReceiverStore;
  private readonly config: MultiUserConfig;
  private readonly baseDirectory: string;
  private readonly longPollSeconds: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly onPollError?: ReceiverOptions["onPollError"];
  private readonly clock: () => number;
  private readonly outboundLeaseOwner: string;
  private readonly outboundLeaseMs: number;
  private readonly outboundSendTimeoutMs: number;
  private readonly outboundMaxAttempts: number;
  private readonly outboundInitialBackoffMs: number;
  private readonly outboundMaxBackoffMs: number;
  private readonly admin: AdminController;

  constructor(options: ReceiverOptions) {
    this.telegram = options.telegram;
    this.store = options.store;
    this.config = options.config;
    this.baseDirectory = options.baseDirectory;
    this.longPollSeconds = options.longPollSeconds ?? 50;
    this.initialBackoffMs = options.backoff?.initialMs ?? 1_000;
    this.maxBackoffMs = options.backoff?.maxMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.onPollError = options.onPollError;
    this.clock = options.clock ?? Date.now;
    this.outboundLeaseOwner =
      options.outbound?.leaseOwner ?? `receiver-${crypto.randomUUID()}`;
    this.outboundLeaseMs = options.outbound?.leaseMs ?? 30_000;
    this.outboundSendTimeoutMs =
      options.outbound?.sendTimeoutMs ?? Math.min(10_000, this.outboundLeaseMs - 1);
    this.outboundMaxAttempts = options.outbound?.maxAttempts ?? 5;
    this.outboundInitialBackoffMs = options.outbound?.initialBackoffMs ?? 1_000;
    this.outboundMaxBackoffMs = options.outbound?.maxBackoffMs ?? 60_000;
    this.admin = new AdminController({
      store: this.store,
      adminIds: this.config.adminChatIds,
      emergency: options.emergency,
      clock: this.clock,
    });
    if (this.initialBackoffMs <= 0 || this.maxBackoffMs < this.initialBackoffMs) {
      throw new Error("receiver backoff must be positive and bounded");
    }
    if (
      !this.outboundLeaseOwner ||
      !Number.isSafeInteger(this.outboundLeaseMs) ||
      this.outboundLeaseMs <= 0 ||
      !Number.isSafeInteger(this.outboundSendTimeoutMs) ||
      this.outboundSendTimeoutMs <= 0 ||
      this.outboundSendTimeoutMs >= this.outboundLeaseMs ||
      !Number.isSafeInteger(this.outboundMaxAttempts) ||
      this.outboundMaxAttempts <= 0 ||
      !Number.isSafeInteger(this.outboundInitialBackoffMs) ||
      this.outboundInitialBackoffMs <= 0 ||
      this.outboundMaxBackoffMs < this.outboundInitialBackoffMs
    ) {
      throw new Error("outbound reply retry settings are invalid");
    }
  }

  async processUpdate(
    rawUpdate: unknown,
    signal?: AbortSignal,
  ): Promise<"accepted" | "duplicate" | "rejected" | "ignored"> {
    const updateId = readSafeInteger(asRecord(rawUpdate)?.update_id);
    if (updateId === null) return "ignored";
    if (this.store.hasUpdate(updateId)) return "duplicate";

    const update = normalizeTelegramUpdate(rawUpdate);
    if (!update) {
      return this.store.recordTerminalUpdate(updateId, "ignored", rawUpdate)
        ? "ignored"
        : "duplicate";
    }

    const storedAccessMode = this.store.getSetting("guest_access_mode");
    const guestAccessMode = storedAccessMode === "public" || storedAccessMode === "invite"
      ? storedAccessMode
      : this.config.guestAccessMode;
    const identity = resolveIdentity(
      { ...this.config, guestAccessMode },
      update,
      this.store.lookupIdentity,
    );
    if (!identity.accepted) {
      const replyText = identity.reason === "blocked"
        ? "Access to this bot is blocked."
        : "This bot is currently invitation-only.";
      const inserted = this.store.recordRejectedUpdateWithReply(
        updateId,
        rawUpdate,
        identity.chatId,
        replyText,
      );
      if (!inserted) return "duplicate";
      return "rejected";
    }

    this.store.recoverStaleAttachmentIngress?.(
      identity.conversationKey,
      this.clock(),
      ATTACHMENT_INGRESS_STALE_MS,
    );

    const adminResult = await this.admin.handle(update, identity);
    if (adminResult !== "not_handled") {
      return adminResult === "duplicate" ? "duplicate" : "accepted";
    }

    const attachments = update.message.attachments;
    let ingressToken: string | null = null;
    if (attachments?.length) {
      ingressToken = this.store.claimAttachmentIngress(
        identity.conversationKey,
        this.clock(),
        ATTACHMENT_INGRESS_STALE_MS,
      );
    }
    try {
      const durableUpdate: NormalizedUpdate = attachments?.length
        ? {
            ...update,
            message: {
              ...update.message,
              attachments: await withOperationDeadline(
                ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
                signal,
                (downloadSignal) => this.downloadAttachments(update, identity, downloadSignal),
              ),
            },
          }
        : update;
      const ingress = ingressToken
        ? { conversationKey: identity.conversationKey, token: ingressToken }
        : undefined;
      return this.store.acceptUpdate(durableUpdate, identity, this.clock(), ingress)
        ? "accepted"
        : "duplicate";
    } catch (error) {
      if (ingressToken) {
        this.store.releaseAttachmentIngress(identity.conversationKey, ingressToken, this.clock());
      }
      throw error;
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const offset = parseOffset(this.store.getSetting(OFFSET_SETTING));
    const updates = await this.telegram.getUpdates(
      offset,
      this.longPollSeconds,
      signal,
    );
    for (const rawUpdate of updates) {
      const updateId = readSafeInteger(asRecord(rawUpdate)?.update_id);
      if (updateId === null) continue;
      await this.processUpdate(rawUpdate, signal);
      this.store.setSetting(OFFSET_SETTING, String(updateId + 1));
    }
    return updates.length;
  }

  /**
   * Telegram sendMessage has no idempotency key. This durable outbox provides
   * at-least-once delivery with fenced claims and retries explicit failures.
   * A crash after Telegram accepts a send but before local acknowledgement can
   * therefore duplicate the active chunk. Checkpointed earlier chunks resume
   * from their stored index after explicit failures or restart.
   */
  async flushOutbox(
    now?: number,
    limit = 100,
    shutdownSignal?: AbortSignal,
  ): Promise<number> {
    const currentTime = () => now ?? this.clock();
    let attempted = 0;
    while (attempted < limit) {
      const claimTime = currentTime();
      const reply = this.store.claimOutboundReply(
        this.outboundLeaseOwner,
        claimTime,
        this.outboundLeaseMs,
        this.outboundMaxAttempts,
      );
      if (!reply) break;
      attempted++;
      try {
        const chunks = splitTelegramMessage(reply.text);
        for (let index = reply.nextChunkIndex; index < chunks.length; index++) {
          await withOperationDeadline(
            this.outboundSendTimeoutMs,
            shutdownSignal,
            (operationSignal) =>
              this.telegram.sendMessage(reply.chatId, chunks[index], operationSignal),
          );
          const checkpointTime = currentTime();
          if (!this.store.advanceOutboundReplyChunk(
            reply.id,
            this.outboundLeaseOwner,
            reply.leaseToken!,
            index + 1,
            checkpointTime,
          )) {
            return attempted;
          }
          const renewalTime = currentTime();
          if (!this.store.renewOutboundReplyLease(
            reply.id,
            this.outboundLeaseOwner,
            reply.leaseToken!,
            renewalTime,
            this.outboundLeaseMs,
          )) {
            return attempted;
          }
        }
        const acknowledgementTime = currentTime();
        this.store.markOutboundReplyDelivered(
          reply.id,
          this.outboundLeaseOwner,
          reply.leaseToken!,
          acknowledgementTime,
        );
      } catch (error) {
        const failureTime = currentTime();
        if (shutdownSignal?.aborted) {
          this.store.releaseOutboundReply(
            reply.id,
            this.outboundLeaseOwner,
            reply.leaseToken!,
            errorMessage(error),
            failureTime,
          );
          return attempted;
        }
        const classification = classifyOutboundError(error);
        if (!classification.retryable) {
          this.store.failOutboundReply(
            reply.id,
            this.outboundLeaseOwner,
            reply.leaseToken!,
            errorMessage(error),
            failureTime,
          );
          continue;
        }
        const retryInMs = Math.min(
          this.outboundMaxBackoffMs,
          this.outboundInitialBackoffMs *
            2 ** Math.min(Math.max(reply.attempts - 1, 0), 30),
        );
        this.store.retryOutboundReply(
          reply.id,
          this.outboundLeaseOwner,
          reply.leaseToken!,
          errorMessage(error),
          failureTime + Math.max(retryInMs, classification.retryAfterMs ?? 0),
          this.outboundMaxAttempts,
          failureTime,
        );
      }
    }
    return attempted;
  }

  async run(signal: AbortSignal, maxIterations = Number.POSITIVE_INFINITY): Promise<void> {
    let failures = 0;
    for (let iteration = 0; iteration < maxIterations && !signal.aborted; iteration++) {
      try {
        await this.flushOutbox(undefined, 100, signal);
        await this.pollOnce(signal);
        await this.flushOutbox(undefined, 100, signal);
        failures = 0;
      } catch (error) {
        if (signal.aborted) return;
        const retryInMs = Math.min(
          this.maxBackoffMs,
          this.initialBackoffMs * 2 ** Math.min(failures, 30),
        );
        failures++;
        this.onPollError?.(error, isConflict(error), retryInMs);
        await this.sleep(retryInMs, signal);
      }
    }
  }

  private async downloadAttachments(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    signal?: AbortSignal,
  ): Promise<NormalizedAttachment[]> {
    const downloaded: NormalizedAttachment[] = [];
    const createdPaths: string[] = [];
    try {
      for (const [index, attachment] of (update.message.attachments ?? []).entries()) {
        const file = await this.telegram.getFile(attachment.fileId, signal);
        if (!file.file_path) {
          throw new Error("Telegram getFile response is missing file_path");
        }
        const attachmentIdentity = [
          update.updateId,
          index,
          attachment.kind,
          attachment.fileId,
        ].join(":");
        const result = await this.telegram.downloadAttachment(
          this.baseDirectory,
          identity.conversationKey,
          file.file_path,
          attachment.fileName,
          attachmentIdentity,
          signal,
        );
        if (result.created) createdPaths.push(result.path);
        downloaded.push({ ...attachment, localPath: result.path });
      }
      return downloaded;
    } catch (error) {
      await Promise.allSettled(
        createdPaths.map((path) =>
          this.telegram.removeAttachment(
            this.baseDirectory,
            identity.conversationKey,
            path,
          )),
      );
      throw error;
    }
  }
}

export function normalizeTelegramUpdate(rawUpdate: unknown): NormalizedUpdate | null {
  const update = asRecord(rawUpdate);
  const rawMessage = asRecord(update?.message);
  const rawSender = asRecord(rawMessage?.from);
  const rawChat = asRecord(rawMessage?.chat);
  const updateId = readSafeInteger(update?.update_id);
  const messageId = readSafeInteger(rawMessage?.message_id);
  const date = readSafeInteger(rawMessage?.date);
  const senderId = readSafeInteger(rawSender?.id);
  const chatId = readSafeInteger(rawChat?.id);
  const chatType = rawChat?.type;
  if (
    updateId === null ||
    messageId === null ||
    date === null ||
    senderId === null ||
    chatId === null ||
    (chatType !== "private" && chatType !== "group" && chatType !== "supergroup")
  ) {
    return null;
  }

  const attachments = normalizeAttachments(rawMessage!);
  const text = readString(rawMessage?.text) ?? readString(rawMessage?.caption) ?? "";
  if (!text && attachments.length === 0) return null;

  const message: NormalizedMessage = {
    messageId,
    date,
    text,
    sender: {
      id: senderId,
      ...optionalString("username", rawSender?.username),
      ...optionalString("firstName", rawSender?.first_name),
      ...optionalString("lastName", rawSender?.last_name),
    },
    chat: {
      id: chatId,
      type: chatType,
      ...optionalString("title", rawChat?.title),
      ...optionalString("username", rawChat?.username),
    },
    ...(attachments.length ? { attachments } : {}),
  };
  return { updateId, message };
}

function normalizeAttachments(message: Record<string, unknown>): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = [];
  addAttachment(attachments, "document", asRecord(message.document));
  const photos = Array.isArray(message.photo) ? message.photo : [];
  addAttachment(attachments, "photo", asRecord(photos.at(-1)));
  addAttachment(attachments, "audio", asRecord(message.audio));
  addAttachment(attachments, "video", asRecord(message.video));
  addAttachment(attachments, "voice", asRecord(message.voice));
  return attachments;
}

function addAttachment(
  attachments: NormalizedAttachment[],
  kind: NormalizedAttachment["kind"],
  file: RawFile | null,
): void {
  const fileId = readString(file?.file_id);
  if (!fileId) return;
  const fileSize = readSafeInteger(file?.file_size);
  attachments.push({
    kind,
    fileId,
    ...optionalString("fileName", file?.file_name),
    ...optionalString("mimeType", file?.mime_type),
    ...(fileSize === null ? {} : { fileSize }),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalString<Key extends string>(
  key: Key,
  value: unknown,
): Partial<Record<Key, string>> {
  const string = readString(value);
  return string === undefined ? {} : ({ [key]: string } as Record<Key, string>);
}

function parseOffset(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) throw new Error("stored Telegram offset is invalid");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw new Error("stored Telegram offset is invalid");
  return offset;
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errorCode?: unknown; status?: unknown };
  return candidate.errorCode === 409 || candidate.status === 409;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function classifyOutboundError(error: unknown): {
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (error instanceof TelegramApiError) {
    if (error.status === 429 || error.errorCode === 429) {
      return {
        retryable: true,
        retryAfterMs: error.retryAfterSeconds === undefined
          ? undefined
          : error.retryAfterSeconds * 1_000,
      };
    }
    if (error.status >= 400 && error.status < 500) return { retryable: false };
    return { retryable: error.status >= 500 };
  }
  return { retryable: true };
}

async function withOperationDeadline<T>(
  milliseconds: number,
  shutdownSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromShutdown = () =>
    controller.abort(
      shutdownSignal?.reason ?? new DOMException("receiver shutdown", "AbortError"),
    );
  if (shutdownSignal?.aborted) abortFromShutdown();
  else shutdownSignal?.addEventListener("abort", abortFromShutdown, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException("receiver operation deadline exceeded", "TimeoutError")),
    milliseconds,
  );
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timeout);
    shutdownSignal?.removeEventListener("abort", abortFromShutdown);
  }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    function finish() {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}
