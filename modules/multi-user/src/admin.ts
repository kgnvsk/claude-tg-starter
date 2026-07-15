import type {
  AcceptedIdentity,
  AdminMutationAction,
  EmergencyResult,
  NormalizedUpdate,
  StoredJob,
} from "./types";

const OPEN_ACCESS_ALIAS = "открой доступ для всех";
const INVITE_ONLY_ALIAS = "переключи доступ только по приглашениям";
const SHOW_JOBS_ALIAS = "покажи активные задачи";

export type AdminHandleResult = "handled" | "duplicate" | "not_handled";

export interface EmergencyControls {
  doctor?: () => EmergencyResult;
  restart?: () => EmergencyResult;
}

export interface AdminConfirmResult {
  recorded: boolean;
  postCommitEffect: { type: "restart" } | null;
}

export interface AdminStore {
  hasUpdate(updateId: number): boolean;
  recordAdminReply(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    text: string,
    now?: number,
  ): boolean;
  recordAdminActionRequest(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    action: AdminMutationAction,
    token: string,
    expiresAt: number,
    text: string,
    now?: number,
  ): boolean;
  recordAdminUnblock(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    userId: number,
    now?: number,
  ): boolean;
  confirmAdminAction(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    token: string,
    now?: number,
  ): AdminConfirmResult;
  listJobs(conversationKey?: string): StoredJob[];
}

interface AdminControllerOptions {
  store: AdminStore;
  adminIds: ReadonlySet<number>;
  confirmationTtlMs?: number;
  clock?: () => number;
  emergency?: EmergencyControls;
}

type ParsedCommand =
  | { kind: "none" }
  | { kind: "reply"; text: string }
  | { kind: "jobs" }
  | { kind: "doctor" }
  | { kind: "unblock"; userId: number }
  | { kind: "confirm"; token: string }
  | { kind: "mutation"; action: AdminMutationAction; description: string };

export class AdminController {
  private readonly store: AdminStore;
  private readonly adminIds: ReadonlySet<number>;
  private readonly confirmationTtlMs: number;
  private readonly clock: () => number;
  private readonly emergency: EmergencyControls;

  constructor(options: AdminControllerOptions) {
    this.store = options.store;
    this.adminIds = new Set(options.adminIds);
    for (const adminId of this.adminIds) {
      if (!Number.isSafeInteger(adminId)) throw new Error("admin IDs must be safe integers");
    }
    this.confirmationTtlMs = options.confirmationTtlMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.confirmationTtlMs) || this.confirmationTtlMs <= 0) {
      throw new Error("confirmation TTL must be a positive safe integer");
    }
    this.clock = options.clock ?? Date.now;
    this.emergency = options.emergency ?? {};
  }

  async handle(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
  ): Promise<AdminHandleResult> {
    if (
      identity.role !== "admin" ||
      !this.adminIds.has(identity.userId) ||
      update.message.sender.id !== identity.userId ||
      identity.chatType !== "private" ||
      update.message.chat.type !== "private" ||
      identity.chatId !== identity.userId
    ) {
      return "not_handled";
    }
    if (this.store.hasUpdate(update.updateId)) return "duplicate";

    const parsed = parseAdminCommand(update.message.text, this.adminIds);
    if (parsed.kind === "none") return "not_handled";
    const now = this.clock();

    if (parsed.kind === "confirm") {
      const result = this.store.confirmAdminAction(
        update,
        identity,
        parsed.token,
        now,
      );
      if (!result.recorded) return "duplicate";
      if (result.postCommitEffect?.type === "restart") {
        this.emergency.restart?.();
      }
      return "handled";
    }

    if (parsed.kind === "jobs") {
      const text = formatJobs(this.store.listJobs());
      return this.store.recordAdminReply(update, identity, text, now)
        ? "handled"
        : "duplicate";
    }

    if (parsed.kind === "doctor") {
      const result = this.emergency.doctor?.() ?? {
        ok: false,
        message: "Doctor callback is not configured.",
      };
      return this.store.recordAdminReply(update, identity, result.message, now)
        ? "handled"
        : "duplicate";
    }

    if (parsed.kind === "unblock") {
      return this.store.recordAdminUnblock(
        update,
        identity,
        parsed.userId,
        now,
      ) ? "handled" : "duplicate";
    }

    if (parsed.kind === "reply") {
      return this.store.recordAdminReply(update, identity, parsed.text, now)
        ? "handled"
        : "duplicate";
    }

    const token = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = now + this.confirmationTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("confirmation expiry is invalid");
    const text = `${parsed.description}\nConfirm with: /confirm ${token}`;
    return this.store.recordAdminActionRequest(
      update,
      identity,
      parsed.action,
      token,
      expiresAt,
      text,
      now,
    ) ? "handled" : "duplicate";
  }
}

