import { Database } from "bun:sqlite";

import {
  parseAdminActionJson,
  type AdminConfirmResult,
} from "./admin";

import type {
  AcceptedIdentity,
  AdminMutationAction,
  IdentityLookup,
  JobStatus,
  NormalizedUpdate,
  OutboundReplyStatus,
  Role,
  StoredConversation,
  StoredIdentity,
  StoredJob,
  StoredOutboundReply,
} from "./types";

const SCHEMA_VERSION = 4;

export type UpdateState = "accepted" | "ignored" | "rejected";

const REQUIRED_SCHEMA = {
  users: [
    "telegram_user_id",
    "role",
    "status",
    "username",
    "first_name",
    "last_name",
    "created_at",
    "updated_at",
  ],
  chats: [
    "telegram_chat_id",
    "type",
    "status",
    "title",
    "username",
    "created_at",
    "updated_at",
  ],
  memberships: [
    "telegram_user_id",
    "telegram_chat_id",
    "effective_role",
    "created_at",
    "updated_at",
  ],
  conversations: [
    "conversation_key",
    "telegram_chat_id",
    "session_id",
    "generation",
    "state",
    "next_sequence",
    "lease_owner",
    "lease_until",
    "last_activity_at",
    "created_at",
    "updated_at",
    "session_role",
  ],
  updates: [
    "update_id",
    "conversation_key",
    "processing_state",
    "payload_json",
    "created_at",
  ],
  outbound_replies: [
    "id",
    "update_id",
    "chat_id",
    "text",
    "status",
    "attempts",
    "next_attempt_at",
    "lease_owner",
    "lease_token",
    "lease_until",
    "last_error",
    "created_at",
    "updated_at",
    "delivered_at",
    "next_chunk_index",
  ],
  jobs: [
    "id",
    "update_id",
    "conversation_key",
    "generation",
    "sequence",
    "status",
    "role",
    "payload_json",
    "attempts",
    "lease_owner",
    "lease_token",
    "lease_until",
    "error",
    "result",
    "created_at",
    "updated_at",
  ],
  blocks: ["telegram_user_id", "reason", "blocked_by", "created_at"],
  settings: ["key", "value", "updated_at"],
  pending_admin_actions: [
    "token",
    "action_type",
    "payload_json",
    "requested_by",
    "expires_at",
    "created_at",
    "consumed_at",
  ],
} as const;

export interface StoreOptions {
  adminChatIds?: ReadonlySet<number>;
}

export interface ActiveLeaseDescriptor {
  jobId: number;
  conversationKey: string;
}

interface NormalizedLeaseExclusions {
  jobIds: number[];
  conversationKeys: string[];
}

interface ConversationRow {
  conversation_key: string;
  telegram_chat_id: number;
  session_id: string | null;
  session_role: Role | null;
  generation: number;
  state: string;
  next_sequence: number;
  lease_owner: string | null;
  lease_until: number | null;
  last_activity_at: number;
}

interface JobRow {
  id: number;
  update_id: number;
  conversation_key: string;
  generation: number;
  sequence: number;
  status: JobStatus;
  role: Role;
  payload_json: string;
  attempts: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: number | null;
  error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
}

interface OutboundReplyRow {
  id: number;
  update_id: number;
  chat_id: number;
  text: string;
  status: OutboundReplyStatus;
  attempts: number;
  next_chunk_index: number;
  next_attempt_at: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
}

export class Store {
  readonly db: Database;
  private readonly adminChatIds: ReadonlySet<number>;

