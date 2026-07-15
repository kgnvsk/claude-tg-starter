import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Dispatcher, type DispatcherOptions } from "../src/dispatcher";
import { Store } from "../src/store";
import { encodeConversationKey, type AcceptedIdentity, type NormalizedUpdate } from "../src/types";
import type { WorkerRequest, WorkerResult } from "../src/worker";

const temporaryDirectories: string[] = [];
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-dispatcher-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createStore(adminChatIds: ReadonlySet<number> = new Set()): Store {
  const store = new Store(join(temporaryDirectory(), "state.sqlite"), { adminChatIds });
  stores.push(store);
  return store;
}

function update(
  updateId: number,
  chatId: number,
  senderId = chatId,
  chatType: "private" | "group" | "supergroup" = "private",
): NormalizedUpdate {
  return {
    updateId,
    message: {
      messageId: updateId * 10,
      date: 1_752_528_000,
      text: `message ${updateId}`,
      sender: { id: senderId },
      chat: { id: chatId, type: chatType },
    },
  };
}

function identity(
  chatId: number,
  userId = chatId,
  role: "admin" | "guest" = "guest",
  chatType: "private" | "group" | "supergroup" = "private",
): AcceptedIdentity {
  return {
    accepted: true,
    role,
    userId,
    chatId,
    chatType,
    conversationKey: chatType === "private" ? `dm:${chatId}` : `group:${chatId}`,
  };
}

function success(request: WorkerRequest, suffix = ""): WorkerResult {
  return {
    ok: true,
    sessionId: `session-${request.job.updateId}${suffix}`,
    text: `answer ${request.job.updateId}`,
    effectiveRole: request.job.payload.message.chat.type === "private"
      ? request.job.role
      : "guest",
    diagnostics: [],
    progress: [{ type: "assistant", text: "working" }],
  };
}

function failure(retryable: boolean, message: string): WorkerResult {
  return {
    ok: false,
    error: {
      kind: retryable ? "network" : "input",
      retryable,
      message,
      stderr: "",
      exitCode: null,
      diagnostics: [],
      progress: [],
    },
  };
}

class ManualClock {
  nowMs = 1_000;
  private waiters: Array<{
    at: number;
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  now = (): number => this.nowMs;

  sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const waiter = {
        at: this.nowMs + milliseconds,
        resolve,
        reject,
        signal,
        abort: () => reject(signal.reason),
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  };

  advance(milliseconds: number): void {
    this.nowMs += milliseconds;
    const due = this.waiters.filter(({ at }) => at <= this.nowMs);
    this.waiters = this.waiters.filter(({ at }) => at > this.nowMs);
    for (const waiter of due) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    }
  }
}

interface PendingCall {
  request: WorkerRequest;
  resolve: (result: WorkerResult) => void;
}

class ControlledWorker {
  calls: PendingCall[] = [];

  run = (request: WorkerRequest): Promise<WorkerResult> =>
    new Promise((resolve) => this.calls.push({ request, resolve }));
}

