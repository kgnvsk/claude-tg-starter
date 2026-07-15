import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { Store, type ActiveLeaseDescriptor } from "./store";
import {
  encodeConversationKey,
  type StoredConversation,
  type StoredJob,
} from "./types";
import type { WorkerRequest, WorkerResult } from "./worker";

const DEFAULT_ERROR_REPLY = "Sorry, I could not process that message.";
const LOST_FENCE = Symbol("lost-fence");
const SHUTDOWN = Symbol("shutdown");
const WORKER_TIMEOUT = Symbol("worker-timeout");
const STORE_FAILURE = Symbol("store-failure");
const SCHEDULER_FAILURE = Symbol("scheduler-failure");
const TIMER_CANCELLED = Symbol("timer-cancelled");

interface SchedulerFailure {
  type: typeof SCHEDULER_FAILURE;
  error: unknown;
  reported: boolean;
}

export interface DispatcherWorker {
  run(request: WorkerRequest): Promise<WorkerResult>;
}

export interface DispatcherAdmissionContext {
  activeWorkers: number;
  maxWorkers: number;
}

export interface DispatcherStatusScope {
  jobId: number;
  updateId: number;
  conversationKey: string;
  chatId: number;
}

export interface DispatcherErrorContext {
  phase: "poll" | "execute" | "renewal";
  jobId?: number;
}

