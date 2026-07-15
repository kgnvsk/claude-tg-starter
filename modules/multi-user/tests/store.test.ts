import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../src/store";
import type {
  AcceptedIdentity,
  NormalizedUpdate,
  Role,
} from "../src/types";

const temporaryDirectories: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) {
    store.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-store-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.sqlite");
}

function trackStore(store: Store): Store {
  stores.push(store);
  return store;
}

function closeTrackedStore(store: Store): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

function initializeSchema(path: string): void {
  closeTrackedStore(trackStore(new Store(path)));
}

function createStore(adminChatIds: ReadonlySet<number> = new Set()): Store {
  return trackStore(new Store(createDatabasePath(), { adminChatIds }));
}

function withDatabase(path: string, action: (db: Database) => void): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    action(db);
  } finally {
    db.close();
  }
}

async function waitForFiles(paths: readonly string[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!paths.every(existsSync)) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for lease workers");
    await Bun.sleep(5);
  }
}

function update(
  updateId: number,
  chatId: number,
  senderId: number,
  chatType: "private" | "group" | "supergroup" = "private",
): NormalizedUpdate {
  return {
    updateId,
    message: {
      messageId: updateId * 10,
      date: 1_752_528_000,
      text: `message ${updateId}`,
      sender: { id: senderId, username: `user${senderId}` },
      chat: { id: chatId, type: chatType, title: "Test chat" },
    },
  };
}

function identity(
  chatId: number,
  userId: number,
  role: Role = "guest",
  chatType: "private" | "group" | "supergroup" = "private",
): AcceptedIdentity {
  return {
    accepted: true,
    role,
    userId,
    chatId,
    chatType,
    conversationKey:
      chatType === "private" ? `dm:${chatId}` : `group:${chatId}`,
  };
}

