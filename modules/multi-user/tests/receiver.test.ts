import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Receiver, normalizeTelegramUpdate } from "../src/receiver";
import { Store } from "../src/store";
import { TelegramApiError, TelegramClient } from "../src/telegram";
import type { MultiUserConfig, NormalizedUpdate } from "../src/types";

const temporaryDirectories: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-receiver-"));
  temporaryDirectories.push(directory);
  return directory;
}

const config: MultiUserConfig = {
  adminChatIds: new Set([11]),
  guestAccessMode: "public",
};

function rawMessage(
  updateId: number,
  chatId: number,
  senderId: number,
  type: "private" | "group" | "supergroup" = "private",
  extra: Record<string, unknown> = {},
) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_752_528_000,
      text: `message ${updateId}`,
      from: { id: senderId, username: `user${senderId}`, first_name: "Test" },
      chat: { id: chatId, type, title: type === "private" ? undefined : "Group" },
      ...extra,
    },
  };
}

function fakeTelegram(updates: unknown[] = []) {
  const sent: Array<{ chatId: number; text: string }> = [];
  const downloads: Array<{
    conversationKey: string;
    fileName?: string;
    attachmentIdentity: string;
  }> = [];
  const removed: string[] = [];
  return {
    sent,
    downloads,
    removed,
    getUpdates: async (_offset: number, _timeout: number, _signal?: AbortSignal) => updates,
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
    },
    getFile: async (fileId: string) => ({
      file_id: fileId,
      file_path: `telegram/${fileId}.bin`,
    }),
    downloadAttachment: async (
      _base: string,
      conversationKey: string,
      _filePath: string,
      fileName?: string,
      attachmentIdentity = "missing",
    ) => {
      downloads.push({ conversationKey, fileName, attachmentIdentity });
      return {
        path: `/scoped/${encodeURIComponent(conversationKey)}/${attachmentIdentity}`,
        created: true,
      };
    },
    removeAttachment: async (
      _base: string,
      _conversationKey: string,
      path: string,
    ) => {
      removed.push(path);
    },
  };
}

describe("normalizeTelegramUpdate", () => {
  test("normalizes private text and group captions by numeric identity", () => {
    expect(normalizeTelegramUpdate(rawMessage(1, 22, 22))).toMatchObject({
      updateId: 1,
      message: {
        text: "message 1",
        sender: { id: 22 },
        chat: { id: 22, type: "private" },
      },
    });
    expect(
      normalizeTelegramUpdate(
        rawMessage(2, -100, 33, "supergroup", {
          text: undefined,
          caption: "group caption",
          photo: [{ file_id: "small" }, { file_id: "large", file_size: 99 }],
        }),
      ),
    ).toMatchObject({
      message: {
        text: "group caption",
        chat: { id: -100, type: "supergroup" },
        attachments: [{ kind: "photo", fileId: "large", fileSize: 99 }],
      },
    });
  });

  test("normalizes all supported attachment metadata", () => {
    const normalized = normalizeTelegramUpdate(
      rawMessage(3, 22, 22, "private", {
        text: undefined,
        caption: "files",
        document: {
          file_id: "doc",
          file_name: "notes.txt",
          mime_type: "text/plain",
          file_size: 10,
        },
        audio: { file_id: "audio", file_name: "song.mp3", mime_type: "audio/mpeg" },
        video: { file_id: "video", file_name: "clip.mp4", mime_type: "video/mp4" },
        voice: { file_id: "voice", mime_type: "audio/ogg" },
      }),
    );

    expect(normalized?.message.attachments).toEqual([
      { kind: "document", fileId: "doc", fileName: "notes.txt", mimeType: "text/plain", fileSize: 10 },
      { kind: "audio", fileId: "audio", fileName: "song.mp3", mimeType: "audio/mpeg" },
      { kind: "video", fileId: "video", fileName: "clip.mp4", mimeType: "video/mp4" },
      { kind: "voice", fileId: "voice", mimeType: "audio/ogg" },
    ]);
  });

  test("ignores channels, callbacks, and unsupported message bodies", () => {
    expect(normalizeTelegramUpdate({ update_id: 1, callback_query: {} })).toBeNull();
    expect(
      normalizeTelegramUpdate(rawMessage(2, -1, 2, "private", { chat: { id: -1, type: "channel" } })),
    ).toBeNull();
    expect(
      normalizeTelegramUpdate(rawMessage(3, 3, 3, "private", { text: undefined, sticker: {} })),
    ).toBeNull();
  });
});