export interface DispatcherOptions {
  store: Store;
  worker: DispatcherWorker;
  workspacesBase: string;
  maxWorkers?: number;
  workerTimeoutMs?: number;
  leaseMs?: number;
  renewalIntervalMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  shutdownTimeoutMs?: number;
  leaseOwner?: string;
  errorReplyText?: string;
  typing?: (chatId: number, signal?: AbortSignal) => void | Promise<void>;
  admissionGuard?: (context: DispatcherAdmissionContext) => boolean;
  status?: (
    state: "queued" | "timeout",
    scope: DispatcherStatusScope,
    signal?: AbortSignal,
  ) => void | Promise<void>;
  onError?: (
    error: unknown,
    context: DispatcherErrorContext,
  ) => void | Promise<void>;
  clock?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface ActiveExecution {
  job: StoredJob;
  controller: AbortController;
  promise: Promise<void>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function schedulerFailure(error: unknown, reported = false): SchedulerFailure {
  return { type: SCHEDULER_FAILURE, error, reported };
}

function isSchedulerFailure(value: unknown): value is SchedulerFailure {
  return typeof value === "object"
    && value !== null
    && (value as { type?: unknown }).type === SCHEDULER_FAILURE;
}

function isContained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolveSleep, rejectSleep) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolveSleep();
    };
    const timeout = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      rejectSleep(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export class Dispatcher {
  readonly workspacesBase: string;

  private readonly store: Store;
  private readonly worker: DispatcherWorker;
  private readonly maxWorkers: number;
  private readonly workerTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly renewalIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly leaseOwner: string;
  private readonly errorReplyText: string;
  private readonly typing?: DispatcherOptions["typing"];
  private readonly admissionGuard?: DispatcherOptions["admissionGuard"];
  private readonly status?: DispatcherOptions["status"];
  private readonly onError?: DispatcherOptions["onError"];
  private readonly clock: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly active = new Map<number, ActiveExecution>();
  private readonly queuedStatusSent = new Set<number>();
  private stopping = false;

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.worker = options.worker;
    if (!options.workspacesBase) throw new Error("workspacesBase is required");
    const requestedWorkspacesBase = resolve(options.workspacesBase);
    mkdirSync(requestedWorkspacesBase, { recursive: true, mode: 0o700 });
    const workspacesBaseStat = lstatSync(requestedWorkspacesBase);
    if (workspacesBaseStat.isSymbolicLink() || !workspacesBaseStat.isDirectory()) {
      throw new Error("workspaces base must be a real directory");
    }
    this.workspacesBase = realpathSync(requestedWorkspacesBase);
    this.maxWorkers = positiveInteger(options.maxWorkers ?? 4, "maxWorkers");
    this.workerTimeoutMs = positiveInteger(
      options.workerTimeoutMs ?? 5 * 60_000,
      "workerTimeoutMs",
    );
    this.leaseMs = positiveInteger(options.leaseMs ?? 60_000, "leaseMs");
    this.renewalIntervalMs = positiveInteger(
      options.renewalIntervalMs ?? 20_000,
      "renewalIntervalMs",
    );
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 250, "pollIntervalMs");
    this.maxAttempts = positiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.initialBackoffMs = positiveInteger(
      options.initialBackoffMs ?? 1_000,
      "initialBackoffMs",
    );
    this.maxBackoffMs = positiveInteger(
      options.maxBackoffMs ?? 60_000,
      "maxBackoffMs",
    );
    this.shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs ?? 10_000,
      "shutdownTimeoutMs",
    );
    this.leaseOwner = options.leaseOwner ?? `dispatcher-${crypto.randomUUID()}`;
    this.errorReplyText = options.errorReplyText ?? DEFAULT_ERROR_REPLY;
    this.typing = options.typing;
    this.admissionGuard = options.admissionGuard;
    this.status = options.status;
    this.onError = options.onError;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;

    if (!this.leaseOwner) throw new Error("leaseOwner is required");
    if (!this.errorReplyText) throw new Error("errorReplyText is required");
    if (this.renewalIntervalMs >= this.leaseMs) {
      throw new Error("renewal interval must be shorter than the lease");
    }
    if (this.renewalIntervalMs >= this.workerTimeoutMs) {
      throw new Error("renewal interval must be shorter than the worker timeout");
    }
    if (this.maxBackoffMs < this.initialBackoffMs) {
      throw new Error("maximum backoff must not be shorter than initial backoff");
    }
  }

  poll(): number {
    if (this.stopping) return 0;
    const now = this.clock();
    try {
      this.store.recoverExpiredLeases(now, this.activeLeaseExclusions());
      this.store.failExhaustedJobs(this.maxAttempts, this.errorReplyText, now);
    } catch (error) {
      this.reportError(error, { phase: "poll" });
      return 0;
    }
    let started = 0;
    while (true) {
      if (!this.canAdmit()) {
        this.notifyNextQueued();
        break;
      }
      let job: StoredJob | null;
      try {
        job = this.store.leaseNextJob(
          this.leaseOwner,
          this.clock(),
          this.leaseMs,
          this.activeLeaseExclusions(),
        );
      } catch (error) {
        this.reportError(error, { phase: "poll" });
        break;
      }
      if (!job) break;
      if (
        this.active.has(job.id)
        || [...this.active.values()].some(
          ({ job: activeJob }) => activeJob.conversationKey === job!.conversationKey,
        )
      ) {
        this.reportError(
          new Error("Store leased work already present in the active dispatcher map"),
          { phase: "poll", jobId: job.id },
        );
        break;
      }
      this.queuedStatusSent.delete(job.id);

      const controller = new AbortController();
      const execution: ActiveExecution = {
        job,
        controller,
        promise: Promise.resolve(),
      };
      this.active.set(job.id, execution);
      execution.promise = this.execute(job, controller)
        .catch((error) => this.reportError(error, { phase: "execute", jobId: job.id }))
        .finally(() => {
          if (this.active.get(job.id) === execution) this.active.delete(job.id);
        });
      started++;
    }
    return started;
  }

  async run(signal: AbortSignal, maxIterations = Number.POSITIVE_INFINITY): Promise<void> {
    const stop = () => void this.shutdown();
    signal.addEventListener("abort", stop, { once: true });
    try {
      for (let iteration = 0; iteration < maxIterations && !signal.aborted; iteration++) {
        this.poll();
        try {
          await this.sleep(this.pollIntervalMs, signal);
        } catch {
          if (!signal.aborted) throw new Error("dispatcher polling sleep failed");
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) await this.shutdown();
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map(({ promise }) => promise));
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopping && this.active.size === 0) return;
    this.stopping = true;
    const active = [...this.active.values()];
    for (const execution of active) {
      execution.controller.abort(SHUTDOWN);
    }

    const timeoutController = new AbortController();
    await Promise.race([
      Promise.all(active.map(({ promise }) => promise)),
      this.sleep(this.shutdownTimeoutMs, timeoutController.signal).catch(() => undefined),
    ]);
    timeoutController.abort(SHUTDOWN);
  }

  private async execute(job: StoredJob, controller: AbortController): Promise<void> {
    const maintenanceController = new AbortController();
    const maintenance = this.maintainLease(job, controller, maintenanceController.signal);
    const timeoutController = new AbortController();
    let workerPromise: Promise<WorkerResult> | null = null;
    try {
      let conversation: StoredConversation | null;
      try {
        conversation = this.store.getConversation(job.conversationKey);
      } catch (error) {
        this.reportError(error, { phase: "execute", jobId: job.id });
        this.releaseUnstarted(job, error);
        return;
      }

      let request: WorkerRequest;
      try {
        if (!conversation || conversation.generation !== job.generation) {
          throw new Error("leased conversation state is unavailable");
        }
        const workspacePath = this.prepareWorkspace(job.conversationKey);
        request = { job, conversation, workspacePath, signal: controller.signal };
      } catch (error) {
        this.reportError(error, { phase: "execute", jobId: job.id });
        this.failUnstarted(job, error);
        return;
      }

      void this.sendTyping(request.conversation.chatId, controller.signal);
      workerPromise = Promise.resolve()
        .then(() => this.worker.run(request))
        .catch((error): WorkerResult => ({
          ok: false,
          error: {
            kind: "process",
            retryable: false,
            message: errorMessage(error),
            stderr: "",
            exitCode: null,
            diagnostics: [],
            progress: [],
          },
        }));
      const timeout = this.sleep(this.workerTimeoutMs, timeoutController.signal)
        .then(() => WORKER_TIMEOUT)
        .catch((error) =>
          timeoutController.signal.aborted
            ? TIMER_CANCELLED
            : schedulerFailure(error));
      const aborted = new Promise<
        typeof LOST_FENCE | typeof SHUTDOWN | typeof STORE_FAILURE | SchedulerFailure
      >((resolveAbort) => {
        const resolveReason = () => {
          const reason = controller.signal.reason;
          resolveAbort(
            reason === LOST_FENCE
              ? LOST_FENCE
              : reason === STORE_FAILURE
                ? STORE_FAILURE
                : isSchedulerFailure(reason)
                  ? reason
                  : SHUTDOWN,
          );
        };
        if (controller.signal.aborted) resolveReason();
        else controller.signal.addEventListener("abort", resolveReason, { once: true });
      });
      const outcome = await Promise.race([workerPromise, timeout, aborted]);

      let result: WorkerResult;
      if (outcome === WORKER_TIMEOUT) {
        void this.sendStatus("timeout", this.scope(job, request.conversation.chatId));
        controller.abort(WORKER_TIMEOUT);
        await workerPromise;
        result = {
          ok: false,
          error: {
            kind: "timeout",
            retryable: true,
            message: `Worker timed out after ${this.workerTimeoutMs}ms`,
            stderr: "",
            exitCode: null,
            diagnostics: [],
            progress: [],
          },
        };
      } else if (isSchedulerFailure(outcome)) {
        if (!outcome.reported) {
          this.reportError(outcome.error, { phase: "execute", jobId: job.id });
        }
        controller.abort(outcome);
        await workerPromise;
        result = {
          ok: false,
          error: {
            kind: "process",
            retryable: true,
            message: errorMessage(outcome.error),
            stderr: "",
            exitCode: null,
            diagnostics: [],
            progress: [],
          },
        };
      } else if (outcome === TIMER_CANCELLED) {
        return;
      } else if (
        outcome === LOST_FENCE || outcome === SHUTDOWN || outcome === STORE_FAILURE
      ) {
        await workerPromise;
        if (outcome === SHUTDOWN) {
          this.store.releaseJob(
            job.id,
            this.leaseOwner,
            job.leaseToken!,
            "dispatcher_shutdown",
            this.clock(),
          );
        }
        return;
      } else {
        result = outcome;
      }

      maintenanceController.abort();
      await maintenance;
      const now = this.clock();
      if (result.ok) {
        this.store.completeJobWithReply(
          job.id,
          this.leaseOwner,
          job.leaseToken!,
          result.text,
          result.sessionId,
          result.effectiveRole,
          result.text,
          now,
        );
        return;
      }

      if (result.error.retryable && job.attempts < this.maxAttempts) {
        const retryInMs = Math.min(
          this.maxBackoffMs,
          this.initialBackoffMs * 2 ** Math.min(Math.max(job.attempts - 1, 0), 30),
        );
        const queued = this.store.retryJob(
          job.id,
          this.leaseOwner,
          job.leaseToken!,
          result.error.message,
          now + retryInMs,
          now,
        );
        if (queued) {
          void this.sendStatus(
            "queued",
            this.scope(job, request.conversation.chatId),
          );
        }
        return;
      }

      this.store.failJobWithReply(
        job.id,
        this.leaseOwner,
        job.leaseToken!,
        result.error.message,
        this.errorReplyText,
        now,
      );
    } catch (error) {
      if (workerPromise) {
        if (!controller.signal.aborted) controller.abort(STORE_FAILURE);
        await workerPromise;
      }
      this.reportError(error, { phase: "execute", jobId: job.id });
    } finally {
      timeoutController.abort();
      maintenanceController.abort();
      await maintenance;
    }
  }

  private async maintainLease(
    job: StoredJob,
    workerController: AbortController,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.sleep(this.renewalIntervalMs, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.reportError(error, { phase: "renewal", jobId: job.id });
          workerController.abort(schedulerFailure(error, true));
        }
        return;
      }
      if (signal.aborted) return;
      let renewed: boolean;
      try {
        renewed = this.store.renewLease(
          job.id,
          this.leaseOwner,
          job.leaseToken!,
          this.clock(),
          this.leaseMs,
        );
      } catch (error) {
        this.reportError(error, { phase: "renewal", jobId: job.id });
        workerController.abort(STORE_FAILURE);
        return;
      }
      if (!renewed) {
        workerController.abort(LOST_FENCE);
        return;
      }
      try {
        const conversation = this.store.getConversation(job.conversationKey);
        if (conversation) void this.sendTyping(conversation.chatId, workerController.signal);
      } catch (error) {
        this.reportError(error, { phase: "renewal", jobId: job.id });
        workerController.abort(STORE_FAILURE);
        return;
      }
    }
  }

  private async sendTyping(chatId: number, signal: AbortSignal): Promise<void> {
    if (!this.typing || signal.aborted) return;
    try {
      await this.typing(chatId, signal);
    } catch {}
  }

  private canAdmit(): boolean {
    if (this.active.size >= this.maxWorkers) return false;
    if (!this.admissionGuard) return true;
    try {
      return this.admissionGuard({
        activeWorkers: this.active.size,
        maxWorkers: this.maxWorkers,
      });
    } catch (error) {
      this.reportError(error, { phase: "poll" });
      return false;
    }
  }

  private activeLeaseExclusions(): ActiveLeaseDescriptor[] {
    return [...this.active.values()].map(({ job }) => ({
      jobId: job.id,
      conversationKey: job.conversationKey,
    }));
  }

  private releaseUnstarted(job: StoredJob, error: unknown): void {
    try {
      const released = this.store.releaseUnstartedJob(
        job.id,
        this.leaseOwner,
        job.leaseToken!,
        errorMessage(error),
        this.clock(),
      );
      if (!released) {
        this.reportError(
          new Error("unstarted job release lost its lease fence"),
          { phase: "execute", jobId: job.id },
        );
      }
    } catch (releaseError) {
      this.reportError(releaseError, { phase: "execute", jobId: job.id });
    }
  }

  private failUnstarted(job: StoredJob, error: unknown): void {
    try {
      const failed = this.store.failJobWithReply(
        job.id,
        this.leaseOwner,
        job.leaseToken!,
        errorMessage(error),
        this.errorReplyText,
        this.clock(),
      );
      if (!failed) {
        this.reportError(
          new Error("unstarted job failure lost its lease fence"),
          { phase: "execute", jobId: job.id },
        );
      }
    } catch (failureError) {
      this.reportError(failureError, { phase: "execute", jobId: job.id });
    }
  }

  private notifyNextQueued(): void {
    try {
      const job = this.store.listJobs().find(({ status }) => status === "queued");
      if (!job || this.queuedStatusSent.has(job.id)) return;
      const conversation = this.store.getConversation(job.conversationKey);
      if (!conversation) return;
      this.queuedStatusSent.add(job.id);
      void this.sendStatus("queued", this.scope(job, conversation.chatId));
    } catch (error) {
      this.reportError(error, { phase: "poll" });
    }
  }

  private scope(job: StoredJob, chatId: number): DispatcherStatusScope {
    return {
      jobId: job.id,
      updateId: job.updateId,
      conversationKey: job.conversationKey,
      chatId,
    };
  }

  private async sendStatus(
    state: "queued" | "timeout",
    scope: DispatcherStatusScope,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.status) return;
    try {
      await this.status(state, scope, signal);
    } catch {}
  }

  private reportError(error: unknown, context: DispatcherErrorContext): void {
    if (!this.onError) return;
    try {
      void Promise.resolve(this.onError(error, context)).catch(() => undefined);
    } catch {}
  }

  private prepareWorkspace(conversationKey: string): string {
    const base = this.workspacesBase;
    const workspacePath = join(base, encodeConversationKey(conversationKey));
    try {
      const workspaceStat = lstatSync(workspacePath);
      if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
        throw new Error("conversation workspace must be a real directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(workspacePath, { mode: 0o700 });
    }
    const workspace = realpathSync(workspacePath);
    if (!isContained(base, workspace)) {
      throw new Error("conversation workspace escapes workspaces base");
    }
    return workspace;
  }
}