describe("Store schema", () => {
  test("creates all approved tables and enables WAL mode", () => {
    const store = createStore();
    const tables = store.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map(({ name }) => name);

    expect(store.db.query("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(store.db.query("PRAGMA user_version").get()).toEqual({
      user_version: 1,
    });
    expect(tables).toEqual(
      expect.arrayContaining([
        "blocks",
        "chats",
        "conversations",
        "jobs",
        "memberships",
        "pending_admin_actions",
        "settings",
        "updates",
        "users",
      ]),
    );
  });

  test("rejects an unversioned partial schema without modifying it", () => {
    const path = createDatabasePath();
    withDatabase(path, (db) => db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)"));

    expect(() => trackStore(new Store(path))).toThrow(
      "unversioned database contains existing schema",
    );
    withDatabase(path, (db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
      expect(
        db
          .query<{ name: string }, []>(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `)
          .all(),
      ).toEqual([{ name: "users" }]);
    });
  });

  test("rejects an invalid version-one schema without repairing it", () => {
    const path = createDatabasePath();
    withDatabase(path, (db) => {
      db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY)");
      db.exec("PRAGMA user_version = 1");
    });

    expect(() => trackStore(new Store(path))).toThrow("schema validation failed");
    withDatabase(path, (db) => {
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(
        db
          .query<{ name: string }, []>(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `)
          .all(),
      ).toEqual([{ name: "users" }]);
    });
  });

  test("rejects schema versions newer than supported", () => {
    const path = createDatabasePath();
    withDatabase(path, (db) => db.exec("PRAGMA user_version = 2"));

    expect(() => trackStore(new Store(path))).toThrow(
      "database schema version 2 is newer than supported version 1",
    );
  });

  test("rejects a version-one table with matching columns but missing primary key", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("ALTER TABLE settings RENAME TO old_settings");
      db.exec(`
        CREATE TABLE settings (
          key TEXT,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      db.exec("DROP TABLE old_settings");
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for table settings",
    );
    withDatabase(path, (db) => {
      expect(
        db
          .query<{ name: string; pk: number }, []>("PRAGMA table_info(settings)")
          .all()
          .map(({ name, pk }) => ({ name, pk })),
      ).toEqual([
        { name: "key", pk: 0 },
        { name: "value", pk: 0 },
        { name: "updated_at", pk: 0 },
      ]);
    });
  });

  test("rejects a named index with the wrong definition", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("DROP INDEX jobs_conversation_idx");
      db.exec("CREATE INDEX jobs_conversation_idx ON jobs (status, sequence)");
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for indexes on table jobs",
    );
    withDatabase(path, (db) => {
      expect(
        db
          .query<{ name: string }, []>("PRAGMA index_info(jobs_conversation_idx)")
          .all()
          .map(({ name }) => name),
      ).toEqual(["status", "sequence"]);
    });
  });

  test("rejects a table with missing foreign keys", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("ALTER TABLE memberships RENAME TO old_memberships");
      db.exec(`
        CREATE TABLE memberships (
          telegram_user_id INTEGER NOT NULL,
          telegram_chat_id INTEGER NOT NULL,
          effective_role TEXT NOT NULL CHECK (effective_role IN ('admin', 'guest')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (telegram_user_id, telegram_chat_id)
        )
      `);
      db.exec("DROP TABLE old_memberships");
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for foreign keys on table memberships",
    );
    withDatabase(path, (db) => {
      expect(db.query("PRAGMA foreign_key_list(memberships)").all()).toEqual([]);
    });
  });

  test("rejects users without required role and status checks", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE users");
      db.exec(`
        CREATE TABLE users (
          telegram_user_id INTEGER PRIMARY KEY,
          role TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
          username TEXT,
          first_name TEXT,
          last_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for CHECK constraints on table users",
    );
    withDatabase(path, (db) => {
      const sql = db
        .query<{ sql: string }, []>(`
          SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'users'
        `)
        .get()!.sql;
      expect(sql).not.toContain("role IN");
    });
  });

  test("rejects conversations without required generation checks", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE conversations");
      db.exec(`
        CREATE TABLE conversations (
          conversation_key TEXT PRIMARY KEY,
          telegram_chat_id INTEGER NOT NULL REFERENCES chats(telegram_chat_id),
          session_id TEXT,
          generation INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'active',
          next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
          lease_owner TEXT,
          lease_until INTEGER,
          last_activity_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
        )
      `);
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for CHECK constraints on table conversations",
    );
    withDatabase(path, (db) => {
      const sql = db
        .query<{ sql: string }, []>(`
          SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'conversations'
        `)
        .get()!.sql;
      expect(sql).not.toContain("generation > 0");
    });
  });

  test("rejects jobs without required attempt and lease checks", () => {
    const path = createDatabasePath();
    initializeSchema(path);
    withDatabase(path, (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("DROP TABLE jobs");
      db.exec(`
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          update_id INTEGER NOT NULL UNIQUE REFERENCES updates(update_id),
          conversation_key TEXT NOT NULL REFERENCES conversations(conversation_key),
          generation INTEGER NOT NULL CHECK (generation > 0),
          sequence INTEGER NOT NULL CHECK (sequence > 0),
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
          role TEXT NOT NULL CHECK (role IN ('admin', 'guest')),
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,
          lease_token TEXT,
          lease_until INTEGER,
          error TEXT,
          result TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (conversation_key, sequence)
        )
      `);
      db.exec("CREATE INDEX jobs_eligible_idx ON jobs (status, created_at, id)");
      db.exec("CREATE INDEX jobs_conversation_idx ON jobs (conversation_key, sequence)");
    });

    expect(() => trackStore(new Store(path))).toThrow(
      "schema validation failed for CHECK constraints on table jobs",
    );
    withDatabase(path, (db) => {
      const sql = db
        .query<{ sql: string }, []>(`
          SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'jobs'
        `)
        .get()!.sql;
      expect(sql).not.toContain("attempts >= 0");
      expect(sql).not.toContain("lease_token IS NULL");
    });
  });
});

