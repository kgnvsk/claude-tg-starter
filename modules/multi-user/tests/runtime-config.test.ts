import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEmergencyControls, runGuestRetentionCleanup } from "../src/runtime";
import { Store } from "../src/store";
import {
  loadDispatcherRuntimeConfig,
  loadReceiverRuntimeConfig,
} from "../src/runtime-config";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "123:test",
  ADMIN_CHAT_IDS: "101,202",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("multi-user runtime configuration", () => {
  test("loads secure deployment defaults", () => {
    const receiver = loadReceiverRuntimeConfig(baseEnv);
    const dispatcher = loadDispatcherRuntimeConfig(baseEnv);

    expect(receiver).toMatchObject({
      stateDir: "/home/claude/multi-user/state",
      workspacesDir: "/home/claude/multi-user/state/workspaces",
      telegramToken: "123:test",
      guestAccessMode: "public",
    });
    expect([...receiver.adminChatIds]).toEqual([101, 202]);
    expect(dispatcher).toMatchObject({
      stateDir: "/home/claude/multi-user/state",
      workspacesDir: "/home/claude/multi-user/state/workspaces",
      ownerCwd: "/home/claude",
      guestSystemPromptPath: "/home/claude/multi-user/guest-system-prompt.md",
      claudeExecutable: "/home/claude/.local/bin/claude",
      maxWorkers: 4,
      workerTimeoutMs: 300_000,
      maxAttempts: 3,
      guestRetentionDays: 7,
    });
  });

  test("derives workspaces from an overridden state directory", () => {
    expect(loadReceiverRuntimeConfig({
      ...baseEnv,
      STATE_DIR: "/tmp/router-state",
    }).workspacesDir).toBe("/tmp/router-state/workspaces");
  });

  test("rejects missing identities, usernames, invalid integers, and relative paths", () => {
    expect(() => loadReceiverRuntimeConfig({ TELEGRAM_BOT_TOKEN: "token" }))
      .toThrow("ADMIN_CHAT_IDS is required");
    expect(() => loadReceiverRuntimeConfig({
      TELEGRAM_BOT_TOKEN: "token",
      ADMIN_CHAT_IDS: "@owner",
    })).toThrow("numeric Telegram IDs");
    expect(() => loadDispatcherRuntimeConfig({
      ...baseEnv,
      MAX_WORKERS: "4x",
    })).toThrow("MAX_WORKERS must be a positive integer");
    expect(() => loadDispatcherRuntimeConfig({
      ...baseEnv,
      STATE_DIR: "relative/state",
    })).toThrow("STATE_DIR must be an absolute path");
    expect(() => loadDispatcherRuntimeConfig({
      ...baseEnv,
      RETENTION_CLEANUP_INTERVAL_MS: "999",
    })).toThrow("RETENTION_CLEANUP_INTERVAL_MS must be between");
  });

  test("entrypoints are import-safe", async () => {
    const receiver = await import("../src/receiver-main");
    const dispatcher = await import("../src/dispatcher-main");
    expect(typeof receiver.main).toBe("function");
    expect(typeof dispatcher.main).toBe("function");
  });

  test("emergency controls report missing executables without throwing", () => {
    const emergency = createEmergencyControls("/missing/cash-doctor", "/missing/systemctl");
    expect(emergency.doctor?.()).toMatchObject({ ok: false });
    expect(emergency.restart?.()).toMatchObject({ ok: false });
  });

  test("retention cleanup removes only expired encoded guest workspaces", () => {
    const root = mkdtempSync(join(tmpdir(), "multi-user-retention-"));
    temporaryDirectories.push(root);
    const workspaces = join(root, "workspaces");
    mkdirSync(join(workspaces, "dm%3A22"), { recursive: true });
    writeFileSync(join(workspaces, "dm%3A22", "guest.txt"), "expired");
    const unrelated = join(root, "unrelated");
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, "keep.txt"), "keep");
    const store = new Store(join(root, "state.sqlite"));
    store.db.exec(`
      INSERT INTO chats (
        telegram_chat_id, type, status, created_at, updated_at
      ) VALUES (22, 'private', 'active', 1000, 1000);
      INSERT INTO conversations (
        conversation_key, telegram_chat_id, session_id, session_role, generation,
        state, next_sequence, last_activity_at, created_at, updated_at
      ) VALUES ('dm:22', 22, 'session-22', 'guest', 1, 'active', 1, 1000, 1000, 1000)
    `);

    expect(runGuestRetentionCleanup(store, workspaces, 7, 700_000_000)).toEqual([
      { conversationKey: "dm:22", sessionId: "session-22" },
    ]);
    expect(Bun.file(join(workspaces, "dm%3A22", "guest.txt")).size).toBe(0);
    expect(Bun.file(join(unrelated, "keep.txt")).size).toBe(4);
    store.close();
  });

  test("retention cleanup completes before retrying quarantine deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "multi-user-retention-retry-"));
    temporaryDirectories.push(root);
    const workspaces = join(root, "workspaces");
    mkdirSync(join(workspaces, "dm%3A22"), { recursive: true });
    const store = new Store(join(root, "state.sqlite"));
    store.db.exec(`
      INSERT INTO chats (telegram_chat_id, type, status, created_at, updated_at)
      VALUES (22, 'private', 'active', 1000, 1000);
      INSERT INTO conversations (
        conversation_key, telegram_chat_id, session_id, session_role, generation,
        state, next_sequence, last_activity_at, created_at, updated_at
      ) VALUES ('dm:22', 22, 'session-22', 'guest', 1, 'active', 1, 1000, 1000, 1000)
    `);

    expect(runGuestRetentionCleanup(
      store,
      workspaces,
      7,
      700_000_000,
      { removeQuarantine: () => { throw new Error("disk failure"); } },
    )).toHaveLength(1);
    expect(store.getConversation("dm:22")).toMatchObject({
      sessionId: null,
      sessionRole: null,
      state: "active",
    });
    const trash = join(workspaces, ".retention-trash");
    expect(existsSync(trash)).toBe(true);
    expect(runGuestRetentionCleanup(store, workspaces, 7, 700_000_001)).toHaveLength(0);
    expect(existsSync(trash)).toBe(true);
    store.close();
  });

  test("retention resumes the same pending token after rename-before-complete crash", () => {
    const root = mkdtempSync(join(tmpdir(), "multi-user-retention-resume-"));
    temporaryDirectories.push(root);
    const workspaces = join(root, "workspaces");
    const source = join(workspaces, "dm%3A22");
    mkdirSync(source, { recursive: true });
    const store = new Store(join(root, "state.sqlite"));
    store.db.exec(`
      INSERT INTO chats (telegram_chat_id, type, status, created_at, updated_at)
      VALUES (22, 'private', 'active', 1000, 1000);
      INSERT INTO conversations (
        conversation_key, telegram_chat_id, session_id, session_role, generation,
        state, next_sequence, last_activity_at, created_at, updated_at
      ) VALUES ('dm:22', 22, 'session-22', 'guest', 1, 'active', 1, 1000, 1000, 1000)
    `);
    const claim = store.claimInactiveGuestSession(2_000, 3_000, 300_000)!;
    const trash = join(workspaces, ".retention-trash");
    mkdirSync(trash);
    renameSync(source, join(trash, claim.token));
    expect(store.isGuestSessionCleanupPending(claim.token)).toBe(true);

    expect(runGuestRetentionCleanup(store, workspaces, 7, 700_000_000)).toEqual([
      { conversationKey: "dm:22", sessionId: "session-22" },
    ]);
    expect(store.getConversation("dm:22")).toMatchObject({ state: "active", sessionId: null });
    expect(store.isGuestSessionCleanupPending(claim.token)).toBe(false);
    expect(existsSync(join(trash, claim.token))).toBe(false);
    store.close();
  });

  test("rename failure keeps the same pending claim for immediate retry", () => {
    const root = mkdtempSync(join(tmpdir(), "multi-user-retention-rename-"));
    temporaryDirectories.push(root);
    const workspaces = join(root, "workspaces");
    mkdirSync(join(workspaces, "dm%3A22"), { recursive: true });
    const store = new Store(join(root, "state.sqlite"));
    store.db.exec(`
      INSERT INTO chats (telegram_chat_id, type, status, created_at, updated_at)
      VALUES (22, 'private', 'active', 1000, 1000);
      INSERT INTO conversations (
        conversation_key, telegram_chat_id, session_id, session_role, generation,
        state, next_sequence, last_activity_at, created_at, updated_at
      ) VALUES ('dm:22', 22, 'session-22', 'guest', 1, 'active', 1, 1000, 1000, 1000)
    `);
    expect(runGuestRetentionCleanup(store, workspaces, 7, 700_000_000, {
      renameWorkspace: () => { throw new Error("rename failed"); },
    })).toEqual([]);
    const pending = store.listPendingGuestSessionCleanups();
    expect(pending).toHaveLength(1);
    expect(runGuestRetentionCleanup(store, workspaces, 7, 700_000_001)).toHaveLength(1);
    expect(store.listPendingGuestSessionCleanups()).toHaveLength(0);
    store.close();
  });
});
