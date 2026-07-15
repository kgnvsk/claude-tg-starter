import type { AccessMode, MultiUserConfig } from "./types";

type Environment = Record<string, string | undefined>;

function parseAdminIds(value: string | undefined): ReadonlySet<number> {
  const ids = new Set<number>();

  for (const token of (value ?? "").split(",")) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (!/^-?\d+$/.test(trimmed)) {
      throw new Error("ADMIN_CHAT_IDS must contain only numeric Telegram IDs");
    }

    const id = Number(trimmed);
    if (!Number.isSafeInteger(id)) {
      throw new Error("ADMIN_CHAT_IDS must contain only numeric Telegram IDs");
    }
    ids.add(id);
  }

  return ids;
}

export function loadConfig(env: Environment = Bun.env): MultiUserConfig {
  const accessMode = env.GUEST_ACCESS_MODE ?? "public";
  if (accessMode !== "public" && accessMode !== "invite") {
    throw new Error("GUEST_ACCESS_MODE must be public or invite");
  }

  return {
    adminChatIds: parseAdminIds(env.ADMIN_CHAT_IDS),
    guestAccessMode: accessMode as AccessMode,
  };
}