describe("Store.acceptUpdate", () => {
  test("rejects non-safe timestamp inputs before persistence", () => {
    const store = createStore();
    for (const now of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() =>
        store.acceptUpdate(update(1, 22, 22), identity(22, 22), now),
      ).toThrow("timestamp must be a non-negative safe integer");
    }
    expect(store.listJobs()).toHaveLength(0);
  });

  test("deduplicates update IDs and enqueues exactly one job", () => {
    const store = createStore();
    const incoming = update(1, 22, 22);
    const resolved = identity(22, 22);

    expect(store.acceptUpdate(incoming, resolved, 1_000)).toBe(true);
    expect(store.acceptUpdate(incoming, resolved, 2_000)).toBe(false);
    expect(store.listJobs()).toHaveLength(1);
    expect(store.listJobs()[0]).toMatchObject({
      updateId: 1,
      conversationKey: "dm:22",
      sequence: 1,
      status: "queued",
      role: "guest",
    });
  });

  test("assigns monotonically increasing sequence numbers per conversation", () => {
    const store = createStore();

    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    store.acceptUpdate(update(2, 22, 22), identity(22, 22), 1_001);
    store.acceptUpdate(update(3, 33, 33), identity(33, 33), 1_002);

    expect(store.listJobs().map((job) => [job.conversationKey, job.sequence])).toEqual([
      ["dm:22", 1],
      ["dm:22", 2],
      ["dm:33", 1],
    ]);
  });

  test("rolls back update persistence when enqueue fails", () => {
    const store = createStore();
    store.db.run(`
      CREATE TRIGGER reject_jobs BEFORE INSERT ON jobs
      BEGIN
        SELECT RAISE(ABORT, 'enqueue failed');
      END
    `);

    expect(() =>
      store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000),
    ).toThrow("enqueue failed");
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM updates").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects identity fields that do not match the normalized update", () => {
    const store = createStore();
    const incoming = update(1, -100, 22, "supergroup");
    const valid = identity(-100, 22, "guest", "supergroup");
    const mismatches: AcceptedIdentity[] = [
      { ...valid, userId: 23 },
      { ...valid, chatId: -101 },
      { ...valid, chatType: "group" },
      { ...valid, conversationKey: "dm:-100" },
    ];

    for (const mismatch of mismatches) {
      expect(() => store.acceptUpdate(incoming, mismatch, 1_000)).toThrow(
        "identity does not match normalized update",
      );
    }
    expect(
      store.db.query("SELECT COUNT(*) AS count FROM updates").get(),
    ).toEqual({ count: 0 });
  });

  test("rejects forged admin roles without upgrading an existing guest", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);

    expect(() =>
      store.acceptUpdate(update(2, 22, 22), identity(22, 22, "admin"), 1_001),
    ).toThrow("identity role does not match configured authorization");
    expect(store.lookupIdentity(22)).toMatchObject({ role: "guest" });
    expect(store.listJobs()).toHaveLength(1);
  });

  test("accepts admin only when sender ID is configured", () => {
    const store = createStore(new Set([11]));

    expect(
      store.acceptUpdate(update(1, 11, 11), identity(11, 11, "admin"), 1_000),
    ).toBe(true);
    expect(store.lookupIdentity(11)).toMatchObject({ role: "admin" });
    expect(() =>
      store.acceptUpdate(update(2, 11, 11), identity(11, 11, "guest"), 1_001),
    ).toThrow("identity role does not match configured authorization");
  });

  test("round-trips Telegram IDs beyond the 32-bit range", () => {
    const userId = 5_000_000_123;
    const groupId = -1_000_000_000_123;
    const store = createStore(new Set([userId]));

    expect(
      store.acceptUpdate(
        update(6_000_000_001, groupId, userId, "supergroup"),
        identity(groupId, userId, "admin", "supergroup"),
        1_000,
      ),
    ).toBe(true);
    expect(store.lookupIdentity(userId)).toMatchObject({ role: "admin" });
    expect(store.listJobs()[0]).toMatchObject({
      updateId: 6_000_000_001,
      conversationKey: `group:${groupId}`,
    });
    expect(store.getConversation(`group:${groupId}`)).toMatchObject({
      chatId: groupId,
    });
  });
});