export function parseAdminActionJson(actionType: string, payloadJson: string): AdminMutationAction {
  const value: unknown = JSON.parse(payloadJson);
  if (!isRecord(value) || value.type !== actionType) {
    throw new Error("stored admin action type does not match its payload");
  }

  switch (actionType) {
    case "access":
      requireExactKeys(value, ["type", "mode"]);
      if (value.mode !== "public" && value.mode !== "invite") break;
      return { type: "access", mode: value.mode };
    case "allow":
      requireExactKeys(value, ["type", "userId"]);
      if (!isTelegramId(value.userId)) break;
      return { type: "allow", userId: value.userId };
    case "block":
      requireExactKeys(value, ["type", "userId", "reason"]);
      if (!isTelegramId(value.userId) || (value.reason !== null && typeof value.reason !== "string")) break;
      return { type: "block", userId: value.userId, reason: value.reason };
    case "cancel":
      requireExactKeys(value, ["type", "jobId"]);
      if (!Number.isSafeInteger(value.jobId) || Number(value.jobId) <= 0) break;
      return { type: "cancel", jobId: Number(value.jobId) };
    case "reset":
      requireExactKeys(value, ["type", "conversationKey"]);
      if (typeof value.conversationKey !== "string" || !isSafeConversationKey(value.conversationKey)) break;
      return { type: "reset", conversationKey: value.conversationKey };
    case "restart":
      requireExactKeys(value, ["type"]);
      return { type: "restart" };
  }
  throw new Error("stored admin action payload is invalid");
}

function parseAdminCommand(text: string, adminIds: ReadonlySet<number>): ParsedCommand {
  const trimmed = text.trim();
  const alias = trimmed.toLocaleLowerCase("ru");
  if (alias === OPEN_ACCESS_ALIAS) {
    return accessMutation("public");
  }
  if (alias === INVITE_ONLY_ALIAS) {
    return accessMutation("invite");
  }
  if (alias === SHOW_JOBS_ALIAS) return { kind: "jobs" };
  const blockAlias = /^заблокируй пользователя ([1-9]\d*)$/.exec(alias);
  if (blockAlias) return blockMutation(Number(blockAlias[1]), null, adminIds);
  const allowAlias = /^разреши доступ пользователю ([1-9]\d*)$/.exec(alias);
  if (allowAlias) return allowMutation(Number(allowAlias[1]), adminIds);
  const unblockAlias = /^разблокируй пользователя ([1-9]\d*)$/.exec(alias);
  if (unblockAlias) {
    const userId = parseTelegramId(unblockAlias[1]);
    if (userId !== null) return { kind: "unblock", userId };
  }
  const cancelAlias = /^отмени задачу ([1-9]\d*)$/.exec(alias);
  if (cancelAlias) {
    const jobId = parsePositiveInteger(cancelAlias[1]);
    if (jobId !== null) return cancelMutation(jobId);
  }
  const resetAlias = /^сбрось диалог (-?[1-9]\d*)$/.exec(alias);
  if (resetAlias) {
    return resetMutation(parseResetTarget(resetAlias[1]!));
  }
  if (!trimmed.startsWith("/")) return { kind: "none" };

  const [command = "", ...args] = trimmed.split(/\s+/);
  switch (command.toLowerCase()) {
    case "/jobs":
      return args.length === 0 ? { kind: "jobs" } : usage("Usage: /jobs");
    case "/doctor":
      return args.length === 0 ? { kind: "doctor" } : usage("Usage: /doctor");
    case "/restart":
      return args.length === 0
        ? { kind: "mutation", action: { type: "restart" }, description: "Restart the agent?" }
        : usage("Usage: /restart");
    case "/confirm":
      return args.length === 1 && /^[A-Za-z0-9_-]{16,128}$/.test(args[0]!)
        ? { kind: "confirm", token: args[0]! }
        : usage("Usage: /confirm <token>");
    case "/access":
      return args.length === 1 && (args[0] === "public" || args[0] === "invite")
        ? accessMutation(args[0])
        : usage("Usage: /access public|invite");
    case "/allow": {
      const userId = args.length === 1 ? parseTelegramId(args[0]) : null;
      return userId === null
        ? usage("Usage: /allow <numeric user_id>")
        : allowMutation(userId, adminIds);
    }
    case "/block": {
      const userId = parseTelegramId(args[0]);
      if (userId === null) return usage("Usage: /block <numeric user_id> [reason]");
      const reason = args.slice(1).join(" ").trim() || null;
      return blockMutation(userId, reason, adminIds);
    }
    case "/unblock": {
      const userId = args.length === 1 ? parseTelegramId(args[0]) : null;
      return userId === null
        ? usage("Usage: /unblock <numeric user_id>")
        : { kind: "unblock", userId };
    }
    case "/cancel": {
      const jobId = args.length === 1 ? parsePositiveInteger(args[0]) : null;
      return jobId === null
        ? usage("Usage: /cancel <job_id>")
        : cancelMutation(jobId);
    }
    case "/reset": {
      const conversationKey = args.length === 1 ? parseResetTarget(args[0]!) : null;
      return resetMutation(conversationKey);
    }
    default:
      return { kind: "none" };
  }
}

