import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdminController } from "../src/admin";
import { Receiver } from "../src/receiver";
import { Store } from "../src/store";
import type { AcceptedIdentity, MultiUserConfig, NormalizedUpdate } from "../src/types";

const directories: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(adminIds = new Set([11, 12])): Store {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-admin-"));
  directories.push(directory);
  const store = new Store(join(directory, "state.sqlite"), { adminChatIds: adminIds });
  stores.push(store);
  return store;
}

function update(updateId: number, text: string, senderId = 11, chatId = senderId): NormalizedUpdate {
  return {
    updateId,
    message: {
      messageId: updateId * 10,
      date: 1_752_528_000,
      text,
      sender: { id: senderId },
      chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" },
    },
  };
}

function identity(userId = 11, chatId = userId, role: "admin" | "guest" = "admin"): AcceptedIdentity {
  return {
    accepted: true,
    role,
    userId,
    chatId,
    chatType: chatId < 0 ? "supergroup" : "private",
    conversationKey: chatId < 0 ? `group:${chatId}` : `dm:${chatId}`,
  };
}

function actionToken(store: Store): string {
  const row = store.db
    .query<{ token: string }, []>("SELECT token FROM pending_admin_actions ORDER BY rowid DESC LIMIT 1")
    .get();
  if (!row) throw new Error("confirmation token was not created");
  return row.token;
}

function fakeTelegram() {
  return {
    getUpdates: async () => [],
    sendMessage: async () => ({}),
    getFile: async () => ({}),
    downloadAttachment: async () => ({ path: "/unused", created: false }),
    removeAttachment: async () => {},
  };
}

