import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config";
import { resolveIdentity } from "../src/policy";
import type {
  IdentityLookup,
  MultiUserConfig,
  NormalizedUpdate,
} from "../src/types";

const publicConfig: MultiUserConfig = {
  adminChatIds: new Set([11]),
  guestAccessMode: "public",
};

function update(
  chatId: number,
  senderId: number,
  chatType: "private" | "group" | "supergroup" = "private",
  username?: string,
): NormalizedUpdate {
  return {
    updateId: 100,
    message: {
      messageId: 200,
      date: 1_752_528_000,
      text: "hello",
      sender: { id: senderId, username },
      chat: { id: chatId, type: chatType },
    },
  };
}

describe("resolveIdentity", () => {
  test("authorizes administrators by numeric sender ID", () => {
    expect(resolveIdentity(publicConfig, update(11, 11))).toMatchObject({
      accepted: true,
      role: "admin",
      userId: 11,
      conversationKey: "dm:11",
    });
  });

  test("does not use Telegram usernames as authorization credentials", () => {
    const result = resolveIdentity(
      publicConfig,
      update(22, 22, "private", "admin"),
    );

    expect(result).toMatchObject({ accepted: true, role: "guest", userId: 22 });
  });

  test("automatically accepts unknown guests in public mode", () => {
    expect(resolveIdentity(publicConfig, update(22, 22))).toMatchObject({
      accepted: true,
      role: "guest",
      conversationKey: "dm:22",
    });
  });

  test("rejects unknown users in invite mode", () => {
    const config: MultiUserConfig = {
      ...publicConfig,
      guestAccessMode: "invite",
    };

    expect(resolveIdentity(config, update(22, 22))).toEqual({
      accepted: false,
      reason: "invite_required",
      userId: 22,
      chatId: 22,
    });
  });

  test("accepts only existing active guests in invite mode", () => {
    const config: MultiUserConfig = {
      ...publicConfig,
      guestAccessMode: "invite",
    };
    const activeLookup: IdentityLookup = () => ({
      role: "guest",
      status: "active",
    });
    const inactiveLookup: IdentityLookup = () => ({
      role: "guest",
      status: "inactive",
    });

    expect(resolveIdentity(config, update(22, 22), activeLookup)).toMatchObject({
      accepted: true,
      role: "guest",
    });
    expect(resolveIdentity(config, update(22, 22), inactiveLookup)).toMatchObject({
      accepted: false,
      reason: "invite_required",
    });
  });

  test("uses one shared conversation key for groups and supergroups", () => {
    expect(resolveIdentity(publicConfig, update(-100, 22, "group"))).toMatchObject({
      accepted: true,
      role: "guest",
      conversationKey: "group:-100",
    });
    expect(
      resolveIdentity(publicConfig, update(-200, 33, "supergroup")),
    ).toMatchObject({
      accepted: true,
      role: "guest",
      conversationKey: "group:-200",
    });
  });
});

describe("loadConfig", () => {
  test("parses numeric administrator IDs and defaults to public access", () => {
    const config = loadConfig({ ADMIN_CHAT_IDS: "11, -22,11" });

    expect([...config.adminChatIds]).toEqual([11, -22]);
    expect(config.guestAccessMode).toBe("public");
  });

  test("rejects non-numeric administrator identities", () => {
    expect(() => loadConfig({ ADMIN_CHAT_IDS: "11,@admin" })).toThrow(
      "ADMIN_CHAT_IDS must contain only numeric Telegram IDs",
    );
  });

  test("rejects unsupported guest access modes", () => {
    expect(() =>
      loadConfig({ ADMIN_CHAT_IDS: "11", GUEST_ACCESS_MODE: "closed" }),
    ).toThrow("GUEST_ACCESS_MODE must be public or invite");
  });
});
