export type Role = "admin" | "guest";
export type AccessMode = "public" | "invite";
export type ChatType = "private" | "group" | "supergroup";
export type UserStatus = "active" | "inactive";

export function encodeConversationKey(conversationKey: string): string {
  if (!/^(?:dm|group):-?\d+$/.test(conversationKey)) {
    throw new Error("conversation key is invalid");
  }
  const encoded = encodeURIComponent(conversationKey);
  if (encoded.includes("/") || encoded.includes("\\")) {
    throw new Error("encoded conversation key is not a safe path component");
  }
  return encoded;
}

export interface MultiUserConfig {
  adminChatIds: ReadonlySet<number>;
  guestAccessMode: AccessMode;
}

export interface NormalizedUser {
  id: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface NormalizedChat {
  id: number;
  type: ChatType;
  title?: string;
  username?: string;
}

export interface NormalizedAttachment {
  kind: "document" | "photo" | "audio" | "video" | "voice";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  localPath?: string;
}

export interface NormalizedMessage {
  messageId: number;
  date: number;
  text: string;
  sender: NormalizedUser;
  chat: NormalizedChat;
  attachments?: readonly NormalizedAttachment[];
}

export interface NormalizedUpdate {
  updateId: number;
  message: NormalizedMessage;
}

export interface StoredIdentity {
  role: Role;
  status: UserStatus;
  blocked?: boolean;
}

export type IdentityLookup = (userId: number) => StoredIdentity | null;

export interface AcceptedIdentity {
  accepted: true;
  role: Role;
  userId: number;
  chatId: number;
  chatType: ChatType;
  conversationKey: string;
}

export interface RejectedIdentity {
  accepted: false;
  reason: "blocked" | "invite_required";
  userId: number;
  chatId: number;
}

export type ResolvedIdentity = AcceptedIdentity | RejectedIdentity;

export type JobStatus = "queued" | "running" | "completed" | "failed";
export type OutboundReplyStatus = "pending" | "leased" | "delivered" | "failed";

export type AdminMutationAction =
  | { type: "access"; mode: AccessMode }
  | { type: "block"; userId: number; reason: string | null }
  | { type: "cancel"; jobId: number }
  | { type: "reset"; conversationKey: string }
  | { type: "restart" };

export interface EmergencyResult {
  ok: boolean;
  message: string;
}

export interface StoredConversation {
  key: string;
  chatId: number;
  sessionId: string | null;
  sessionRole: Role | null;
  generation: number;
  state: string;
  nextSequence: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  lastActivityAt: number;
}

export interface StoredJob {
  id: number;
  updateId: number;
  conversationKey: string;
  generation: number;
  sequence: number;
  status: JobStatus;
  role: Role;
  payload: NormalizedUpdate;
  attempts: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  error: string | null;
  result?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredOutboundReply {
  id: number;
  updateId: number;
  chatId: number;
  text: string;
  status: OutboundReplyStatus;
  attempts: number;
  nextChunkIndex: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
}