describe("AdminController", () => {
  test("records a mutation request, confirmation, and durable replies exactly once", async () => {
    const store = createStore();
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    expect(await admin.handle(update(1, "/access invite"), identity())).toBe("handled");
    expect(await admin.handle(update(1, "/access invite"), identity())).toBe("duplicate");
    expect(store.getSetting("guest_access_mode")).toBeNull();
    expect(store.listOutboundReplies()).toHaveLength(1);

    const token = actionToken(store);
    expect(await admin.handle(update(2, `/confirm ${token}`), identity())).toBe("handled");
    expect(store.getSetting("guest_access_mode")).toBe("invite");
    expect(store.listOutboundReplies()).toHaveLength(2);
    expect(await admin.handle(update(2, `/confirm ${token}`), identity())).toBe("duplicate");

    expect(await admin.handle(update(3, `/confirm ${token}`), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toContain("already used");

    expect(await admin.handle(update(4, "/access public"), identity())).toBe("handled");
    expect(await admin.handle(update(5, `/confirm ${actionToken(store)}`), identity())).toBe("handled");
    expect(store.getSetting("guest_access_mode")).toBe("public");
  });

  test("rejects expired confirmations and confirmations from another admin", async () => {
    let now = 1_000;
    const store = createStore();
    const admin = new AdminController({
      store,
      adminIds: new Set([11, 12]),
      confirmationTtlMs: 500,
      clock: () => now,
    });

    await admin.handle(update(1, "/access invite"), identity(11));
    const wrongAdminToken = actionToken(store);
    expect(await admin.handle(update(2, `/confirm ${wrongAdminToken}`, 12), identity(12))).toBe("handled");
    expect(store.getSetting("guest_access_mode")).toBeNull();
    expect(store.listOutboundReplies().at(-1)?.text).toContain("another administrator");

    await admin.handle(update(3, "/access invite"), identity(11));
    const expiredToken = actionToken(store);
    now = 1_501;
    expect(await admin.handle(update(4, `/confirm ${expiredToken}`), identity(11))).toBe("handled");
    expect(store.getSetting("guest_access_mode")).toBeNull();
    expect(store.listOutboundReplies().at(-1)?.text).toContain("expired");
    expect(store.db.query<{ consumed_at: number | null }, [string]>(
      "SELECT consumed_at FROM pending_admin_actions WHERE token = ?",
    ).get(expiredToken)?.consumed_at).toBe(1_501);
  });

  test("strictly rejects a persisted action with unexpected JSON fields", async () => {
    const store = createStore();
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });
    await admin.handle(update(1, "/access invite"), identity(11));
    const token = actionToken(store);
    store.db.query("UPDATE pending_admin_actions SET payload_json = ? WHERE token = ?")
      .run(JSON.stringify({ type: "access", mode: "invite", extra: true }), token);

    expect(await admin.handle(update(2, `/confirm ${token}`), identity(11))).toBe("handled");
    expect(store.getSetting("guest_access_mode")).toBeNull();
    expect(store.listOutboundReplies().at(-1)?.text).toContain("unexpected fields");
    expect(store.db.query<{ consumed_at: number | null }, [string]>(
      "SELECT consumed_at FROM pending_admin_actions WHERE token = ?",
    ).get(token)?.consumed_at).toBe(1_000);
  });

  test("supports exact Russian access aliases and leaves similar text alone", async () => {
    const store = createStore();
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    expect(await admin.handle(update(1, "Открой доступ для всех"), identity())).toBe("handled");
    expect(await admin.handle(update(2, "Переключи доступ только по приглашениям"), identity())).toBe("handled");
    expect(await admin.handle(update(3, "открой доступ для всех, пожалуйста"), identity())).toBe("not_handled");

    expect(store.db.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_admin_actions").get()?.count)
      .toBe(2);
  });

  test("supports conservative exact Russian aliases for every owner control", async () => {
    const store = createStore();
    store.acceptUpdate(update(50, "queued", 44), identity(44, 44, "guest"), 900);
    store.blockUser(55, 11, "old", 901);
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    expect(await admin.handle(update(1, "Покажи активные задачи"), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toContain("dm:44");
    expect(await admin.handle(update(2, "Заблокируй пользователя 66"), identity())).toBe("handled");
    expect(await admin.handle(update(3, "Разблокируй пользователя 55"), identity())).toBe("handled");
    expect(store.isBlocked(55)).toBe(false);
    expect(await admin.handle(update(4, "Отмени задачу 1"), identity())).toBe("handled");
    expect(await admin.handle(update(5, "Сбрось диалог 44"), identity())).toBe("handled");
    expect(await admin.handle(update(6, "покажи все активные задачи"), identity())).toBe("not_handled");

    const actionTypes = store.db
      .query<{ action_type: string }, []>("SELECT action_type FROM pending_admin_actions ORDER BY rowid")
      .all()
      .map(({ action_type }) => action_type);
    expect(actionTypes).toEqual(["block", "cancel", "reset"]);
  });

  test("never interprets command-looking guest text as control-plane input", async () => {
    const store = createStore();
    const admin = new AdminController({ store, adminIds: new Set([11, 12]) });

    expect(await admin.handle(update(1, "/block 44", 44), identity(44, 44, "guest")))
      .toBe("not_handled");
    expect(store.hasUpdate(1)).toBe(false);
    expect(store.isBlocked(44)).toBe(false);
  });

  test("prevents blocking configured administrators", async () => {
    const store = createStore();
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    expect(await admin.handle(update(1, "/block 12 reason"), identity(11))).toBe("handled");
    expect(store.db.query<{ count: number }, []>("SELECT count(*) AS count FROM pending_admin_actions").get()?.count)
      .toBe(0);
    expect(store.listOutboundReplies()[0]?.text).toContain("administrator");
  });

  test("cancels a running job with fencing and allows the next sequence to run", async () => {
    const store = createStore();
    store.acceptUpdate(update(50, "first", 44), identity(44, 44, "guest"), 900);
    store.acceptUpdate(update(51, "second", 44), identity(44, 44, "guest"), 901);
    const running = store.leaseNextJob("worker-a", 950, 1_000)!;
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    await admin.handle(update(1, `/cancel ${running.id}`), identity(11));
    const token = actionToken(store);
    await admin.handle(update(2, `/confirm ${token}`), identity(11));

    expect(store.getJob(running.id)).toMatchObject({ status: "failed", error: "admin_cancelled" });
    expect(store.completeJob(running.id, "worker-a", running.leaseToken!, "late", null, null, 1_100))
      .toBe(false);
    expect(store.leaseNextJob("worker-b", 1_101, 1_000)).toBeNull();
    expect(store.leaseNextJob("worker-b", 1_951, 1_000)?.updateId).toBe(51);
  });

  test("blocks, immediately unblocks, resets numeric chat targets, and lists jobs", async () => {
    const store = createStore();
    store.acceptUpdate(update(50, "queued", 44), identity(44, 44, "guest"), 900);
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    expect(await admin.handle(update(90, "/jobs"), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toContain("dm:44");

    await admin.handle(update(1, "/block 44 spam"), identity());
    await admin.handle(update(2, `/confirm ${actionToken(store)}`), identity());
    expect(store.isBlocked(44)).toBe(true);

    await admin.handle(update(3, "/unblock 44"), identity());
    expect(store.isBlocked(44)).toBe(false);
    expect(store.listOutboundReplies().at(-1)?.text).toContain("is unblocked");
    expect(store.db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM pending_admin_actions",
    ).get()?.count).toBe(1);

    await admin.handle(update(5, "/reset 44"), identity());
    await admin.handle(update(6, `/confirm ${actionToken(store)}`), identity());
    expect(store.getConversation("dm:44")?.generation).toBe(2);

    expect(await admin.handle(update(7, "/reset other:key"), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toContain("Invalid reset target");

    expect(await admin.handle(update(8, "/jobs"), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toBe("No active or queued jobs.");
  });

  test("running reset fences completion and retains the old lease until expiry", async () => {
    const store = createStore();
    store.acceptUpdate(update(50, "running", 44), identity(44, 44, "guest"), 900);
    const running = store.leaseNextJob("worker-a", 950, 1_000)!;
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    await admin.handle(update(1, "/reset 44"), identity());
    await admin.handle(update(2, `/confirm ${actionToken(store)}`), identity());
    expect(store.getConversation("dm:44")).toMatchObject({
      generation: 2,
      leaseOwner: "worker-a",
      leaseUntil: 1_950,
    });
    expect(store.completeJob(running.id, "worker-a", running.leaseToken!, "late", null, null, 1_100))
      .toBe(false);

    store.acceptUpdate(update(51, "new generation", 44), identity(44, 44, "guest"), 1_101);
    expect(store.leaseNextJob("worker-b", 1_102, 1_000)).toBeNull();
    expect(store.leaseNextJob("worker-b", 1_951, 1_000)?.updateId).toBe(51);
  });

  test("reset reports busy without invalidating maintenance fences", async () => {
    for (const state of ["cleanup_pending:token", "attachment_ingress:token"]) {
      const store = createStore();
      store.acceptUpdate(update(50, "queued", 44), identity(44, 44, "guest"), 900);
      store.db.query("UPDATE conversations SET state = ? WHERE conversation_key = 'dm:44'")
        .run(state);
      const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

      await admin.handle(update(1, "/reset 44"), identity());
      await admin.handle(update(2, `/confirm ${actionToken(store)}`), identity());

      expect(store.getConversation("dm:44")).toMatchObject({ state, generation: 1 });
      expect(store.listOutboundReplies().at(-1)?.text).toContain("busy");
    }
  });

  test("rolls back immediate unblock and its update when the durable reply cannot persist", async () => {
    const store = createStore();
    store.blockUser(44, 11, "blocked", 900);
    store.db.exec(`
      CREATE TRIGGER fail_admin_unblock_reply
      BEFORE INSERT ON outbound_replies
      BEGIN
        SELECT RAISE(ABORT, 'outbox unavailable');
      END
    `);
    const admin = new AdminController({ store, adminIds: new Set([11, 12]), clock: () => 1_000 });

    await expect(admin.handle(update(1, "/unblock 44"), identity())).rejects.toThrow(
      "outbox unavailable",
    );
    expect(store.isBlocked(44)).toBe(true);
    expect(store.hasUpdate(1)).toBe(false);
  });

  test("runs typed emergency callbacks without Claude and persists their replies", async () => {
    const store = createStore();
    const calls: string[] = [];
    const admin = new AdminController({
      store,
      adminIds: new Set([11, 12]),
      emergency: {
        doctor: () => { calls.push("doctor"); return { ok: true, message: "healthy" }; },
        restart: () => { calls.push("restart"); return { ok: true, message: "restart requested" }; },
      },
    });

    expect(await admin.handle(update(1, "/doctor"), identity())).toBe("handled");
    expect(await admin.handle(update(1, "/doctor"), identity())).toBe("duplicate");
    expect(await admin.handle(update(2, "/restart"), identity())).toBe("handled");
    expect(await admin.handle(update(3, `/confirm ${actionToken(store)}`), identity())).toBe("handled");
    expect(calls).toEqual(["doctor", "restart"]);
    expect(store.listOutboundReplies().map(({ text }) => text)).toEqual([
      "healthy",
      expect.stringContaining("Confirm with: /confirm"),
      "Restart requested.",
    ]);
  });

  test("runs restart only after commit and at most once across retries", async () => {
    const store = createStore();
    let restarts = 0;
    const admin = new AdminController({
      store,
      adminIds: new Set([11, 12]),
      clock: () => 1_000,
      emergency: {
        restart: () => {
          restarts++;
          return { ok: true, message: "ignored callback outcome" };
        },
      },
    });
    await admin.handle(update(1, "/restart"), identity());
    const token = actionToken(store);
    store.db.exec(`
      CREATE TRIGGER fail_restart_reply
      BEFORE INSERT ON outbound_replies
      WHEN NEW.update_id = 2
      BEGIN
        SELECT RAISE(ABORT, 'restart outbox unavailable');
      END
    `);

    await expect(admin.handle(update(2, `/confirm ${token}`), identity())).rejects.toThrow(
      "restart outbox unavailable",
    );
    expect(restarts).toBe(0);
    expect(store.hasUpdate(2)).toBe(false);
    expect(store.db.query<{ consumed_at: number | null }, [string]>(
      "SELECT consumed_at FROM pending_admin_actions WHERE token = ?",
    ).get(token)?.consumed_at).toBeNull();

    store.db.exec("DROP TRIGGER fail_restart_reply");
    expect(await admin.handle(update(2, `/confirm ${token}`), identity())).toBe("handled");
    expect(restarts).toBe(1);
    expect(store.listOutboundReplies().at(-1)?.text).toBe("Restart requested.");
    expect(await admin.handle(update(2, `/confirm ${token}`), identity())).toBe("duplicate");
    expect(await admin.handle(update(3, `/confirm ${token}`), identity())).toBe("handled");
    expect(store.listOutboundReplies().at(-1)?.text).toContain("already used");
    expect(restarts).toBe(1);
  });
});

describe("Receiver admin integration", () => {
  test("keeps admin command-looking group text in the guest conversation without reply leakage", async () => {
    const store = createStore(new Set([11]));
    const config: MultiUserConfig = { adminChatIds: new Set([11]), guestAccessMode: "public" };
    const receiver = new Receiver({
      telegram: fakeTelegram(),
      store,
      config,
      baseDirectory: directories[0]!,
    });

    expect(await receiver.processUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_752_528_000,
        text: "/block 44",
        from: { id: 11 },
        chat: { id: -100, type: "supergroup", title: "Team" },
      },
    })).toBe("accepted");

    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0]).toMatchObject({ conversationKey: "group:-100", role: "admin" });
    expect(store.listOutboundReplies()).toHaveLength(0);
    expect(store.isBlocked(44)).toBe(false);
    expect(store.db.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM pending_admin_actions",
    ).get()?.count).toBe(0);
  });

  test("applies confirmed guest_access_mode immediately without restarting Receiver", async () => {
    const store = createStore(new Set([11]));
    const config: MultiUserConfig = { adminChatIds: new Set([11]), guestAccessMode: "public" };
    let downloads = 0;
    const telegram = {
      ...fakeTelegram(),
      downloadAttachment: async () => { downloads++; return { path: "/unused", created: true }; },
    };
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directories[0]! });
    const raw = {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1_752_528_000,
        text: "/access invite",
        from: { id: 11 },
        chat: { id: 11, type: "private" },
        document: { file_id: "secret", file_name: "secret.txt" },
      },
    };

    expect(await receiver.processUpdate(raw)).toBe("accepted");
    expect(downloads).toBe(0);
    expect(store.listJobs()).toHaveLength(0);
    const token = actionToken(store);
    expect(await receiver.processUpdate({
      ...raw,
      update_id: 2,
      message: { ...raw.message, message_id: 20, text: `/confirm ${token}`, document: undefined },
    })).toBe("accepted");
    expect(store.getSetting("guest_access_mode")).toBe("invite");

    expect(await receiver.processUpdate({
      ...raw,
      update_id: 3,
      message: { ...raw.message, message_id: 30, text: "hello", from: { id: 44 }, chat: { id: 44, type: "private" }, document: undefined },
    })).toBe("rejected");
  });
});
