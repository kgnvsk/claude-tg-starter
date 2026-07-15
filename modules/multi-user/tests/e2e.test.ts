import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Dispatcher } from "../src/dispatcher";
import { Receiver } from "../src/receiver";
import { Store } from "../src/store";
import { TelegramClient } from "../src/telegram";
import { ClaudeWorker } from "../src/worker";

const temporaryDirectories: string[] = [];
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-e2e-"));
  temporaryDirectories.push(directory);
  return directory;
}

function telegramUpdate(
  updateId: number,
  chatId: number,
  senderId: number,
  chatType: "private" | "group" = "private",
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_752_528_000 + updateId,
      text: `message ${updateId}`,
      from: { id: senderId, first_name: `User ${senderId}` },
      chat: { id: chatId, type: chatType },
    },
  };
}

function fakeClaude(root: string): string {
  const executable = join(root, "fake-claude.ts");
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const sessionFlag = argv.includes("--resume") ? "--resume" : "--session-id";
const sessionId = argv[argv.indexOf(sessionFlag) + 1];
const logPath = process.env.CLAUDE_CONFIG_DIR + "/calls.jsonl";
const startedAt = Date.now();
appendFileSync(logPath, JSON.stringify({ event: "start", argv, cwd: process.cwd(), sessionFlag, sessionId, startedAt, pid: process.pid }) + "\\n");
await Bun.sleep(150);
const endedAt = Date.now();
appendFileSync(logPath, JSON.stringify({ event: "end", sessionId, startedAt, endedAt, pid: process.pid }) + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }));
console.log(JSON.stringify({ type: "result", subtype: "success", result: "reply " + sessionId, session_id: sessionId }));
`);
  chmodSync(executable, 0o755);
  return executable;
}

describe("multi-user end to end", () => {
  test("survives a dispatcher restart and isolates concurrent guest conversations", async () => {
    const root = fixtureDirectory();
    const state = join(root, "state");
    const workspaces = join(state, "workspaces");
    const ownerVault = join(root, "owner-private");
    const claudeState = join(root, "fake-claude-state");
    mkdirSync(workspaces, { recursive: true });
    mkdirSync(ownerVault);
    mkdirSync(claudeState);
    const database = join(state, "multi-user.sqlite");
    const updates = [
      telegramUpdate(1, 101, 101),
      telegramUpdate(2, 202, 202),
      telegramUpdate(3, -303, 301, "group"),
      telegramUpdate(4, -303, 302, "group"),
    ];
    const sent: Array<{ chatId: number; text: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/getUpdates")) {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          return Response.json({
            ok: true,
            result: updates.filter((update) => Number(update.update_id) >= offset),
          });
        }
        if (url.pathname.endsWith("/sendMessage")) {
          const body = await request.json() as { chat_id: number; text: string };
          sent.push({ chatId: body.chat_id, text: body.text });
          return Response.json({ ok: true, result: { message_id: sent.length } });
        }
        if (url.pathname.endsWith("/sendChatAction")) {
          return Response.json({ ok: true, result: true });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const telegram = new TelegramClient("test-token", {
      apiBase: `http://127.0.0.1:${server.port}`,
    });
    const config = { adminChatIds: new Set<number>(), guestAccessMode: "public" as const };

    const ingressStore = new Store(database);
    const receiver = new Receiver({
      telegram,
      store: ingressStore,
      config,
      baseDirectory: workspaces,
      longPollSeconds: 0,
      outbound: {
        leaseOwner: "e2e-receiver",
        leaseMs: 5_000,
        sendTimeoutMs: 1_000,
        maxAttempts: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 100,
      },
    });
    expect(await receiver.pollOnce()).toBe(4);
    expect(ingressStore.listJobs()).toHaveLength(4);

    // A new database connection models a dispatcher process restart after durable ingress.
    const dispatchStore = new Store(database);
    const worker = new ClaudeWorker({
      claudeExecutable: fakeClaude(root),
      ownerVault,
      workspacesBase: workspaces,
      guestSystemPromptPath: join(import.meta.dir, "../guest-system-prompt.md"),
      timeoutMs: 5_000,
      env: {
        PATH: process.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: claudeState,
        TELEGRAM_BOT_TOKEN: "must-not-leak",
      },
    });
    const dispatcher = new Dispatcher({
      store: dispatchStore,
      worker,
      workspacesBase: workspaces,
      maxWorkers: 3,
      workerTimeoutMs: 5_000,
      leaseMs: 2_000,
      renewalIntervalMs: 500,
      pollIntervalMs: 10,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
      typing: (chatId) => telegram.sendTyping(chatId),
    });

    expect(dispatcher.poll()).toBe(3);
    await dispatcher.waitForIdle();
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(dispatchStore.listJobs().map((job) => job.status)).toEqual([
      "completed", "completed", "completed", "completed",
    ]);

    const calls = readFileSync(join(claudeState, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<Record<string, unknown>>;
    const starts = calls.filter((call) => call.event === "start");
    const ends = calls.filter((call) => call.event === "end");
    expect(starts).toHaveLength(4);
    expect(ends).toHaveLength(4);
    expect(new Set(starts.slice(0, 3).map((call) => call.pid)).size).toBe(3);
    const firstWaveEnd = Math.min(...ends.slice(0, 3).map((call) => Number(call.endedAt)));
    expect(Math.max(...starts.slice(0, 3).map((call) => Number(call.startedAt))))
      .toBeLessThan(firstWaveEnd);

    const byConversation = new Map<string, Array<Record<string, unknown>>>();
    for (const call of starts) {
      const argv = call.argv as string[];
      const prompt = argv.at(-1) ?? "";
      const conversation = /"conversationKey": "([^"]+)"/.exec(prompt)?.[1];
      expect(conversation).toBeDefined();
      const list = byConversation.get(conversation!) ?? [];
      list.push(call);
      byConversation.set(conversation!, list);
      expect(call.cwd).not.toBe(ownerVault);
      expect(argv).toContain("--safe-mode");
      expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,WebSearch,WebFetch");
      expect(argv.join(" ")).not.toContain(ownerVault);
      expect(argv.join(" ")).not.toContain("must-not-leak");
    }
    expect(byConversation.get("dm:101")).toHaveLength(1);
    expect(byConversation.get("dm:202")).toHaveLength(1);
    expect(byConversation.get("group:-303")).toHaveLength(2);
    const groupCalls = byConversation.get("group:-303")!;
    expect(groupCalls[0]!.sessionFlag).toBe("--session-id");
    expect(groupCalls[1]!.sessionFlag).toBe("--resume");
    expect(groupCalls[1]!.sessionId).toBe(groupCalls[0]!.sessionId);
    expect(new Set([
      byConversation.get("dm:101")![0]!.sessionId,
      byConversation.get("dm:202")![0]!.sessionId,
      groupCalls[0]!.sessionId,
    ]).size).toBe(3);

    expect(await receiver.flushOutbox()).toBe(4);
    expect(sent).toHaveLength(4);
    expect(sent.map(({ chatId }) => chatId).sort((a, b) => a - b))
      .toEqual([-303, -303, 101, 202]);
    expect(dispatchStore.listOutboundReplies().every((reply) => reply.status === "delivered"))
      .toBe(true);
    dispatchStore.close();
    ingressStore.close();
  });
});