describe("Store leases", () => {
  test("rejects invalid timestamps without mutating leased state", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    expect(() =>
      store.leaseNextJob("worker-a", Number.POSITIVE_INFINITY, 100),
    ).toThrow("timestamp must be a non-negative safe integer");
    const job = store.leaseNextJob("worker-a", 2_000, 100)!;

    expect(() => store.recoverExpiredLeases(Number.POSITIVE_INFINITY)).toThrow(
      "timestamp must be a non-negative safe integer",
    );
    expect(() =>
      store.renewLease(
        job.id,
        "worker-a",
        job.leaseToken!,
        Number.POSITIVE_INFINITY,
        100,
      ),
    ).toThrow("timestamp must be a non-negative safe integer");
    expect(() =>
      store.completeJob(
        job.id,
        "worker-a",
        job.leaseToken!,
        "result",
        "bad-session",
        Number.POSITIVE_INFINITY,
      ),
    ).toThrow("timestamp must be a non-negative safe integer");
    expect(() =>
      store.failJob(
        job.id,
        "worker-a",
        job.leaseToken!,
        "error",
        false,
        Number.POSITIVE_INFINITY,
      ),
    ).toThrow("timestamp must be a non-negative safe integer");
    expect(() =>
      store.resetConversation("dm:22", Number.POSITIVE_INFINITY),
    ).toThrow("timestamp must be a non-negative safe integer");
    expect(() =>
      store.blockUser(22, 11, "reason", Number.POSITIVE_INFINITY),
    ).toThrow("timestamp must be a non-negative safe integer");
    expect(() =>
      store.setSetting("mode", "public", Number.POSITIVE_INFINITY),
    ).toThrow("timestamp must be a non-negative safe integer");

    expect(store.getJob(job.id)).toMatchObject({
      status: "running",
      leaseToken: job.leaseToken,
    });
    expect(store.getConversation("dm:22")).toMatchObject({
      generation: 1,
      sessionId: null,
    });
    expect(store.isBlocked(22)).toBe(false);
    expect(store.getSetting("mode")).toBeNull();
  });

  test("rejects invalid acquisition durations and expiry overflow", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);

    for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => store.leaseNextJob("worker-a", 2_000, duration)).toThrow(
        "lease duration must be a positive safe integer",
      );
    }
    expect(() =>
      store.leaseNextJob("worker-a", Number.MAX_SAFE_INTEGER - 5, 10),
    ).toThrow("lease expiry exceeds safe integer range");
    expect(store.listJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
  });

  test("leases at most one job per conversation while allowing another conversation", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    store.acceptUpdate(update(2, 22, 22), identity(22, 22), 1_001);
    store.acceptUpdate(update(3, 33, 33), identity(33, 33), 1_002);

    expect(store.leaseNextJob("worker-a", 2_000, 500)).toMatchObject({
      updateId: 1,
      conversationKey: "dm:22",
      attempts: 1,
    });
    expect(store.leaseNextJob("worker-b", 2_000, 500)).toMatchObject({
      updateId: 3,
      conversationKey: "dm:33",
      attempts: 1,
    });
    expect(store.leaseNextJob("worker-c", 2_000, 500)).toBeNull();
  });

  test("allows exactly one concurrent lease winner across two processes", async () => {
    const path = createDatabasePath();
    const store = trackStore(new Store(path));
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    const barrierPath = join(path, "..", "lease-barrier");
    const workerPath = join(path, "..", "lease-worker.ts");
    const readyPaths = [
      join(path, "..", "worker-a.ready"),
      join(path, "..", "worker-b.ready"),
    ];
    const storeModule = join(import.meta.dir, "../src/store.ts");
    writeFileSync(
      workerPath,
      `
        import { existsSync, writeFileSync } from "node:fs";
        import { Store } from ${JSON.stringify(storeModule)};

        const [databasePath, readyPath, barrierPath, owner] = process.argv.slice(2);
        const store = new Store(databasePath);
        writeFileSync(readyPath, "ready");
        while (!existsSync(barrierPath)) await Bun.sleep(1);
        try {
          const job = store.leaseNextJob(owner, 2_000, 1_000);
          process.stdout.write(JSON.stringify(job && { id: job.id, owner: job.leaseOwner }));
        } finally {
          store.close();
        }
      `,
    );

    const children = ["worker-a", "worker-b"].map((owner, index) =>
      Bun.spawn([process.execPath, workerPath, path, readyPaths[index]!, barrierPath, owner], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputPromises = children.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    });

    let readinessError: unknown;
    try {
      await waitForFiles(readyPaths);
    } catch (error) {
      readinessError = error;
    } finally {
      if (!existsSync(barrierPath)) writeFileSync(barrierPath, "go");
    }
    const outputs = await Promise.all(outputPromises);
    if (readinessError) throw readinessError;
    expect(outputs.map(({ exitCode }) => exitCode)).toEqual([0, 0]);
    expect(outputs.map(({ stderr }) => stderr)).toEqual(["", ""]);
    const winners = outputs
      .map(({ stdout }) => JSON.parse(stdout) as { id: number; owner: string } | null)
      .filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ id: 1 });
  });

  test("recovers expired leases and makes the job eligible again", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);

    const first = store.leaseNextJob("worker-a", 2_000, 100);
    expect(first).toMatchObject({ status: "running", leaseUntil: 2_100 });
    expect(store.recoverExpiredLeases(2_099)).toBe(0);
    expect(store.recoverExpiredLeases(2_101)).toBe(1);
    expect(store.leaseNextJob("worker-b", 2_101, 100)).toMatchObject({
      id: first!.id,
      status: "running",
      attempts: 2,
      leaseOwner: "worker-b",
    });
  });

  test("rejects completion and failure from workers whose leases expired", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    store.acceptUpdate(update(2, 33, 33), identity(33, 33), 1_001);
    const completion = store.leaseNextJob("worker-a", 2_000, 100)!;
    const failure = store.leaseNextJob("worker-b", 2_000, 100)!;

    expect(
      store.completeJob(
        completion.id,
        "worker-a",
        completion.leaseToken!,
        "stale result",
        "stale-session",
        2_101,
      ),
    ).toBe(false);
    expect(
      store.failJob(
        failure.id,
        "worker-b",
        failure.leaseToken!,
        "stale error",
        false,
        2_101,
      ),
    ).toBe(false);
    expect(store.getJob(completion.id)).toMatchObject({
      status: "running",
      leaseOwner: "worker-a",
    });
    expect(store.getJob(failure.id)).toMatchObject({
      status: "running",
      leaseOwner: "worker-b",
    });
    expect(store.getConversation("dm:22")).toMatchObject({ sessionId: null });
  });

  test("renews only live leases with a positive duration", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    const job = store.leaseNextJob("worker-a", 2_000, 100)!;

    for (const duration of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() =>
        store.renewLease(job.id, "worker-a", job.leaseToken!, 2_050, duration),
      ).toThrow("lease duration must be a positive safe integer");
    }
    expect(() =>
      store.renewLease(
        job.id,
        "worker-a",
        job.leaseToken!,
        Number.MAX_SAFE_INTEGER - 5,
        10,
      ),
    ).toThrow("lease expiry exceeds safe integer range");
    expect(
      store.renewLease(job.id, "worker-a", job.leaseToken!, 2_050, 200),
    ).toBe(true);
    expect(store.getJob(job.id)).toMatchObject({ leaseUntil: 2_250 });
    expect(
      store.renewLease(job.id, "worker-a", job.leaseToken!, 2_250, 200),
    ).toBe(false);
  });

  test("fences a stale attempt when the same owner reacquires the job", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    const first = store.leaseNextJob("worker-a", 2_000, 100)!;

    expect(store.recoverExpiredLeases(2_101)).toBe(1);
    const second = store.leaseNextJob("worker-a", 2_101, 1_000)!;
    expect(first.leaseToken).not.toBe(second.leaseToken);

    expect(
      store.renewLease(first.id, "worker-a", first.leaseToken!, 2_200, 500),
    ).toBe(false);
    expect(
      store.failJob(
        first.id,
        "worker-a",
        first.leaseToken!,
        "stale error",
        false,
        2_200,
      ),
    ).toBe(false);
    expect(
      store.completeJob(
        first.id,
        "worker-a",
        first.leaseToken!,
        "stale result",
        "stale-session",
        2_200,
      ),
    ).toBe(false);
    expect(store.getConversation("dm:22")).toMatchObject({ sessionId: null });
    expect(
      store.completeJob(
        second.id,
        "worker-a",
        second.leaseToken!,
        "current result",
        "current-session",
        2_200,
      ),
    ).toBe(true);
    expect(store.getConversation("dm:22")).toMatchObject({
      sessionId: "current-session",
    });
  });
});