function blockMutation(
  userId: number,
  reason: string | null,
  adminIds: ReadonlySet<number>,
): ParsedCommand {
  if (!isTelegramId(userId)) return usage("Usage: /block <numeric user_id> [reason]");
  if (adminIds.has(userId)) return usage("A configured administrator cannot be blocked.");
  return {
    kind: "mutation",
    action: { type: "block", userId, reason },
    description: `Block Telegram user ${userId}${reason ? ` (${reason})` : ""}?`,
  };
}

function allowMutation(userId: number, adminIds: ReadonlySet<number>): ParsedCommand {
  if (!isTelegramId(userId)) return usage("Usage: /allow <numeric user_id>");
  if (adminIds.has(userId)) return usage("That user is already a configured administrator.");
  return {
    kind: "mutation",
    action: { type: "allow", userId },
    description: `Allow Telegram user ${userId} as a guest?`,
  };
}

function cancelMutation(jobId: number): ParsedCommand {
  return {
    kind: "mutation",
    action: { type: "cancel", jobId },
    description: `Cancel job ${jobId}?`,
  };
}

function resetMutation(conversationKey: string | null): ParsedCommand {
  return conversationKey === null
    ? usage("Invalid reset target. Use a numeric chat ID, dm:<positive-id>, or group:<negative-id>.")
    : {
        kind: "mutation",
        action: { type: "reset", conversationKey },
        description: `Reset ${conversationKey}?`,
      };
}

function accessMutation(mode: "public" | "invite"): ParsedCommand {
  return {
    kind: "mutation",
    action: { type: "access", mode },
    description: mode === "public" ? "Open guest access to everyone?" : "Switch to invitation-only access?",
  };
}

function usage(text: string): ParsedCommand {
  return { kind: "reply", text };
}

function parseResetTarget(value: string): string | null {
  if (/^-?\d+$/.test(value)) {
    const id = Number(value);
    if (!isTelegramId(id)) return null;
    return id < 0 ? `group:${id}` : `dm:${id}`;
  }
  return isSafeConversationKey(value) ? value : null;
}

function isSafeConversationKey(value: string): boolean {
  const dm = /^dm:([1-9]\d*)$/.exec(value);
  if (dm) return isTelegramId(Number(dm[1]));
  const group = /^group:(-[1-9]\d*)$/.exec(value);
  return Boolean(group && isTelegramId(Number(group[1])));
}

function parseTelegramId(value: string | undefined): number | null {
  if (!value || !/^-?\d+$/.test(value)) return null;
  const id = Number(value);
  return isTelegramId(id) ? id : null;
}

function isTelegramId(value: unknown): value is number {
  return Number.isSafeInteger(value) && value !== 0;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function formatJobs(jobs: readonly StoredJob[]): string {
  const active = jobs.filter(({ status }) => status === "queued" || status === "running");
  if (active.length === 0) return "No active or queued jobs.";
  return active
    .map((job) => `#${job.id} ${job.status} ${job.conversationKey} seq=${job.sequence}`)
    .join("\n");
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error("stored admin action contains unexpected fields");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