describe("Receiver", () => {
  test("commits an accepted update before advancing the offset", async () => {
    const events: string[] = [];
    const telegram = fakeTelegram([rawMessage(7, 22, 22)]);
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      recordTerminalUpdate: () => true,
      acceptUpdate: (_update: NormalizedUpdate) => {
        events.push("persist");
        return true;
      },
      getSetting: () => "7",
      setSetting: (_key: string, value: string) => events.push(`offset:${value}`),
    };
    const receiver = new Receiver({ telegram, store, config, baseDirectory: temporaryDirectory() });

    await receiver.pollOnce();

    expect(events).toEqual(["persist", "offset:8"]);
  });

  test("deduplicates update IDs through Store without duplicate jobs", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    const telegram = fakeTelegram();
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });
    const update = rawMessage(8, 22, 22);

    await receiver.processUpdate(update);
    await receiver.processUpdate(update);

    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0].conversationKey).toBe("dm:22");
  });

  test("routes private and group updates to separate conversation keys", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    const receiver = new Receiver({ telegram: fakeTelegram(), store, config, baseDirectory: directory });

    await receiver.processUpdate(rawMessage(9, 22, 22));
    await receiver.processUpdate(rawMessage(10, -100, 22, "group"));

    expect(store.listJobs().map((job) => job.conversationKey)).toEqual(["dm:22", "group:-100"]);
  });

  test("downloads accepted attachments and persists their scoped local paths", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    const telegram = fakeTelegram();
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });

    await receiver.processUpdate(
      rawMessage(11, -100, 22, "group", {
        text: undefined,
        caption: "report",
        document: { file_id: "doc", file_name: "../../report.txt", mime_type: "text/plain" },
      }),
    );

    expect(telegram.downloads).toEqual([{
      conversationKey: "group:-100",
      fileName: "../../report.txt",
      attachmentIdentity: "11:0:document:doc",
    }]);
    expect(store.listJobs()[0].payload.message.attachments?.[0]).toMatchObject({
      fileId: "doc",
      fileName: "../../report.txt",
      localPath: "/scoped/group%3A-100/11:0:document:doc",
    });
  });

  test("does not download when guest cleanup owns the conversation", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    store.acceptUpdate(normalizeTelegramUpdate(rawMessage(1, 22, 22))!, {
      accepted: true,
      role: "guest",
      userId: 22,
      chatId: 22,
      chatType: "private",
      conversationKey: "dm:22",
    }, 1_000);
    const job = store.leaseNextJob("worker", 1_010, 100)!;
    store.completeJob(job.id, "worker", job.leaseToken!, "done", "session", "guest", 1_020);
    store.claimInactiveGuestSession(1_500, 2_000, 500);
    const telegram = fakeTelegram();
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: directory,
      clock: () => 2_100,
    });

    await expect(receiver.processUpdate(rawMessage(2, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: "report.txt" },
    }))).rejects.toThrow("conversation is unavailable for attachment ingress");
    expect(telegram.downloads).toHaveLength(0);
  });

  test("releases attachment ingress when download fails", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    const telegram = {
      ...fakeTelegram(),
      downloadAttachment: async () => { throw new Error("download failed"); },
    };
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: directory,
      clock: () => 2_000,
    });
    await receiver.processUpdate(rawMessage(1, 22, 22));

    await expect(receiver.processUpdate(rawMessage(2, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: "report.txt" },
    }))).rejects.toThrow("download failed");
    expect(store.getConversation("dm:22")).toMatchObject({
      state: "active",
    });
  });

  test("accepts attachment ingress while preserving an active worker lease", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    const telegram = fakeTelegram();
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: directory,
      clock: () => 2_000,
    });
    await receiver.processUpdate(rawMessage(1, 22, 22));
    const worker = store.leaseNextJob("worker", 2_000, 10_000)!;

    expect(await receiver.processUpdate(rawMessage(2, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: "report.txt" },
    }))).toBe("accepted");
    expect(store.listJobs("dm:22")).toHaveLength(2);
    expect(store.getConversation("dm:22")).toMatchObject({
      state: "active",
      leaseOwner: "worker",
      leaseUntil: 12_000,
    });
    expect(store.renewLease(worker.id, "worker", worker.leaseToken!, 2_100, 10_000)).toBe(true);
  });

  test("recovers stale attachment ingress before a later text-only update", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    let now = 1_000;
    const receiver = new Receiver({
      telegram: fakeTelegram(),
      store,
      config,
      baseDirectory: directory,
      clock: () => now,
    });
    await receiver.processUpdate(rawMessage(1, 22, 22));
    store.claimAttachmentIngress("dm:22", now, 120_000);
    now = 121_001;

    expect(await receiver.processUpdate(rawMessage(2, 22, 22))).toBe("accepted");
    expect(store.getConversation("dm:22")?.state).toBe("active");
  });

  test("answers blocked and invite-only users without creating jobs", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), { adminChatIds: config.adminChatIds });
    stores.push(store);
    store.blockUser(22, 11, "abuse");
    const telegram = fakeTelegram();
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });

    await receiver.processUpdate(rawMessage(12, 22, 22));
    const inviteReceiver = new Receiver({
      telegram,
      store,
      config: { ...config, guestAccessMode: "invite" },
      baseDirectory: directory,
    });
    await inviteReceiver.processUpdate(rawMessage(13, 33, 33));

    expect(telegram.sent).toHaveLength(0);
    await receiver.flushOutbox();
    await inviteReceiver.flushOutbox();

    expect(store.listJobs()).toHaveLength(0);
    expect(telegram.sent.map(({ chatId }) => chatId)).toEqual([22, 33]);
  });

  test("redelivery creates one durable rejection reply and sends it once", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    store.blockUser(22, 11, "abuse");
    const telegram = fakeTelegram();
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });

    await receiver.processUpdate(rawMessage(14, 22, 22));
    await receiver.processUpdate(rawMessage(14, 22, 22));

    expect(store.listOutboundReplies()).toHaveLength(1);
    expect(telegram.sent).toHaveLength(0);
    await receiver.flushOutbox();

    expect(telegram.sent).toHaveLength(1);
    expect(store.listOutboundReplies()[0].status).toBe("delivered");
    expect(store.getUpdateState(14)).toBe("rejected");
  });

  test("retries an explicit send failure and marks the reply delivered", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    store.blockUser(22, 11, "abuse");
    let replies = 0;
    const telegram = {
      ...fakeTelegram(),
      sendMessage: async () => {
        replies++;
        if (replies === 1) throw new Error("transport failed");
      },
    };
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: directory,
      outbound: {
        leaseOwner: "receiver-a",
        leaseMs: 100,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 10,
      },
    });
    const update = rawMessage(15, 22, 22);
    const firstAttemptAt = Date.now() + 100;

    await receiver.processUpdate(update);
    await receiver.flushOutbox(firstAttemptAt);
    expect(store.listOutboundReplies()[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "transport failed",
      nextAttemptAt: firstAttemptAt + 10,
    });
    await receiver.flushOutbox(firstAttemptAt + 10);

    expect(replies).toBe(2);
    expect(store.listOutboundReplies()[0]).toMatchObject({
      status: "delivered",
      attempts: 2,
    });
  });

  test("a new receiver resumes pending replies from the same database", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const firstStore = new Store(databasePath, { adminChatIds: config.adminChatIds });
    stores.push(firstStore);
    firstStore.blockUser(22, 11, "abuse");
    const firstReceiver = new Receiver({
      telegram: fakeTelegram(),
      store: firstStore,
      config,
      baseDirectory: directory,
    });

    await firstReceiver.processUpdate(rawMessage(21, 22, 22));
    expect(firstStore.listOutboundReplies()[0].status).toBe("pending");
    stores.splice(stores.indexOf(firstStore), 1);
    firstStore.close();

    const secondStore = new Store(databasePath, { adminChatIds: config.adminChatIds });
    stores.push(secondStore);
    const telegram = fakeTelegram();
    const secondReceiver = new Receiver({
      telegram,
      store: secondStore,
      config,
      baseDirectory: directory,
      outbound: {
        leaseOwner: "receiver-after-restart",
        leaseMs: 100,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });

    await secondReceiver.flushOutbox(Date.now() + 100);

    expect(telegram.sent).toHaveLength(1);
    expect(secondStore.listOutboundReplies()[0].status).toBe("delivered");
  });

  test("honors retry_after for 429 and stops retrying permanent 4xx replies", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    store.recordRejectedUpdateWithReply(22, { update_id: 22 }, 22, "rate", 1_000);
    store.recordRejectedUpdateWithReply(23, { update_id: 23 }, 23, "bad", 1_000);
    store.recordRejectedUpdateWithReply(27, { update_id: 27 }, 27, "server", 1_000);
    store.recordRejectedUpdateWithReply(28, { update_id: 28 }, 28, "network", 1_000);
    const telegram = {
      ...fakeTelegram(),
      sendMessage: async (chatId: number) => {
        if (chatId === 22) {
          throw new TelegramApiError(
            "rate limited",
            429,
            429,
            { retry_after: 17 },
          );
        }
        if (chatId === 23) throw new TelegramApiError("bad request", 400, 400);
        if (chatId === 27) throw new TelegramApiError("server error", 500, 500);
        throw new TypeError("network failed");
      },
    };
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });

    await receiver.flushOutbox(1_000);

    expect(store.listOutboundReplies()[0]).toMatchObject({
      status: "pending",
      nextAttemptAt: 18_000,
    });
    expect(store.listOutboundReplies()[1]).toMatchObject({
      status: "failed",
      lastError: "bad request",
    });
    expect(store.listOutboundReplies()[2]).toMatchObject({
      status: "pending",
      lastError: "server error",
    });
    expect(store.listOutboundReplies()[3]).toMatchObject({
      status: "pending",
      lastError: "network failed",
    });
  });

  test("resumes a multi-chunk reply at the first unacknowledged chunk after restart", async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "state.sqlite");
    const firstStore = new Store(databasePath, { adminChatIds: config.adminChatIds });
    stores.push(firstStore);
    const text = `${"a".repeat(4096)}${"b".repeat(4096)}c`;
    firstStore.recordRejectedUpdateWithReply(24, { update_id: 24 }, 22, text, 1_000);
    const firstCalls: string[] = [];
    const firstTelegram = {
      ...fakeTelegram(),
      sendMessage: async (_chatId: number, chunk: string) => {
        firstCalls.push(chunk);
        if (firstCalls.length === 2) throw new Error("chunk two failed");
      },
    };
    const firstReceiver = new Receiver({
      telegram: firstTelegram,
      store: firstStore,
      config,
      baseDirectory: directory,
      outbound: {
        leaseOwner: "receiver-before-restart",
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });

    await firstReceiver.flushOutbox(1_000);
    expect(firstCalls.map((chunk) => chunk[0])).toEqual(["a", "b"]);
    expect(firstStore.listOutboundReplies()[0].nextChunkIndex).toBe(1);
    stores.splice(stores.indexOf(firstStore), 1);
    firstStore.close();

    const secondStore = new Store(databasePath, { adminChatIds: config.adminChatIds });
    stores.push(secondStore);
    const resumedCalls: string[] = [];
    const secondReceiver = new Receiver({
      telegram: {
        ...fakeTelegram(),
        sendMessage: async (_chatId: number, chunk: string) => {
          resumedCalls.push(chunk);
        },
      },
      store: secondStore,
      config,
      baseDirectory: directory,
    });

    await secondReceiver.flushOutbox(1_010);

    expect(resumedCalls.map((chunk) => chunk[0])).toEqual(["b", "c"]);
    expect(secondStore.listOutboundReplies()[0]).toMatchObject({
      status: "delivered",
      nextChunkIndex: 3,
    });
  });

  test("renews between chunks so cumulative delivery cannot overlap a competitor", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "state.sqlite");
    const firstStore = new Store(path, { adminChatIds: config.adminChatIds });
    const secondStore = new Store(path, { adminChatIds: config.adminChatIds });
    stores.push(firstStore, secondStore);
    firstStore.recordRejectedUpdateWithReply(
      29,
      { update_id: 29 },
      22,
      `${"a".repeat(4096)}${"b".repeat(4096)}c`,
      1_000,
    );
    let now = 1_000;
    const accepted: string[] = [];
    const competingClaims: Array<unknown> = [];
    const receiver = new Receiver({
      telegram: {
        ...fakeTelegram(),
        sendMessage: async (_chatId: number, chunk: string) => {
          now += 60;
          accepted.push(chunk[0]);
          competingClaims.push(
            secondStore.claimOutboundReply("receiver-b", now, 100, 5),
          );
        },
      },
      store: firstStore,
      config,
      baseDirectory: directory,
      clock: () => now,
      outbound: {
        leaseOwner: "receiver-a",
        leaseMs: 100,
        sendTimeoutMs: 50,
        maxAttempts: 5,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });

    await receiver.flushOutbox();

    expect(now).toBe(1_180);
    expect(accepted).toEqual(["a", "b", "c"]);
    expect(competingClaims).toEqual([null, null, null]);
    expect(firstStore.listOutboundReplies()[0].status).toBe("delivered");
  });

  test("stops before the next chunk when lease renewal loses its fence", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    store.recordRejectedUpdateWithReply(
      31,
      { update_id: 31 },
      22,
      `${"a".repeat(4096)}b`,
      1_000,
    );
    const sent: string[] = [];
    store.renewOutboundReplyLease = () => false;
    const receiver = new Receiver({
      telegram: {
        ...fakeTelegram(),
        sendMessage: async (_chatId: number, chunk: string) => {
          sent.push(chunk[0]);
        },
      },
      store,
      config,
      baseDirectory: directory,
    });

    await receiver.flushOutbox(Date.now() + 100);

    expect(sent).toEqual(["a"]);
    expect(store.listOutboundReplies()[0].nextChunkIndex).toBe(1);
  });

  test("send deadline expires before the lease and leaves no overlapping claimant", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "state.sqlite");
    const firstStore = new Store(path, { adminChatIds: config.adminChatIds });
    const secondStore = new Store(path, { adminChatIds: config.adminChatIds });
    stores.push(firstStore, secondStore);
    firstStore.recordRejectedUpdateWithReply(25, { update_id: 25 }, 22, "timeout", 1_000);
    const telegram = new TelegramClient("secret", {
      deadlines: { sendMessageMs: 1_000, getFileMs: 1_000, downloadMs: 1_000 },
      fetch: async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const receiver = new Receiver({
      telegram,
      store: firstStore,
      config,
      baseDirectory: directory,
      outbound: {
        leaseOwner: "receiver-a",
        leaseMs: 100,
        sendTimeoutMs: 20,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });

    const flushing = receiver.flushOutbox(1_000);
    await Bun.sleep(5);
    expect(secondStore.claimOutboundReply("receiver-b", 1_050, 100, 3)).toBeNull();
    await flushing;

    expect(firstStore.listOutboundReplies()[0]).toMatchObject({
      status: "pending",
      lastError: expect.stringContaining("deadline"),
    });
  });

  test("shutdown aborts an active outbox send and releases it for retry", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    store.recordRejectedUpdateWithReply(26, { update_id: 26 }, 22, "shutdown", 1_000);
    const telegram = new TelegramClient("secret", {
      fetch: async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });
    const controller = new AbortController();

    const flushing = receiver.flushOutbox(1_000, 100, controller.signal);
    await Bun.sleep(5);
    controller.abort(new DOMException("shutdown", "AbortError"));
    await flushing;

    expect(store.listOutboundReplies()[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      nextAttemptAt: 1_000,
    });
  });

  test("long emoji attachment names do not poison persistence or the offset", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    const incoming = rawMessage(30, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: `${"😀".repeat(200)}.txt` },
    });
    const telegram = new TelegramClient("secret", {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/getUpdates")) {
          return new Response(JSON.stringify({ ok: true, result: [incoming] }));
        }
        if (path.endsWith("/getFile")) {
          return new Response(JSON.stringify({
            ok: true,
            result: {
              file_id: JSON.parse(String(init?.body)).file_id,
              file_path: "docs/file.bin",
            },
          }));
        }
        return new Response("bytes");
      },
    });
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });

    await receiver.pollOnce();

    expect(store.getSetting("telegram_offset")).toBe("31");
    const path = store.listJobs()[0].payload.message.attachments?.[0].localPath!;
    expect(new TextEncoder().encode(path.split("/").at(-1)!).byteLength)
      .toBeLessThanOrEqual(240);
  });

  test("records ignored updates before offset advancement", async () => {
    const events: string[] = [];
    const telegram = fakeTelegram([{ update_id: 16, callback_query: {} }]);
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      acceptUpdate: () => true,
      recordTerminalUpdate: () => {
        events.push("persist:ignored");
        return true;
      },
      getSetting: () => "16",
      setSetting: (_key: string, value: string) => events.push(`offset:${value}`),
    };
    const receiver = new Receiver({ telegram, store, config, baseDirectory: temporaryDirectory() });

    await receiver.pollOnce();

    expect(events).toEqual(["persist:ignored", "offset:17"]);
  });

  test("skips attachment side effects for an already persisted update", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    const telegram = fakeTelegram();
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });
    const incoming = rawMessage(17, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: "report.txt" },
    });

    await receiver.processUpdate(incoming);
    await receiver.processUpdate(incoming);

    expect(telegram.downloads).toHaveLength(1);
    expect(store.listJobs()).toHaveLength(1);
  });

  test("reuses a completed attachment after a crash before accept", async () => {
    const directory = temporaryDirectory();
    const store = new Store(join(directory, "state.sqlite"), {
      adminChatIds: config.adminChatIds,
    });
    stores.push(store);
    let attachmentFetches = 0;
    const telegram = new TelegramClient("secret", {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/getFile")) {
          const fileId = JSON.parse(String(init?.body)).file_id;
          return new Response(JSON.stringify({
            ok: true,
            result: { file_id: fileId, file_path: `docs/${fileId}.bin` },
          }));
        }
        attachmentFetches++;
        return new Response("attachment bytes");
      },
    });
    const receiver = new Receiver({ telegram, store, config, baseDirectory: directory });
    const incoming = rawMessage(19, 22, 22, "private", {
      text: undefined,
      document: { file_id: "doc", file_name: "report.txt" },
    });
    store.db.run(`
      CREATE TRIGGER crash_enqueue BEFORE INSERT ON jobs
      BEGIN
        SELECT RAISE(ABORT, 'crash before accept');
      END
    `);

    await expect(receiver.processUpdate(incoming)).rejects.toThrow("crash before accept");
    store.db.run("DROP TRIGGER crash_enqueue");
    await receiver.processUpdate(incoming);

    expect(attachmentFetches).toBe(1);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0].payload.message.attachments?.[0].localPath).toContain(
      "/workspaces/dm%3A22/uploads/19-",
    );
  });

  test("cleans only newly-created artifacts when an attachment batch fails", async () => {
    const downloads: string[] = [];
    const removed: string[] = [];
    const telegram = {
      ...fakeTelegram(),
      downloadAttachment: async (
        _base: string,
        _conversation: string,
        _remotePath: string,
        _fileName: string | undefined,
        identity: string,
      ) => {
        downloads.push(identity);
        if (identity.includes(":2:")) throw new Error("third attachment failed");
        return { path: `/uploads/${identity}`, created: identity.includes(":1:") };
      },
      removeAttachment: async (_base: string, _conversation: string, path: string) => {
        removed.push(path);
      },
    };
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      acceptUpdate: () => true,
      claimAttachmentIngress: () => null,
      releaseAttachmentIngress: () => true,
      recordTerminalUpdate: () => true,
      claimOutboundReply: () => null,
      markOutboundReplyDelivered: () => true,
      retryOutboundReply: () => true,
      getSetting: () => null,
      setSetting: () => {},
    };
    const receiver = new Receiver({ telegram, store, config, baseDirectory: temporaryDirectory() });

    await expect(
      receiver.processUpdate(
        rawMessage(18, 22, 22, "private", {
          text: undefined,
          document: { file_id: "doc", file_name: "a.txt" },
          audio: { file_id: "audio", file_name: "b.mp3" },
          video: { file_id: "video", file_name: "c.mp4" },
        }),
      ),
    ).rejects.toThrow("third attachment failed");

    expect(downloads).toEqual([
      "18:0:document:doc",
      "18:1:audio:audio",
      "18:2:video:video",
    ]);
    expect(removed).toEqual(["/uploads/18:1:audio:audio"]);
  });

  test("advances ignored updates and retries poll failures with bounded abortable backoff", async () => {
    const events: string[] = [];
    let polls = 0;
    const telegram = {
      ...fakeTelegram(),
      getUpdates: async () => {
        polls++;
        if (polls === 1) throw Object.assign(new Error("conflict"), { errorCode: 409, status: 409 });
        return [{ update_id: 20, callback_query: {} }];
      },
    };
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      acceptUpdate: () => true,
      recordTerminalUpdate: () => true,
      claimOutboundReply: () => null,
      markOutboundReplyDelivered: () => true,
      retryOutboundReply: () => true,
      getSetting: () => "20",
      setSetting: (_key: string, value: string) => events.push(`offset:${value}`),
    };
    const controller = new AbortController();
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: temporaryDirectory(),
      backoff: { initialMs: 10, maxMs: 10 },
      sleep: async (ms) => {
        events.push(`sleep:${ms}`);
      },
    });

    await receiver.run(controller.signal, 2);

    expect(events).toEqual(["sleep:10", "offset:21"]);
  });

  test("aborts the active long poll without entering backoff", async () => {
    let activeSignal: AbortSignal | undefined;
    let started!: () => void;
    const pollStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const telegram = {
      ...fakeTelegram(),
      getUpdates: async (_offset: number, _timeout: number, signal?: AbortSignal) => {
        activeSignal = signal;
        started();
        if (!signal) throw new Error("receiver getUpdates is missing signal");
        return await new Promise<unknown[]>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      acceptUpdate: () => true,
      recordTerminalUpdate: () => true,
      claimOutboundReply: () => null,
      markOutboundReplyDelivered: () => true,
      retryOutboundReply: () => true,
      getSetting: () => null,
      setSetting: () => {},
    };
    let sleeps = 0;
    const controller = new AbortController();
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: temporaryDirectory(),
      sleep: async () => {
        sleeps++;
      },
    });

    const running = receiver.run(controller.signal, 1);
    await pollStarted;
    controller.abort();
    await running;

    expect(activeSignal).toBe(controller.signal);
    expect(sleeps).toBe(0);
  });

  test("retries after the client deadline aborts a stalled long poll", async () => {
    const telegram = new TelegramClient("secret", {
      getUpdatesDeadlineGraceMs: 10,
      fetch: async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const store = {
      lookupIdentity: () => null,
      hasUpdate: () => false,
      acceptUpdate: () => true,
      recordTerminalUpdate: () => true,
      claimOutboundReply: () => null,
      markOutboundReplyDelivered: () => true,
      retryOutboundReply: () => true,
      getSetting: () => null,
      setSetting: () => {},
    };
    const retries: number[] = [];
    const receiver = new Receiver({
      telegram,
      store,
      config,
      baseDirectory: temporaryDirectory(),
      longPollSeconds: 0,
      backoff: { initialMs: 7, maxMs: 7 },
      sleep: async (milliseconds) => {
        retries.push(milliseconds);
      },
    });

    await receiver.run(new AbortController().signal, 1);

    expect(retries).toEqual([7]);
  });
});