describe("Store conversations and controls", () => {
  test("persists a session only through fenced completion before reset", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    const job = store.leaseNextJob("worker-a", 1_050, 1_000)!;

    expect(
      store.completeJob(
        job.id,
        "worker-a",
        job.leaseToken!,
        "result",
        "session-one",
        1_100,
      ),
    ).toBe(true);
    expect(store.getConversation("dm:22")).toMatchObject({
      key: "dm:22",
      chatId: 22,
      sessionId: "session-one",
      generation: 1,
    });
    expect("setConversationSession" in store).toBe(false);
    expect(store.resetConversation("dm:22", 1_200)).toBe(2);
    expect(store.getConversation("dm:22")).toMatchObject({
      sessionId: null,
      generation: 2,
      state: "active",
    });
  });

  test("reset fences queued and in-flight jobs from the previous generation", () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22, 22), identity(22, 22), 1_000);
    store.acceptUpdate(update(2, 22, 22), identity(22, 22), 1_001);
    const inFlight = store.leaseNextJob("worker-a", 2_000, 1_000)!;

    expect(store.resetConversation("dm:22", 2_100)).toBe(2);
    expect(store.listJobs("dm:22")).toEqual([
      expect.objectContaining({
        id: inFlight.id,
        generation: 1,
        status: "failed",
        error: "conversation_reset",
        leaseOwner: null,
      }),
      expect.objectContaining({
        updateId: 2,
        generation: 1,
        status: "failed",
        error: "conversation_reset",
      }),
    ]);
    expect(
      store.completeJob(
        inFlight.id,
        "worker-a",
        inFlight.leaseToken!,
        "stale result",
        "old-session",
        2_200,
      ),
    ).toBe(false);
    expect(store.getConversation("dm:22")).toMatchObject({
      generation: 2,
      sessionId: null,
      leaseOwner: null,
      leaseUntil: null,
    });

    store.acceptUpdate(update(3, 22, 22), identity(22, 22), 2_300);
    expect(store.leaseNextJob("worker-b", 2_400, 1_000)).toMatchObject({
      updateId: 3,
      generation: 2,
    });
  });

  test("blocks and unblocks numeric Telegram identities with audit data", () => {
    const store = createStore();

    expect(store.isBlocked(22)).toBe(false);
    store.blockUser(22, 11, "abuse", 1_000);
    expect(store.isBlocked(22)).toBe(true);
    expect(store.lookupIdentity(22)).toMatchObject({ blocked: true });
    expect(store.unblockUser(22)).toBe(true);
    expect(store.isBlocked(22)).toBe(false);
    expect(store.unblockUser(22)).toBe(false);
  });

  test("persists settings", () => {
    const store = createStore();

    expect(store.getSetting("guest_access_mode")).toBeNull();
    store.setSetting("guest_access_mode", "invite", 1_000);
    expect(store.getSetting("guest_access_mode")).toBe("invite");
    store.setSetting("guest_access_mode", "public", 2_000);
    expect(store.getSetting("guest_access_mode")).toBe("public");
  });
});
