import type {
  IdentityLookup,
  MultiUserConfig,
  NormalizedUpdate,
  ResolvedIdentity,
} from "./types";

const unknownIdentity: IdentityLookup = () => null;

export function resolveIdentity(
  config: MultiUserConfig,
  update: NormalizedUpdate,
  lookup: IdentityLookup = unknownIdentity,
): ResolvedIdentity {
  const { chat, sender } = update.message;
  const stored = lookup(sender.id);

  if (stored?.blocked) {
    return {
      accepted: false,
      reason: "blocked",
      userId: sender.id,
      chatId: chat.id,
    };
  }

  const isAdmin = config.adminChatIds.has(sender.id);
  const isActiveGuest = stored?.role === "guest" && stored.status === "active";
  if (!isAdmin && config.guestAccessMode === "invite" && !isActiveGuest) {
    return {
      accepted: false,
      reason: "invite_required",
      userId: sender.id,
      chatId: chat.id,
    };
  }

  return {
    accepted: true,
    role: isAdmin ? "admin" : "guest",
    userId: sender.id,
    chatId: chat.id,
    chatType: chat.type,
    conversationKey:
      chat.type === "private" ? `dm:${chat.id}` : `group:${chat.id}`,
  };
}