  constructor(path: string, options: StoreOptions = {}) {
    this.db = new Database(path, { create: true, strict: true });
    this.adminChatIds = new Set(options.adminChatIds ?? []);
    try {
      for (const adminId of this.adminChatIds) {
        if (!Number.isSafeInteger(adminId)) {
          throw new Error("admin IDs must be safe integers");
        }
      }
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.migrateAndValidateSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  hasUpdate(updateId: number): boolean {
    validateUpdateId(updateId);
    return this.getUpdateState(updateId) !== null;
  }

  getUpdateState(updateId: number): UpdateState | null {
    validateUpdateId(updateId);
    const row = this.db
      .query<{ processing_state: string }, [number]>(`
        SELECT processing_state FROM updates WHERE update_id = ?
      `)
      .get(updateId);
    if (!row) return null;
    if (
      row.processing_state !== "accepted" &&
      row.processing_state !== "ignored" &&
      row.processing_state !== "rejected"
    ) {
      throw new Error(`stored update ${updateId} has an invalid processing state`);
    }
    return row.processing_state;
  }

  recordTerminalUpdate(
    updateId: number,
    state: Exclude<UpdateState, "accepted">,
    payload: unknown,
    now = Date.now(),
  ): boolean {
    validateUpdateId(updateId);
    validateTimestamp(now);
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("terminal update payload is not serializable");
    return Boolean(
      this.db
        .query<{ update_id: number }, [number, string, string, number]>(`
          INSERT INTO updates (
            update_id, conversation_key, processing_state, payload_json, created_at
          ) VALUES (?, '', ?, ?, ?)
          ON CONFLICT(update_id) DO NOTHING
          RETURNING update_id
        `)
        .get(updateId, state, payloadJson, now),
    );
  }

  recordRejectedUpdateWithReply(
    updateId: number,
    payload: unknown,
    chatId: number,
    text: string,
    now = Date.now(),
  ): boolean {
    // The update and reply intent commit together. Delivery is separately leased;
    // Telegram has no idempotency key, so acknowledgement cannot be exactly once.
    validateUpdateId(updateId);
    validateTimestamp(now);
    if (!Number.isSafeInteger(chatId)) throw new Error("Telegram chat ID must be a safe integer");
    if (!text) throw new Error("outbound reply text is required");
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new Error("terminal update payload is not serializable");

    const record = this.db.transaction(() => {
      const inserted = this.db
        .query<{ update_id: number }, [number, string, number]>(`
          INSERT INTO updates (
            update_id, conversation_key, processing_state, payload_json, created_at
          ) VALUES (?, '', 'rejected', ?, ?)
          ON CONFLICT(update_id) DO NOTHING
          RETURNING update_id
        `)
        .get(updateId, payloadJson, now);
      if (!inserted) return false;
      this.db
        .query(`
          INSERT INTO outbound_replies (
            update_id, chat_id, text, status, attempts, next_chunk_index,
            next_attempt_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)
        `)
        .run(updateId, chatId, text, now, now, now);
      return true;
    });
    return record.immediate();
  }

  recordAdminReply(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    text: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    this.validateAdminIdentity(update, identity);
    if (!text) throw new Error("admin reply text is required");
    const record = this.db.transaction(() => {
      if (!this.insertAdminUpdate(update, identity, now)) return false;
      this.insertOutboundReply(update.updateId, identity.chatId, text, now);
      return true;
    });
    return record.immediate();
  }

  recordAdminActionRequest(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    action: AdminMutationAction,
    token: string,
    expiresAt: number,
    text: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    validateTimestamp(expiresAt);
    this.validateAdminIdentity(update, identity);
    if (expiresAt <= now) throw new Error("admin action expiry must be in the future");
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("admin action token is invalid");
    if (!text) throw new Error("admin confirmation reply is required");
    if (action.type === "block" && this.adminChatIds.has(action.userId)) {
      throw new Error("configured administrators cannot be blocked");
    }
    const payloadJson = JSON.stringify(action);
    parseAdminActionJson(action.type, payloadJson);

    const record = this.db.transaction(() => {
      if (!this.insertAdminUpdate(update, identity, now)) return false;
      this.db
        .query(`
          INSERT INTO pending_admin_actions (
            token, action_type, payload_json, requested_by, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(token, action.type, payloadJson, identity.userId, expiresAt, now);
      this.insertOutboundReply(update.updateId, identity.chatId, text, now);
      return true;
    });
    return record.immediate();
  }

  recordAdminUnblock(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    userId: number,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    this.validateAdminIdentity(update, identity);
    if (!Number.isSafeInteger(userId) || userId === 0) {
      throw new Error("Telegram user ID must be a non-zero safe integer");
    }
    const record = this.db.transaction(() => {
      if (!this.insertAdminUpdate(update, identity, now)) return false;
      const changed = this.db
        .query("DELETE FROM blocks WHERE telegram_user_id = ?")
        .run(userId).changes > 0;
      this.insertOutboundReply(
        update.updateId,
        identity.chatId,
        changed
          ? `Telegram user ${userId} is unblocked.`
          : `Telegram user ${userId} was not blocked.`,
        now,
      );
      return true;
    });
    return record.immediate();
  }

  confirmAdminAction(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    token: string,
    now = Date.now(),
  ): AdminConfirmResult {
    validateTimestamp(now);
    this.validateAdminIdentity(update, identity);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("admin action token is invalid");

    const confirm = this.db.transaction(() => {
      if (!this.insertAdminUpdate(update, identity, now)) {
        return { recorded: false, postCommitEffect: null } satisfies AdminConfirmResult;
      }
      const row = this.db
        .query<{
          action_type: string;
          payload_json: string;
          requested_by: number;
          expires_at: number;
          consumed_at: number | null;
        }, [string]>(`
          SELECT action_type, payload_json, requested_by, expires_at, consumed_at
          FROM pending_admin_actions WHERE token = ?
        `)
        .get(token);

      let reply: string;
      let postCommitEffect: AdminConfirmResult["postCommitEffect"] = null;
      if (!row) {
        reply = "Confirmation token was not found.";
      } else if (row.requested_by !== identity.userId) {
        reply = "This confirmation belongs to another administrator.";
      } else if (row.consumed_at !== null) {
        reply = "This confirmation was already used.";
      } else if (row.expires_at <= now) {
        reply = "This confirmation has expired.";
        this.db
          .query(`
            UPDATE pending_admin_actions SET consumed_at = ?
            WHERE token = ? AND consumed_at IS NULL
          `)
          .run(now, token);
      } else {
        let action: AdminMutationAction | null = null;
        try {
          action = parseAdminActionJson(row.action_type, row.payload_json);
        } catch (error) {
          reply = `Stored admin action is invalid: ${errorMessage(error)}`;
        }
        if (action?.type === "block" && this.adminChatIds.has(action.userId)) {
          action = null;
          reply = "Stored admin action is invalid: configured administrators cannot be blocked";
        }
        if (action !== null) {
          reply = this.executeAdminAction(action, identity.userId, now);
          if (action.type === "restart") postCommitEffect = { type: "restart" };
        }
        this.db
          .query(`
            UPDATE pending_admin_actions SET consumed_at = ?
            WHERE token = ? AND consumed_at IS NULL
          `)
          .run(now, token);
      }
      this.insertOutboundReply(update.updateId, identity.chatId, reply, now);
      return { recorded: true, postCommitEffect } satisfies AdminConfirmResult;
    });
    return confirm.immediate();
  }

  listOutboundReplies(): StoredOutboundReply[] {
    return this.db
      .query<OutboundReplyRow, []>("SELECT * FROM outbound_replies ORDER BY id")
      .all()
      .map(mapOutboundReply);
  }

  claimOutboundReply(
    leaseOwner: string,
    now = Date.now(),
    leaseMs = 30_000,
    maxAttempts = 5,
  ): StoredOutboundReply | null {
    if (!leaseOwner) throw new Error("outbound reply lease owner is required");
    validateAttemptLimit(maxAttempts);
    const leaseUntil = calculateLeaseUntil(now, leaseMs);
    const claim = this.db.transaction(() => {
      this.db
        .query(`
          UPDATE outbound_replies
          SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
              lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              last_error = CASE
                WHEN attempts >= ? THEN 'reply lease expired after final attempt'
                ELSE last_error
              END,
              updated_at = ?
          WHERE status = 'leased' AND lease_until <= ?
        `)
        .run(maxAttempts, maxAttempts, now, now);
      const candidate = this.db
        .query<{ id: number }, [number, number]>(`
          SELECT id FROM outbound_replies
          WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < ?
          ORDER BY next_attempt_at, id
          LIMIT 1
        `)
        .get(now, maxAttempts);
      if (!candidate) return null;
      const leaseToken = crypto.randomUUID();
      const row = this.db
        .query<OutboundReplyRow, [string, string, number, number, number]>(`
          UPDATE outbound_replies
          SET status = 'leased', attempts = attempts + 1,
              lease_owner = ?, lease_token = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
          RETURNING *
        `)
        .get(leaseOwner, leaseToken, leaseUntil, now, candidate.id);
      if (!row) throw new Error("outbound reply lease acquisition failed");
      return mapOutboundReply(row);
    });
    return claim.immediate();
  }

  markOutboundReplyDelivered(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    return (
      this.db
        .query(`
          UPDATE outbound_replies
          SET status = 'delivered', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, last_error = NULL,
              updated_at = ?, delivered_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
            AND lease_token = ? AND lease_until > ?
        `)
        .run(now, now, replyId, leaseOwner, leaseToken, now).changes > 0
    );
  }

  advanceOutboundReplyChunk(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    nextChunkIndex: number,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    if (!Number.isSafeInteger(nextChunkIndex) || nextChunkIndex < 0) {
      throw new Error("outbound reply chunk index must be a non-negative safe integer");
    }
    return (
      this.db
        .query(`
          UPDATE outbound_replies
          SET next_chunk_index = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
            AND lease_token = ? AND lease_until > ?
            AND next_chunk_index <= ?
        `)
        .run(
          nextChunkIndex,
          now,
          replyId,
          leaseOwner,
          leaseToken,
          now,
          nextChunkIndex,
        ).changes > 0
    );
  }

  renewOutboundReplyLease(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    now = Date.now(),
    leaseMs = 30_000,
  ): boolean {
    const leaseUntil = calculateLeaseUntil(now, leaseMs);
    return (
      this.db
        .query(`
          UPDATE outbound_replies
          SET lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
            AND lease_token = ? AND lease_until > ?
        `)
        .run(leaseUntil, now, replyId, leaseOwner, leaseToken, now).changes > 0
    );
  }

  failOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    return (
      this.db
        .query(`
          UPDATE outbound_replies
          SET status = 'failed', lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
            AND lease_token = ? AND lease_until > ?
        `)
        .run(error, now, replyId, leaseOwner, leaseToken, now).changes > 0
    );
  }

  releaseOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    return (
      this.db
        .query(`
          UPDATE outbound_replies
          SET status = 'pending', attempts = MAX(attempts - 1, 0),
              next_attempt_at = ?, lease_owner = NULL, lease_token = NULL,
              lease_until = NULL, last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
            AND lease_token = ? AND lease_until > ?
        `)
        .run(now, error, now, replyId, leaseOwner, leaseToken, now).changes > 0
    );
  }

  retryOutboundReply(
    replyId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    nextAttemptAt: number,
    maxAttempts: number,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    validateTimestamp(nextAttemptAt);
    validateAttemptLimit(maxAttempts);
    if (nextAttemptAt < now) throw new Error("outbound retry time may not be in the past");
    const result = this.db
      .query(`
        UPDATE outbound_replies
        SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
            next_attempt_at = ?, lease_owner = NULL, lease_token = NULL,
            lease_until = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
          AND lease_token = ? AND lease_until > ?
      `)
      .run(
        maxAttempts,
        nextAttemptAt,
        error,
        now,
        replyId,
        leaseOwner,
        leaseToken,
        now,
      );
    return result.changes > 0;
  }

  acceptUpdate(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    this.validateAcceptedIdentity(update, identity);

    const enqueue = this.db.transaction(() => {
      const inserted = this.db
        .query<{ update_id: number }, [number, string, string, number]>(`
          INSERT INTO updates (update_id, conversation_key, processing_state, payload_json, created_at)
          VALUES (?, ?, 'accepted', ?, ?)
          ON CONFLICT(update_id) DO NOTHING
          RETURNING update_id
        `)
        .get(
          update.updateId,
          identity.conversationKey,
          JSON.stringify(update),
          now,
        );
      if (!inserted) return false;

      const { chat, sender } = update.message;
      this.db
        .query(`
          INSERT INTO users (
            telegram_user_id, role, status, username, first_name, last_name,
            created_at, updated_at
          ) VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_user_id) DO UPDATE SET
            role = excluded.role,
            status = 'active',
            username = excluded.username,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            updated_at = excluded.updated_at
        `)
        .run(
          sender.id,
          identity.role,
          sender.username ?? null,
          sender.firstName ?? null,
          sender.lastName ?? null,
          now,
          now,
        );
      this.db
        .query(`
          INSERT INTO chats (
            telegram_chat_id, type, status, title, username, created_at, updated_at
          ) VALUES (?, ?, 'active', ?, ?, ?, ?)
          ON CONFLICT(telegram_chat_id) DO UPDATE SET
            type = excluded.type,
            status = 'active',
            title = excluded.title,
            username = excluded.username,
            updated_at = excluded.updated_at
        `)
        .run(
          chat.id,
          chat.type,
          chat.title ?? null,
          chat.username ?? null,
          now,
          now,
        );
      this.db
        .query(`
          INSERT INTO memberships (
            telegram_user_id, telegram_chat_id, effective_role, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(telegram_user_id, telegram_chat_id) DO UPDATE SET
            effective_role = excluded.effective_role,
            updated_at = excluded.updated_at
        `)
        .run(sender.id, chat.id, identity.role, now, now);
      this.db
        .query(`
          INSERT INTO conversations (
            conversation_key, telegram_chat_id, generation, state, next_sequence,
            last_activity_at, created_at, updated_at
          ) VALUES (?, ?, 1, 'active', 1, ?, ?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET
            last_activity_at = excluded.last_activity_at,
            updated_at = excluded.updated_at
        `)
        .run(identity.conversationKey, chat.id, now, now, now);

      const allocation = this.db
        .query<{ sequence: number; generation: number }, [number, string]>(`
          UPDATE conversations
          SET next_sequence = next_sequence + 1, updated_at = ?
          WHERE conversation_key = ?
          RETURNING next_sequence - 1 AS sequence, generation
        `)
        .get(now, identity.conversationKey);
      if (!allocation) throw new Error("conversation sequence allocation failed");

      this.db
        .query(`
          INSERT INTO jobs (
            update_id, conversation_key, generation, sequence, status, role, payload_json,
            attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?)
        `)
        .run(
          update.updateId,
          identity.conversationKey,
          allocation.generation,
          allocation.sequence,
          identity.role,
          JSON.stringify(update),
          now,
          now,
        );
      return true;
    });

    return enqueue.immediate();
  }

  listJobs(conversationKey?: string): StoredJob[] {
    const rows = conversationKey
      ? this.db
          .query<JobRow, [string]>(`
            SELECT * FROM jobs WHERE conversation_key = ? ORDER BY id
          `)
          .all(conversationKey)
      : this.db.query<JobRow, []>("SELECT * FROM jobs ORDER BY id").all();
    return rows.map(mapJob);
  }

  getJob(id: number): StoredJob | null {
    const row = this.db
      .query<JobRow, [number]>("SELECT * FROM jobs WHERE id = ?")
      .get(id);
    return row ? mapJob(row) : null;
  }

  leaseNextJob(
    leaseOwner: string,
    now = Date.now(),
    leaseMs = 60_000,
    activeLeases: readonly ActiveLeaseDescriptor[] = [],
  ): StoredJob | null {
    if (!leaseOwner) throw new Error("lease owner is required");
    const leaseUntil = calculateLeaseUntil(now, leaseMs);
    const excluded = normalizeActiveLeases(activeLeases);

    const lease = this.db.transaction(() => {
      this.recoverExpiredLeasesWithinTransaction(now, excluded);
      const excludedJobs = sqlNotIn("j.id", excluded.jobIds.length);
      const excludedConversations = sqlNotIn(
        "j.conversation_key",
        excluded.conversationKeys.length,
      );
      const candidate = this.db
        .query<{ id: number; conversation_key: string }, unknown[]>(`
          SELECT j.id, j.conversation_key
          FROM jobs AS j
          JOIN conversations AS c ON c.conversation_key = j.conversation_key
          WHERE j.status = 'queued'
            AND j.updated_at <= ?
            AND j.generation = c.generation
            AND (c.lease_until IS NULL OR c.lease_until <= ?)
            ${excludedJobs}
            ${excludedConversations}
            AND NOT EXISTS (
              SELECT 1 FROM jobs AS earlier
              WHERE earlier.conversation_key = j.conversation_key
                AND earlier.sequence < j.sequence
                AND earlier.status IN ('queued', 'running')
            )
          ORDER BY j.created_at, j.id
          LIMIT 1
        `)
        .get(now, now, ...excluded.jobIds, ...excluded.conversationKeys);
      if (!candidate) return null;

      const leaseToken = crypto.randomUUID();
      this.db
        .query(`
          UPDATE conversations
          SET lease_owner = ?, lease_until = ?, updated_at = ?
          WHERE conversation_key = ?
        `)
        .run(leaseOwner, leaseUntil, now, candidate.conversation_key);
      const row = this.db
        .query<JobRow, [string, string, number, number, number]>(`
          UPDATE jobs
          SET status = 'running', attempts = attempts + 1,
              lease_owner = ?, lease_token = ?, lease_until = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
          RETURNING *
        `)
        .get(leaseOwner, leaseToken, leaseUntil, now, candidate.id);
      if (!row) throw new Error("job lease acquisition failed");
      return mapJob(row);
    });

    return lease.immediate();
  }

  renewLease(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    now = Date.now(),
    leaseMs = 60_000,
  ): boolean {
    const leaseUntil = calculateLeaseUntil(now, leaseMs);

    const renew = this.db.transaction(() => {
      const job = this.db
        .query<
          { conversation_key: string },
          [number, string, string, number, string, number]
        >(`
          SELECT j.conversation_key
          FROM jobs AS j
          JOIN conversations AS c ON c.conversation_key = j.conversation_key
          WHERE j.id = ? AND j.status = 'running'
            AND j.lease_owner = ? AND j.lease_token = ? AND j.lease_until > ?
            AND j.generation = c.generation
            AND c.lease_owner = ? AND c.lease_until > ?
        `)
        .get(jobId, leaseOwner, leaseToken, now, leaseOwner, now);
      if (!job) return false;
      this.db
        .query("UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ?")
        .run(leaseUntil, now, jobId);
      this.db
        .query(`
          UPDATE conversations SET lease_until = ?, updated_at = ?
          WHERE conversation_key = ? AND lease_owner = ?
        `)
        .run(leaseUntil, now, job.conversation_key, leaseOwner);
      return true;
    });
    return renew.immediate();
  }

  completeJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    result: string | null = null,
    sessionId: string | null = null,
    sessionRole: Role | null = null,
    now = Date.now(),
  ): boolean {
    if ((sessionId === null) !== (sessionRole === null)) {
      throw new Error("session ID and session role must be stored together");
    }
    return this.finishJob(
      jobId,
      leaseOwner,
      leaseToken,
      "completed",
      result,
      sessionId,
      sessionRole,
      null,
      now,
    );
  }

  completeJobWithReply(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    result: string,
    sessionId: string,
    sessionRole: Role,
    replyText: string,
    now = Date.now(),
  ): boolean {
    if (!replyText) throw new Error("final reply text is required");
    return this.finishJob(
      jobId,
      leaseOwner,
      leaseToken,
      "completed",
      result,
      sessionId,
      sessionRole,
      replyText,
      now,
    );
  }

  failJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    retry = false,
    now = Date.now(),
  ): boolean {
    return this.finishJob(
      jobId,
      leaseOwner,
      leaseToken,
      retry ? "queued" : "failed",
      error,
      null,
      null,
      null,
      now,
    );
  }

  failJobWithReply(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    replyText: string,
    now = Date.now(),
  ): boolean {
    if (!replyText) throw new Error("error reply text is required");
    return this.finishJob(
      jobId,
      leaseOwner,
      leaseToken,
      "failed",
      error,
      null,
      null,
      replyText,
      now,
    );
  }

  retryJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    nextAttemptAt: number,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    validateTimestamp(nextAttemptAt);
    if (nextAttemptAt < now) throw new Error("job retry time may not be in the past");
    return this.rescheduleJob(
      jobId,
      leaseOwner,
      leaseToken,
      error,
      nextAttemptAt,
      false,
      now,
    );
  }

  releaseJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    return this.rescheduleJob(
      jobId,
      leaseOwner,
      leaseToken,
      error,
      now,
      true,
      now,
    );
  }

  releaseUnstartedJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    now = Date.now(),
  ): boolean {
    validateTimestamp(now);
    return this.rescheduleJob(
      jobId,
      leaseOwner,
      leaseToken,
      error,
      now,
      true,
      now,
    );
  }

  recoverExpiredLeases(
    now = Date.now(),
    activeLeases: readonly ActiveLeaseDescriptor[] = [],
  ): number {
    validateTimestamp(now);
    const excluded = normalizeActiveLeases(activeLeases);
    const recover = this.db.transaction(() =>
      this.recoverExpiredLeasesWithinTransaction(now, excluded),
    );
    return recover.immediate();
  }

  failExhaustedJobs(
    maxAttempts: number,
    replyText: string,
    now = Date.now(),
  ): number {
    validateAttemptLimit(maxAttempts);
    validateTimestamp(now);
    if (!replyText) throw new Error("error reply text is required");
    const fail = this.db.transaction(() => {
      const exhausted = this.db
        .query<
          { id: number; update_id: number; telegram_chat_id: number },
          [number]
        >(`
          SELECT j.id, j.update_id, c.telegram_chat_id
          FROM jobs AS j
          JOIN conversations AS c ON c.conversation_key = j.conversation_key
          WHERE j.status = 'queued' AND j.attempts >= ?
            AND j.generation = c.generation
            AND NOT EXISTS (
              SELECT 1 FROM jobs AS earlier
              WHERE earlier.conversation_key = j.conversation_key
                AND earlier.sequence < j.sequence
                AND earlier.status IN ('queued', 'running')
            )
          ORDER BY j.id
        `)
        .all(maxAttempts);
      for (const job of exhausted) {
        this.db
          .query(`
            UPDATE jobs
            SET status = 'failed',
                error = CASE
                  WHEN error IS NULL OR error = '' THEN 'attempts_exhausted'
                  ELSE error || '; attempts_exhausted'
                END,
                updated_at = ?
            WHERE id = ? AND status = 'queued'
          `)
          .run(now, job.id);
        this.db
          .query(`
            INSERT INTO outbound_replies (
              update_id, chat_id, text, status, attempts, next_chunk_index,
              next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)
          `)
          .run(
            job.update_id,
            job.telegram_chat_id,
            replyText,
            now,
            now,
            now,
          );
      }
      return exhausted.length;
    });
    return fail.immediate();
  }

  getConversation(conversationKey: string): StoredConversation | null {
    const row = this.db
      .query<ConversationRow, [string]>(`
        SELECT * FROM conversations WHERE conversation_key = ?
      `)
      .get(conversationKey);
    return row ? mapConversation(row) : null;
  }

  resetConversation(conversationKey: string, now = Date.now()): number {
    validateTimestamp(now);
    const reset = this.db.transaction(() =>
      this.resetConversationWithinTransaction(conversationKey, now));
    return reset.immediate();
  }

  lookupIdentity: IdentityLookup = (userId) => {
    const user = this.db
      .query<{ role: Role; status: "active" | "inactive" }, [number]>(`
        SELECT role, status FROM users WHERE telegram_user_id = ?
      `)
      .get(userId);
    const blocked = this.isBlocked(userId);
    if (!user && !blocked) return null;
    return {
      role: user?.role ?? "guest",
      status: user?.status ?? "inactive",
      blocked,
    } satisfies StoredIdentity;
  };

  blockUser(
    userId: number,
    blockedBy: number,
    reason: string | null = null,
    now = Date.now(),
  ): void {
    validateTimestamp(now);
    this.db
      .query(`
        INSERT INTO blocks (telegram_user_id, reason, blocked_by, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_user_id) DO UPDATE SET
          reason = excluded.reason,
          blocked_by = excluded.blocked_by,
          created_at = excluded.created_at
      `)
      .run(userId, reason, blockedBy, now);
  }

  unblockUser(userId: number): boolean {
    return (
      this.db
        .query("DELETE FROM blocks WHERE telegram_user_id = ?")
        .run(userId).changes > 0
    );
  }

  isBlocked(userId: number): boolean {
    return Boolean(
      this.db
        .query<{ found: number }, [number]>(`
          SELECT 1 AS found FROM blocks WHERE telegram_user_id = ?
        `)
        .get(userId),
    );
  }

  getSetting(key: string): string | null {
    return (
      this.db
        .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
        .get(key)?.value ?? null
    );
  }

  setSetting(key: string, value: string, now = Date.now()): void {
    validateTimestamp(now);
    this.db
      .query(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  private insertAdminUpdate(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
    now: number,
  ): boolean {
    const payloadJson = JSON.stringify(update);
    if (payloadJson === undefined) throw new Error("admin update payload is not serializable");
    return Boolean(
      this.db
        .query<{ update_id: number }, [number, string, string, number]>(`
          INSERT INTO updates (
            update_id, conversation_key, processing_state, payload_json, created_at
          ) VALUES (?, ?, 'accepted', ?, ?)
          ON CONFLICT(update_id) DO NOTHING
          RETURNING update_id
        `)
        .get(update.updateId, identity.conversationKey, payloadJson, now),
    );
  }

  private insertOutboundReply(
    updateId: number,
    chatId: number,
    text: string,
    now: number,
  ): void {
    this.db
      .query(`
        INSERT INTO outbound_replies (
          update_id, chat_id, text, status, attempts, next_chunk_index,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)
      `)
      .run(updateId, chatId, text, now, now, now);
  }

  private executeAdminAction(
    action: AdminMutationAction,
    requestedBy: number,
    now: number,
  ): string {
    switch (action.type) {
      case "access":
        this.db
          .query(`
            INSERT INTO settings (key, value, updated_at) VALUES ('guest_access_mode', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `)
          .run(action.mode, now);
        return `Guest access mode is now ${action.mode}.`;
      case "block":
        if (this.adminChatIds.has(action.userId)) {
          throw new Error("configured administrators cannot be blocked");
        }
        this.db
          .query(`
            INSERT INTO blocks (telegram_user_id, reason, blocked_by, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(telegram_user_id) DO UPDATE SET
              reason = excluded.reason,
              blocked_by = excluded.blocked_by,
              created_at = excluded.created_at
          `)
          .run(action.userId, action.reason, requestedBy, now);
        return `Telegram user ${action.userId} is blocked.`;
      case "cancel": {
        const job = this.db
          .query<{
            status: JobStatus;
            conversation_key: string;
          }, [number]>(`
            SELECT status, conversation_key FROM jobs WHERE id = ?
          `)
          .get(action.jobId);
        if (!job) return `Job ${action.jobId} was not found.`;
        if (job.status !== "queued" && job.status !== "running") {
          return `Job ${action.jobId} is already ${job.status}.`;
        }
        this.db
          .query(`
            UPDATE jobs
            SET status = 'failed', lease_owner = NULL, lease_token = NULL,
                lease_until = NULL, error = 'admin_cancelled', updated_at = ?
            WHERE id = ? AND status IN ('queued', 'running')
          `)
          .run(now, action.jobId);
        // A running worker is fenced immediately, but its conversation lease is
        // retained until expiry so the next turn cannot overlap its shutdown.
        return `Job ${action.jobId} was cancelled.`;
      }
      case "reset": {
        const conversation = this.db
          .query<{ telegram_chat_id: number }, [string]>(`
            SELECT telegram_chat_id FROM conversations WHERE conversation_key = ?
          `)
          .get(action.conversationKey);
        if (
          !conversation ||
          !conversationKeyMatchesChat(action.conversationKey, conversation.telegram_chat_id)
        ) {
          return `Conversation ${action.conversationKey} was not found.`;
        }
        const generation = this.resetConversationWithinTransaction(action.conversationKey, now);
        return `Conversation ${action.conversationKey} reset to generation ${generation}.`;
      }
      case "restart":
        return "Restart requested.";
    }
  }

  private resetConversationWithinTransaction(conversationKey: string, now: number): number {
    const row = this.db
      .query<{ generation: number }, [number, number, number, number, string]>(`
        UPDATE conversations
        SET session_id = NULL, session_role = NULL,
            generation = generation + 1, state = 'active',
            lease_owner = CASE WHEN lease_until > ? THEN lease_owner ELSE NULL END,
            lease_until = CASE WHEN lease_until > ? THEN lease_until ELSE NULL END,
            last_activity_at = ?, updated_at = ?
        WHERE conversation_key = ?
        RETURNING generation
      `)
      .get(now, now, now, now, conversationKey);
    if (!row) throw new Error("conversation not found");
    this.db
      .query(`
        UPDATE jobs
        SET status = 'failed', lease_owner = NULL, lease_token = NULL,
            lease_until = NULL, error = 'conversation_reset', updated_at = ?
        WHERE conversation_key = ? AND generation < ?
          AND status IN ('queued', 'running')
      `)
      .run(now, conversationKey, row.generation);
    return row.generation;
  }

  private validateAdminIdentity(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
  ): void {
    this.validateAcceptedIdentity(update, identity);
    if (identity.role !== "admin" || !this.adminChatIds.has(identity.userId)) {
      throw new Error("admin command requires a configured numeric administrator");
    }
  }

  private recoverExpiredLeasesWithinTransaction(
    now: number,
    exclusions: NormalizedLeaseExclusions = { jobIds: [], conversationKeys: [] },
  ): number {
    const excludedJobs = sqlNotIn("id", exclusions.jobIds.length);
    const recovered = this.db
      .query(`
        UPDATE jobs
        SET status = 'queued', lease_owner = NULL, lease_token = NULL,
            lease_until = NULL, updated_at = ?
        WHERE status = 'running' AND lease_until <= ?
          ${excludedJobs}
      `)
      .run(now, now, ...exclusions.jobIds).changes;
    const excludedConversations = sqlNotIn(
      "conversation_key",
      exclusions.conversationKeys.length,
    );
    this.db
      .query(`
        UPDATE conversations
        SET lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE lease_until <= ?
          ${excludedConversations}
      `)
      .run(now, now, ...exclusions.conversationKeys);
    return recovered;
  }

  private validateAcceptedIdentity(
    update: NormalizedUpdate,
    identity: AcceptedIdentity,
  ): void {
    const { chat, sender } = update.message;
    if (
      !Number.isSafeInteger(update.updateId) ||
      !Number.isSafeInteger(sender.id) ||
      !Number.isSafeInteger(chat.id)
    ) {
      throw new Error("normalized Telegram IDs must be safe integers");
    }

    const conversationKey =
      chat.type === "private" ? `dm:${chat.id}` : `group:${chat.id}`;
    if (
      identity.userId !== sender.id ||
      identity.chatId !== chat.id ||
      identity.chatType !== chat.type ||
      identity.conversationKey !== conversationKey
    ) {
      throw new Error("identity does not match normalized update");
    }

    const expectedRole = this.adminChatIds.has(sender.id) ? "admin" : "guest";
    if (identity.role !== expectedRole) {
      throw new Error("identity role does not match configured authorization");
    }
  }

  private finishJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    status: "queued" | "completed" | "failed",
    detail: string | null,
    sessionId: string | null,
    sessionRole: Role | null,
    replyText: string | null,
    now: number,
  ): boolean {
    validateTimestamp(now);
    const finish = this.db.transaction(() => {
      const job = this.db
        .query<
          { conversation_key: string; update_id: number; telegram_chat_id: number },
          [number, string, string, number, string, number]
        >(`
          SELECT j.conversation_key, j.update_id, c.telegram_chat_id
          FROM jobs AS j
          JOIN conversations AS c ON c.conversation_key = j.conversation_key
          WHERE j.id = ? AND j.status = 'running'
            AND j.lease_owner = ? AND j.lease_token = ? AND j.lease_until > ?
            AND j.generation = c.generation
            AND c.lease_owner = ? AND c.lease_until > ?
        `)
        .get(jobId, leaseOwner, leaseToken, now, leaseOwner, now);
      if (!job) return false;

      this.db
        .query(`
          UPDATE jobs
          SET status = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              error = ?, result = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          status,
          status === "completed" ? null : detail,
          status === "completed" ? detail : null,
          now,
          jobId,
        );
      this.db
        .query(`
          UPDATE conversations
          SET session_id = COALESCE(?, session_id),
              session_role = COALESCE(?, session_role), lease_owner = NULL,
              lease_until = NULL, last_activity_at = ?, updated_at = ?
          WHERE conversation_key = ? AND lease_owner = ?
        `)
        .run(sessionId, sessionRole, now, now, job.conversation_key, leaseOwner);
      if (replyText !== null) {
        this.db
          .query(`
            INSERT INTO outbound_replies (
              update_id, chat_id, text, status, attempts, next_chunk_index,
              next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?)
          `)
          .run(
            job.update_id,
            job.telegram_chat_id,
            replyText,
            now,
            now,
            now,
          );
      }
      return true;
    });
    return finish.immediate();
  }

  private rescheduleJob(
    jobId: number,
    leaseOwner: string,
    leaseToken: string,
    error: string,
    nextAttemptAt: number,
    restoreAttempt: boolean,
    now: number,
  ): boolean {
    const reschedule = this.db.transaction(() => {
      const job = this.db
        .query<
          { conversation_key: string },
          [number, string, string, number, string, number]
        >(`
          SELECT j.conversation_key
          FROM jobs AS j
          JOIN conversations AS c ON c.conversation_key = j.conversation_key
          WHERE j.id = ? AND j.status = 'running'
            AND j.lease_owner = ? AND j.lease_token = ? AND j.lease_until > ?
            AND j.generation = c.generation
            AND c.lease_owner = ? AND c.lease_until > ?
        `)
        .get(jobId, leaseOwner, leaseToken, now, leaseOwner, now);
      if (!job) return false;

      this.db
        .query(`
          UPDATE jobs
          SET status = 'queued',
              attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END,
              lease_owner = NULL, lease_token = NULL, lease_until = NULL,
              error = ?, result = NULL, updated_at = ?
          WHERE id = ?
        `)
        .run(restoreAttempt ? 1 : 0, error, nextAttemptAt, jobId);
      this.db
        .query(`
          UPDATE conversations
          SET lease_owner = NULL, lease_until = NULL,
              last_activity_at = ?, updated_at = ?
          WHERE conversation_key = ? AND lease_owner = ?
        `)
        .run(now, now, job.conversation_key, leaseOwner);
      return true;
    });
    return reschedule.immediate();
  }

  private createSchema(db: Database = this.db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_user_id INTEGER PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        telegram_chat_id INTEGER PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('private', 'group', 'supergroup')),
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        title TEXT,
        username TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memberships (
        telegram_user_id INTEGER NOT NULL REFERENCES users(telegram_user_id),
        telegram_chat_id INTEGER NOT NULL REFERENCES chats(telegram_chat_id),
        effective_role TEXT NOT NULL CHECK (effective_role IN ('admin', 'guest')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (telegram_user_id, telegram_chat_id)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        conversation_key TEXT PRIMARY KEY,
        telegram_chat_id INTEGER NOT NULL REFERENCES chats(telegram_chat_id),
        session_id TEXT,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        state TEXT NOT NULL DEFAULT 'active',
        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
        lease_owner TEXT,
        lease_until INTEGER,
        last_activity_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        session_role TEXT CHECK (session_role IN ('admin', 'guest')),
        CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
      );

      CREATE TABLE IF NOT EXISTS updates (
        update_id INTEGER PRIMARY KEY,
        conversation_key TEXT NOT NULL,
        processing_state TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE REFERENCES updates(update_id),
        conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
        generation INTEGER NOT NULL CHECK (generation > 0),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_token TEXT,
        lease_until INTEGER,
        error TEXT,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (conversation_key, sequence),
        CHECK (
          (lease_owner IS NULL) = (lease_until IS NULL)
          AND (lease_owner IS NULL) = (lease_token IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS jobs_eligible_idx
        ON jobs (status, created_at, id);
      CREATE INDEX IF NOT EXISTS jobs_conversation_idx
        ON jobs (conversation_key, sequence);

      CREATE TABLE IF NOT EXISTS blocks (
        telegram_user_id INTEGER PRIMARY KEY,
        reason TEXT,
        blocked_by INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_admin_actions (
        token TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        requested_by INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
    `);
    this.createOutboundRepliesSchema(db);
  }

  private migrateAndValidateSchema(): void {
    const migrate = this.db.transaction(() => {
      const version = this.readSchemaVersion();
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `database schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
        );
      }

      if (version === 0) {
        const existing = this.db
          .query<{ name: string }, []>(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            LIMIT 1
          `)
          .get();
        if (existing) {
          throw new Error("unversioned database contains existing schema");
        }
        this.createSchema();
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else if (version === 1) {
        this.createOutboundRepliesSchema();
        this.addSessionRoleColumn();
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else if (version === 2) {
        this.db.exec(`
          ALTER TABLE outbound_replies
          ADD COLUMN next_chunk_index INTEGER NOT NULL DEFAULT 0
            CHECK (next_chunk_index >= 0)
        `);
        this.addSessionRoleColumn();
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else if (version === 3) {
        this.addSessionRoleColumn();
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }

      this.validateSchema();
    });
    migrate.immediate();
  }

  private addSessionRoleColumn(db: Database = this.db): void {
    const columns = readColumns(db, "conversations");
    if (columns.length === 0 || columns.some(({ name }) => name === "session_role")) {
      return;
    }
    db.exec(`
      ALTER TABLE conversations
      ADD COLUMN session_role TEXT CHECK (session_role IN ('admin', 'guest'))
    `);
  }

  private createOutboundRepliesSchema(db: Database = this.db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS outbound_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id INTEGER NOT NULL UNIQUE REFERENCES updates(update_id),
        chat_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'leased', 'delivered', 'failed')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        next_chunk_index INTEGER NOT NULL DEFAULT 0 CHECK (next_chunk_index >= 0),
        CHECK (
          (lease_owner IS NULL) = (lease_until IS NULL)
          AND (lease_owner IS NULL) = (lease_token IS NULL)
          AND ((status = 'leased') = (lease_owner IS NOT NULL))
        )
      );
      CREATE INDEX IF NOT EXISTS outbound_replies_due_idx
        ON outbound_replies (status, next_attempt_at, id);
    `);
  }

  private readSchemaVersion(): number {
    const row = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    if (!row || !Number.isSafeInteger(row.user_version) || row.user_version < 0) {
      throw new Error("database returned an invalid schema version");
    }
    return row.user_version;
  }

  private validateSchema(): void {
    const expected = new Database(":memory:", { strict: true });
    try {
      this.createSchema(expected);
      for (const table of Object.keys(REQUIRED_SCHEMA)) {
        if (!metadataMatches(readColumns(this.db, table), readColumns(expected, table))) {
          throw new Error(`schema validation failed for table ${table}`);
        }
        if (
          !metadataMatches(
            readCheckConstraints(this.db, table),
            readCheckConstraints(expected, table),
          )
        ) {
          throw new Error(`schema validation failed for CHECK constraints on table ${table}`);
        }
        if (
          !metadataMatches(
            readForeignKeys(this.db, table),
            readForeignKeys(expected, table),
          )
        ) {
          throw new Error(`schema validation failed for foreign keys on table ${table}`);
        }
        if (!metadataMatches(readIndexes(this.db, table), readIndexes(expected, table))) {
          throw new Error(`schema validation failed for indexes on table ${table}`);
        }
      }
    } finally {
      expected.close();
    }
  }
}

function mapConversation(row: ConversationRow): StoredConversation {
  return {
    key: row.conversation_key,
    chatId: row.telegram_chat_id,
    sessionId: row.session_id,
    sessionRole: row.session_role,
    generation: row.generation,
    state: row.state,
    nextSequence: row.next_sequence,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastActivityAt: row.last_activity_at,
  };
}

function mapOutboundReply(row: OutboundReplyRow): StoredOutboundReply {
  return {
    id: row.id,
    updateId: row.update_id,
    chatId: row.chat_id,
    text: row.text,
    status: row.status,
    attempts: row.attempts,
    nextChunkIndex: row.next_chunk_index,
    nextAttemptAt: row.next_attempt_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
  };
}

function normalizeActiveLeases(
  activeLeases: readonly ActiveLeaseDescriptor[],
): NormalizedLeaseExclusions {
  if (!Array.isArray(activeLeases)) {
    throw new Error("active leases must be paired descriptors");
  }
  const jobIds = new Set<number>();
  const conversationKeys = new Set<string>();
  for (const activeLease of activeLeases) {
    const jobId = activeLease?.jobId;
    const conversationKey = activeLease?.conversationKey;
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      throw new Error("active lease job ID must be a positive safe integer");
    }
    if (
      typeof conversationKey !== "string"
      || !/^(?:dm|group):-?\d+$/.test(conversationKey)
    ) {
      throw new Error("active lease conversation key is invalid");
    }
    jobIds.add(jobId);
    conversationKeys.add(conversationKey);
  }
  return { jobIds: [...jobIds], conversationKeys: [...conversationKeys] };
}

function sqlNotIn(column: string, count: number): string {
  return count === 0
    ? ""
    : `AND ${column} NOT IN (${Array.from({ length: count }, () => "?").join(", ")})`;
}

function calculateLeaseUntil(now: number, leaseMs: number): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("lease duration must be a positive safe integer");
  }
  validateTimestamp(now);

  const leaseUntil = now + leaseMs;
  if (!Number.isSafeInteger(leaseUntil)) {
    throw new Error("lease expiry exceeds safe integer range");
  }
  return leaseUntil;
}

function validateUpdateId(updateId: number): void {
  if (!Number.isSafeInteger(updateId) || updateId < 0) {
    throw new Error("Telegram update ID must be a non-negative safe integer");
  }
}

function validateAttemptLimit(maxAttempts: number): void {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error("outbound reply attempt limit must be a positive safe integer");
  }
}

interface ColumnMetadata {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | null;
  primaryKeyPosition: number;
}

interface ForeignKeyMetadata {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
  match: string;
}

interface IndexColumnMetadata {
  sequence: number;
  columnId: number;
  name: string | null;
  descending: number;
  collation: string | null;
  key: number;
}

interface IndexMetadata {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: IndexColumnMetadata[];
}

function readColumns(db: Database, table: string): ColumnMetadata[] {
  return db
    .query<
      {
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      },
      []
    >(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => ({
      name: row.name,
      type: row.type,
      notnull: row.notnull,
      defaultValue: row.dflt_value,
      primaryKeyPosition: row.pk,
    }));
}

function readForeignKeys(db: Database, table: string): ForeignKeyMetadata[] {
  return db
    .query<
      {
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      },
      []
    >(`PRAGMA foreign_key_list(${table})`)
    .all()
    .map((row) => ({
      id: row.id,
      sequence: row.seq,
      table: row.table,
      from: row.from,
      to: row.to,
      onUpdate: row.on_update,
      onDelete: row.on_delete,
      match: row.match,
    }));
}

function readCheckConstraints(db: Database, table: string): string[] {
  const sql = db
    .query<{ sql: string | null }, [string]>(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
    `)
    .get(table)?.sql;
  if (!sql) return [];
  return extractCheckExpressions(sql).map(normalizeSqlExpression);
}

function extractCheckExpressions(sql: string): string[] {
  const expressions: string[] = [];
  const upper = sql.toUpperCase();
  let searchFrom = 0;

  while (searchFrom < sql.length) {
    const checkAt = upper.indexOf("CHECK", searchFrom);
    if (checkAt < 0) break;
    const before = checkAt === 0 ? "" : upper[checkAt - 1]!;
    const after = upper[checkAt + 5] ?? "";
    if (/\w/.test(before) || /\w/.test(after)) {
      searchFrom = checkAt + 5;
      continue;
    }

    let openAt = checkAt + 5;
    while (/\s/.test(sql[openAt] ?? "")) openAt++;
    if (sql[openAt] !== "(") {
      searchFrom = checkAt + 5;
      continue;
    }

    let depth = 0;
    let quote: "'" | '"' | "`" | null = null;
    for (let index = openAt; index < sql.length; index++) {
      const character = sql[index]!;
      if (quote) {
        if (character === quote) {
          if (sql[index + 1] === quote) {
            index++;
          } else {
            quote = null;
          }
        }
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
      } else if (character === "(") {
        depth++;
      } else if (character === ")") {
        depth--;
        if (depth === 0) {
          expressions.push(sql.slice(openAt + 1, index));
          searchFrom = index + 1;
          break;
        }
      }
    }

    if (depth !== 0) throw new Error("schema validation failed: malformed CHECK constraint");
  }
  return expressions;
}

function normalizeSqlExpression(expression: string): string {
  let normalized = "";
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]!;
    if (quote) {
      normalized += character;
      if (character === quote) {
        if (expression[index + 1] === quote) {
          normalized += expression[++index]!;
        } else {
          quote = null;
        }
      }
    } else if (character === "'" || character === '"' || character === "`") {
      quote = character;
      normalized += character;
    } else {
      normalized += character.toUpperCase();
    }
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function readIndexes(db: Database, table: string): IndexMetadata[] {
  return db
    .query<
      { name: string; unique: number; origin: string; partial: number },
      []
    >(`PRAGMA index_list(${table})`)
    .all()
    .map((index) => ({
      name: index.name,
      unique: index.unique,
      origin: index.origin,
      partial: index.partial,
      columns: db
        .query<
          {
            seqno: number;
            cid: number;
            name: string | null;
            desc: number;
            coll: string | null;
            key: number;
          },
          []
        >(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`)
        .all()
        .map((column) => ({
          sequence: column.seqno,
          columnId: column.cid,
          name: column.name,
          descending: column.desc,
          collation: column.coll,
          key: column.key,
        })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function metadataMatches(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function validateTimestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("timestamp must be a non-negative safe integer");
  }
}

function conversationKeyMatchesChat(conversationKey: string, chatId: number): boolean {
  return conversationKey === (chatId < 0 ? `group:${chatId}` : `dm:${chatId}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapJob(row: JobRow): StoredJob {
  return {
    id: row.id,
    updateId: row.update_id,
    conversationKey: row.conversation_key,
    generation: row.generation,
    sequence: row.sequence,
    status: row.status,
    role: row.role,
    payload: JSON.parse(row.payload_json) as NormalizedUpdate,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    error: row.error,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