function options(
  store: Store,
  worker: DispatcherOptions["worker"],
  clock: ManualClock,
  overrides: Partial<DispatcherOptions> = {},
): DispatcherOptions {
  return {
    store,
    worker,
    workspacesBase: temporaryDirectory(),
    maxWorkers: 2,
    workerTimeoutMs: 1_000,
    leaseMs: 300,
    renewalIntervalMs: 100,
    pollIntervalMs: 50,
    maxAttempts: 3,
    initialBackoffMs: 200,
    maxBackoffMs: 1_000,
    shutdownTimeoutMs: 250,
    clock: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe("Dispatcher", () => {
  test("overlaps conversations up to maxWorkers while serializing each conversation in order", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 22), identity(22), 901);
    store.acceptUpdate(update(3, 33), identity(33), 902);
    store.acceptUpdate(update(4, 44), identity(44), 903);
    const clock = new ManualClock();
    const worker = new ControlledWorker();
    const dispatcher = new Dispatcher(options(store, worker, clock));

    expect(dispatcher.poll()).toBe(2);
    await settle();
    expect(worker.calls.map(({ request }) => request.job.updateId)).toEqual([1, 3]);
    expect(store.getJob(2)).toMatchObject({ status: "queued" });
    expect(store.getJob(4)).toMatchObject({ status: "queued" });
    expect(worker.calls[0]!.request.workspacePath).toBe(
      join(dispatcher.workspacesBase, encodeConversationKey("dm:22")),
    );
    expect(existsSync(worker.calls[0]!.request.workspacePath)).toBe(true);

    worker.calls[0]!.resolve(success(worker.calls[0]!.request));
    await settle();
    expect(dispatcher.poll()).toBe(1);
    await settle();
    expect(worker.calls.map(({ request }) => request.job.updateId)).toEqual([1, 3, 2]);
    expect(worker.calls[2]!.request.conversation.sessionId).toBe("session-1");
    expect(worker.calls.filter(({ request }) => request.job.conversationKey === "dm:22"))
      .toHaveLength(2);

    worker.calls[1]!.resolve(success(worker.calls[1]!.request));
    worker.calls[2]!.resolve(success(worker.calls[2]!.request));
    await dispatcher.waitForIdle();
    expect(dispatcher.poll()).toBe(1);
    await settle();
    worker.calls[3]!.resolve(success(worker.calls[3]!.request));
    await dispatcher.waitForIdle();
  });

  test("renews both leases and aborts the worker when its token fence is lost", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 33), identity(33), 901);
    const clock = new ManualClock();
    let workerSignal: AbortSignal | undefined;
    let finishTermination: (() => void) | undefined;
    const calls: number[] = [];
    const worker = {
      run: (request: WorkerRequest) => {
        calls.push(request.job.updateId);
        workerSignal = request.signal;
        if (request.job.updateId !== 1) return Promise.resolve(success(request));
        return new Promise<WorkerResult>((resolve) => {
          request.signal!.addEventListener("abort", () => {
            finishTermination = () => resolve(success(request, "-stale"));
          });
        });
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, { maxWorkers: 1 }));

    dispatcher.poll();
    await settle();
    const leased = store.listJobs()[0]!;
    expect(leased.leaseUntil).toBe(1_300);
    clock.advance(100);
    await settle();
    expect(store.listJobs()[0]!.leaseUntil).toBe(1_400);

    store.db.query("UPDATE jobs SET lease_token = 'stolen' WHERE id = ?").run(leased.id);
    clock.advance(100);
    await settle();
    expect(workerSignal?.aborted).toBe(true);
    expect(finishTermination).toBeDefined();
    expect(dispatcher.poll()).toBe(0);
    expect(calls).toEqual([1]);

    finishTermination!();
    await dispatcher.waitForIdle();
    expect(store.listOutboundReplies()).toHaveLength(0);
    expect(store.getJob(leased.id)).toMatchObject({ status: "running", result: null });
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([1, 2]);
  });

  test("does not recover a quarantined job after lease expiry until its worker settles", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    let finishTermination: (() => void) | undefined;
    const calls: number[] = [];
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> => {
        calls.push(request.job.updateId);
        if (calls.length > 1) return Promise.resolve(success(request));
        return new Promise((resolve) => {
          request.signal!.addEventListener("abort", () => {
            finishTermination = () => resolve(failure(false, "terminated"));
          }, { once: true });
        });
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock));

    dispatcher.poll();
    await settle();
    const first = store.listJobs()[0]!;
    store.db.query("UPDATE jobs SET lease_token = 'stolen' WHERE id = ?").run(first.id);
    clock.advance(100);
    await settle();
    expect(finishTermination).toBeDefined();

    clock.advance(201);
    expect(dispatcher.poll()).toBe(0);
    expect(dispatcher.poll()).toBe(0);
    expect(store.getJob(first.id)).toMatchObject({
      status: "running",
      attempts: 1,
    });
    expect(calls).toEqual([1]);

    finishTermination!();
    await dispatcher.waitForIdle();
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([1, 1]);
    expect(store.getJob(first.id)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("retries only retryable failures with exponential due-time backoff", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    let attempts = 0;
    const worker = {
      run: async (request: WorkerRequest): Promise<WorkerResult> => {
        attempts++;
        return attempts < 3 ? failure(true, "network unavailable") : success(request);
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(store.listJobs()[0]).toMatchObject({ status: "queued", attempts: 1 });
    expect(dispatcher.poll()).toBe(0);
    clock.advance(200);
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(store.listJobs()[0]).toMatchObject({ status: "queued", attempts: 2 });
    clock.advance(399);
    expect(dispatcher.poll()).toBe(0);
    clock.advance(1);
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(store.listJobs()[0]).toMatchObject({ status: "completed", attempts: 3 });
    expect(store.listOutboundReplies()[0]).toMatchObject({
      chatId: 22,
      text: "answer 1",
      status: "pending",
    });
  });

  test("turns poison and exhausted failures into durable errors without blocking later turns", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 22), identity(22), 901);
    const clock = new ManualClock();
    const worker = {
      run: async (request: WorkerRequest): Promise<WorkerResult> =>
        request.job.updateId === 1
          ? failure(false, "invalid attachment")
          : success(request),
    };
    const dispatcher = new Dispatcher(options(store, worker, clock));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(store.listJobs()[0]).toMatchObject({ status: "failed" });
    expect(store.listOutboundReplies()[0]).toMatchObject({
      updateId: 1,
      chatId: 22,
      text: "Sorry, I could not process that message.",
    });
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(store.listJobs()[1]).toMatchObject({ status: "completed" });
    expect(store.listOutboundReplies()).toHaveLength(2);
  });

  test("recovers an expired lease after restart and fences the stale completion", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const stale = store.leaseNextJob("dead-dispatcher", 1_000, 100)!;
    const clock = new ManualClock();
    clock.advance(101);
    const worker = { run: async (request: WorkerRequest) => success(request) };
    const dispatcher = new Dispatcher(options(store, worker, clock));

    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(store.getJob(stale.id)).toMatchObject({
      status: "completed",
      attempts: 2,
      result: "answer 1",
    });
    expect(store.completeJob(
      stale.id,
      "dead-dispatcher",
      stale.leaseToken!,
      "stale",
      "stale-session",
      "guest",
      clock.now(),
    )).toBe(false);
  });

  test("terminalizes a crashed final attempt and continues without another worker execution", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 22), identity(22), 901);
    store.leaseNextJob("dead-dispatcher", 1_000, 100);
    const clock = new ManualClock();
    clock.advance(101);
    const calls: number[] = [];
    const worker = {
      run: async (request: WorkerRequest) => {
        calls.push(request.job.updateId);
        return success(request);
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, { maxAttempts: 1 }));

    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([2]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "attempts_exhausted",
    });
    expect(store.listOutboundReplies()[0]).toMatchObject({
      updateId: 1,
      chatId: 22,
      text: "Sorry, I could not process that message.",
    });
  });

  test("aborts a timed-out worker and schedules it through retry backoff", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    let workerSignal: AbortSignal | undefined;
    const statuses: string[] = [];
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> => {
        workerSignal = request.signal;
        return new Promise((resolve) => {
          const terminate = () => resolve(failure(false, "worker terminated"));
          if (request.signal!.aborted) terminate();
          else request.signal!.addEventListener("abort", terminate, { once: true });
        });
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      workerTimeoutMs: 250,
      status: (state) => statuses.push(state),
    }));

    dispatcher.poll();
    await settle();
    clock.advance(100);
    await settle();
    clock.advance(100);
    await settle();
    clock.advance(50);
    await dispatcher.waitForIdle();
    expect(workerSignal?.aborted).toBe(true);
    expect(store.listJobs()[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      error: "Worker timed out after 250ms",
    });
    expect(statuses).toEqual(["timeout", "queued"]);
    expect(dispatcher.poll()).toBe(0);
    clock.advance(200);
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.shutdown();
  });

  test("reports renewal timer failure, joins the worker, and retries without false timeout", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    const statuses: string[] = [];
    let terminated = false;
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> =>
        new Promise((resolve) => {
          const terminate = () => {
            terminated = true;
            resolve(failure(false, "terminated"));
          };
          if (request.signal!.aborted) terminate();
          else request.signal!.addEventListener("abort", terminate, { once: true });
        }),
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      sleep: (milliseconds, signal) =>
        milliseconds === 100
          ? Promise.reject(new Error("renewal timer failed"))
          : clock.sleep(milliseconds, signal),
      status: (state) => statuses.push(state),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    }));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(terminated).toBe(true);
    expect(errors).toEqual(["renewal timer failed"]);
    expect(statuses).toEqual(["queued"]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      error: "renewal timer failed",
    });
  });

  test("reports timeout timer rejection as scheduler failure instead of timeout", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    const statuses: string[] = [];
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> =>
        new Promise((resolve) => {
          const terminate = () => resolve(failure(false, "terminated"));
          if (request.signal!.aborted) terminate();
          else request.signal!.addEventListener("abort", terminate, { once: true });
        }),
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      workerTimeoutMs: 250,
      sleep: (milliseconds, signal) =>
        milliseconds === 250
          ? Promise.reject(new Error("timeout timer failed"))
          : clock.sleep(milliseconds, signal),
      status: (state) => statuses.push(state),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    }));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual(["timeout timer failed"]);
    expect(statuses).toEqual(["queued"]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "queued",
      attempts: 1,
      error: "timeout timer failed",
    });
  });

  test("holds the slot and fence until a timed-out worker actually terminates", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 33), identity(33), 901);
    const clock = new ManualClock();
    let finishTermination: (() => void) | undefined;
    const calls: number[] = [];
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> => {
        calls.push(request.job.updateId);
        if (request.job.updateId !== 1) return Promise.resolve(success(request));
        return new Promise((resolve) => {
          request.signal!.addEventListener("abort", () => {
            finishTermination = () => resolve(failure(false, "terminated"));
          }, { once: true });
        });
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      maxWorkers: 1,
      workerTimeoutMs: 250,
    }));

    dispatcher.poll();
    await settle();
    clock.advance(100);
    await settle();
    clock.advance(100);
    await settle();
    clock.advance(50);
    await settle();

    expect(finishTermination).toBeDefined();
    expect(store.getJob(1)).toMatchObject({ status: "running", attempts: 1 });
    expect(dispatcher.poll()).toBe(0);
    expect(calls).toEqual([1]);

    finishTermination!();
    await dispatcher.waitForIdle();
    expect(store.getJob(1)).toMatchObject({ status: "queued", attempts: 1 });
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([1, 2]);
  });

  test("persists returned session role and forces group admin turns to effective guest", async () => {
    const store = createStore(new Set([11]));
    store.acceptUpdate(update(1, -100, 11, "supergroup"), identity(-100, 11, "admin", "supergroup"), 900);
    const clock = new ManualClock();
    const worker = { run: async (request: WorkerRequest) => success(request) };
    const dispatcher = new Dispatcher(options(store, worker, clock));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(store.getConversation("group:-100")).toMatchObject({
      sessionId: "session-1",
      sessionRole: "guest",
    });
    expect(store.listOutboundReplies()[0]).toMatchObject({ chatId: -100 });
  });

  test("sends nonfatal typing heartbeats only to the stored conversation chat", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const worker = new ControlledWorker();
    const typed: number[] = [];
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      typing: async (chatId) => {
        typed.push(chatId);
        throw new Error("typing unavailable");
      },
    }));

    dispatcher.poll();
    await settle();
    clock.advance(100);
    await settle();
    worker.calls[0]!.resolve(success(worker.calls[0]!.request));
    await dispatcher.waitForIdle();
    expect(typed).toEqual([22, 22]);
    expect(store.listJobs()[0]).toMatchObject({ status: "completed" });
  });

  test("checks admission before leasing and reports queued status best-effort", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const calls: number[] = [];
    const statuses: Array<{ state: string; chatId: number }> = [];
    let admitted = false;
    const worker = {
      run: async (request: WorkerRequest) => {
        calls.push(request.job.updateId);
        return success(request);
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      admissionGuard: () => admitted,
      status: async (state, scope) => {
        statuses.push({ state, chatId: scope.chatId });
        throw new Error("status unavailable");
      },
    }));

    expect(dispatcher.poll()).toBe(0);
    await settle();
    expect(store.listJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(calls).toEqual([]);
    expect(statuses).toEqual([{ state: "queued", chatId: 22 }]);

    admitted = true;
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([1]);
  });

  test("contains completion persistence errors and leaves the fenced lease for recovery", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: Array<{ message: string; phase?: string }> = [];
    store.completeJobWithReply = () => {
      throw new Error("database unavailable on completion");
    };
    const dispatcher = new Dispatcher(options(
      store,
      { run: async (request) => success(request) },
      clock,
      {
        onError: (error, context) => errors.push({
          message: error instanceof Error ? error.message : String(error),
          phase: context.phase,
        }),
      },
    ));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual([{
      message: "database unavailable on completion",
      phase: "execute",
    }]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwner: expect.any(String),
    });
    expect(store.listOutboundReplies()).toHaveLength(0);
  });

  test("treats conversation Store read errors as recoverable infrastructure failures", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    const getConversation = store.getConversation.bind(store);
    let reads = 0;
    store.getConversation = (conversationKey) => {
      if (reads++ === 0) throw new Error("database unavailable on conversation read");
      return getConversation(conversationKey);
    };
    const calls: number[] = [];
    const dispatcher = new Dispatcher(options(
      store,
      { run: async (request) => {
        calls.push(request.job.updateId);
        return success(request);
      } },
      clock,
      {
        onError: (error) => errors.push(
          error instanceof Error ? error.message : String(error),
        ),
      },
    ));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual(["database unavailable on conversation read"]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "queued",
      attempts: 0,
      leaseOwner: null,
    });
    expect(store.listOutboundReplies()).toHaveLength(0);
    expect(calls).toEqual([]);

    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(calls).toEqual([1]);
    expect(store.listJobs()[0]).toMatchObject({ status: "completed", attempts: 1 });
  });

  test("terminally fails persistent workspace validation errors and unblocks later turns", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    store.acceptUpdate(update(2, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    const worker = { run: async (request: WorkerRequest) => success(request) };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    }));
    const workspacePath = join(
      dispatcher.workspacesBase,
      encodeConversationKey("dm:22"),
    );
    symlinkSync(temporaryDirectory(), workspacePath);

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual(["conversation workspace must be a real directory"]);
    expect(store.listJobs()[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(store.listOutboundReplies()).toHaveLength(1);

    rmSync(workspacePath);
    expect(dispatcher.poll()).toBe(1);
    await dispatcher.waitForIdle();
    expect(store.listJobs()[1]).toMatchObject({ status: "completed", attempts: 1 });
  });

  test("leaves the lease for expiry when unstarted release persistence fails", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    store.getConversation = () => {
      throw new Error("database unavailable on conversation read");
    };
    store.releaseUnstartedJob = () => {
      throw new Error("database unavailable on unstarted release");
    };
    const dispatcher = new Dispatcher(options(
      store,
      { run: async (request) => success(request) },
      clock,
      {
        onError: (error) => errors.push(
          error instanceof Error ? error.message : String(error),
        ),
      },
    ));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual([
      "database unavailable on conversation read",
      "database unavailable on unstarted release",
    ]);
    expect(store.listJobs()[0]).toMatchObject({ status: "running", attempts: 1 });
  });

  test("contains terminal failure persistence errors without unsafe release", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    store.failJobWithReply = () => {
      throw new Error("database unavailable on failure outbox");
    };
    const dispatcher = new Dispatcher(options(
      store,
      { run: async () => failure(false, "poison input") },
      clock,
      {
        onError: (error) => errors.push(
          error instanceof Error ? error.message : String(error),
        ),
      },
    ));

    dispatcher.poll();
    await dispatcher.waitForIdle();
    expect(errors).toEqual(["database unavailable on failure outbox"]);
    expect(store.listJobs()[0]).toMatchObject({
      status: "running",
      attempts: 1,
      leaseOwner: expect.any(String),
    });
    expect(store.listOutboundReplies()).toHaveLength(0);
  });

  test("aborts and joins the worker when renewal persistence throws", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    const errors: string[] = [];
    let terminated = false;
    store.renewLease = () => {
      throw new Error("database unavailable on renewal");
    };
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> =>
        new Promise((resolve) => request.signal!.addEventListener("abort", () => {
          terminated = true;
          resolve(failure(false, "terminated"));
        }, { once: true })),
    };
    const dispatcher = new Dispatcher(options(store, worker, clock, {
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    }));

    dispatcher.poll();
    await settle();
    clock.advance(100);
    await dispatcher.waitForIdle();
    expect(terminated).toBe(true);
    expect(errors).toEqual(["database unavailable on renewal"]);
    expect(store.listJobs()[0]).toMatchObject({ status: "running", attempts: 1 });
  });

  test("shutdown aborts workers, requeues claims, and returns after a bounded wait", async () => {
    const store = createStore();
    store.acceptUpdate(update(1, 22), identity(22), 900);
    const clock = new ManualClock();
    let signal: AbortSignal | undefined;
    let finishTermination: (() => void) | undefined;
    const worker = {
      run: (request: WorkerRequest): Promise<WorkerResult> => {
        signal = request.signal;
        return new Promise((resolve) => request.signal!.addEventListener("abort", () => {
          finishTermination = () => resolve(failure(false, "terminated"));
        }, { once: true }));
      },
    };
    const dispatcher = new Dispatcher(options(store, worker, clock));
    dispatcher.poll();
    await settle();

    const shutdown = dispatcher.shutdown();
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(store.listJobs()[0]).toMatchObject({ status: "running", attempts: 1 });
    clock.advance(250);
    await shutdown;
    expect(store.listJobs()[0]).toMatchObject({ status: "running", attempts: 1 });
    finishTermination!();
    await dispatcher.waitForIdle();
    expect(store.listJobs()[0]).toMatchObject({ status: "queued", attempts: 0 });
    expect(dispatcher.poll()).toBe(0);
  });

  test("rejects dispatcher timing relationships that cannot preserve a fence", () => {
    const store = createStore();
    const clock = new ManualClock();
    const worker = { run: async (request: WorkerRequest) => success(request) };

    expect(() => new Dispatcher(options(store, worker, clock, {
      renewalIntervalMs: 300,
      leaseMs: 300,
    }))).toThrow("renewal interval");
    expect(() => new Dispatcher(options(store, worker, clock, {
      renewalIntervalMs: 1_000,
      workerTimeoutMs: 1_000,
    }))).toThrow("renewal interval");
    expect(() => new Dispatcher(options(store, worker, clock, {
      maxWorkers: 0,
    }))).toThrow("maxWorkers");
  });
});
