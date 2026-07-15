import { isAbsolute, join } from "node:path";

import { loadConfig } from "./config";

type Environment = Record<string, string | undefined>;

interface CommonRuntimeConfig {
  adminChatIds: ReadonlySet<number>;
  guestAccessMode: "public" | "invite";
  telegramToken: string;
  stateDir: string;
  workspacesDir: string;
  databasePath: string;
}

export interface ReceiverRuntimeConfig extends CommonRuntimeConfig {
  longPollSeconds: number;
  retryInitialMs: number;
  retryMaxMs: number;
  outboxLeaseMs: number;
  outboxSendTimeoutMs: number;
  outboxMaxAttempts: number;
  outboxRetryInitialMs: number;
  outboxRetryMaxMs: number;
  doctorExecutable: string;
  systemctlExecutable: string;
}

export interface DispatcherRuntimeConfig extends CommonRuntimeConfig {
  ownerCwd: string;
  guestSystemPromptPath: string;
  claudeExecutable: string;
  maxWorkers: number;
  workerTimeoutMs: number;
  leaseMs: number;
  renewalIntervalMs: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryInitialMs: number;
  retryMaxMs: number;
  shutdownTimeoutMs: number;
  guestRetentionDays: number;
  retentionCleanupIntervalMs: number;
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absolutePath(env: Environment, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function positiveInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function boundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = positiveInteger(env, name, fallback);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function loadCommon(env: Environment): CommonRuntimeConfig {
  if (!env.ADMIN_CHAT_IDS?.trim()) throw new Error("ADMIN_CHAT_IDS is required");
  const policy = loadConfig(env);
  if (policy.adminChatIds.size === 0) throw new Error("ADMIN_CHAT_IDS is required");
  const stateDir = absolutePath(env, "STATE_DIR", "/home/claude/multi-user/state");
  const workspacesDir = absolutePath(env, "WORKSPACES_DIR", join(stateDir, "workspaces"));
  return {
    ...policy,
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    stateDir,
    workspacesDir,
    databasePath: absolutePath(env, "DATABASE_PATH", join(stateDir, "router.sqlite")),
  };
}

export function loadReceiverRuntimeConfig(
  env: Environment = Bun.env,
): ReceiverRuntimeConfig {
  return {
    ...loadCommon(env),
    longPollSeconds: nonNegativeInteger(env, "TELEGRAM_LONG_POLL_SECONDS", 50),
    retryInitialMs: positiveInteger(env, "RECEIVER_RETRY_INITIAL_MS", 1_000),
    retryMaxMs: positiveInteger(env, "RECEIVER_RETRY_MAX_MS", 30_000),
    outboxLeaseMs: positiveInteger(env, "OUTBOX_LEASE_MS", 30_000),
    outboxSendTimeoutMs: positiveInteger(env, "OUTBOX_SEND_TIMEOUT_MS", 10_000),
    outboxMaxAttempts: positiveInteger(env, "OUTBOX_MAX_ATTEMPTS", 5),
    outboxRetryInitialMs: positiveInteger(env, "OUTBOX_RETRY_INITIAL_MS", 1_000),
    outboxRetryMaxMs: positiveInteger(env, "OUTBOX_RETRY_MAX_MS", 60_000),
    doctorExecutable: absolutePath(env, "DOCTOR_EXECUTABLE", "/home/claude/bin/cash-doctor"),
    systemctlExecutable: absolutePath(env, "SYSTEMCTL_EXECUTABLE", "/usr/bin/systemctl"),
  };
}

export function loadDispatcherRuntimeConfig(
  env: Environment = Bun.env,
): DispatcherRuntimeConfig {
  return {
    ...loadCommon(env),
    ownerCwd: absolutePath(env, "OWNER_CWD", "/home/claude"),
    guestSystemPromptPath: absolutePath(
      env,
      "GUEST_SYSTEM_PROMPT_PATH",
      "/home/claude/multi-user/guest-system-prompt.md",
    ),
    claudeExecutable: absolutePath(
      env,
      "CLAUDE_EXECUTABLE",
      "/home/claude/.local/bin/claude",
    ),
    maxWorkers: positiveInteger(env, "MAX_WORKERS", 4),
    workerTimeoutMs: positiveInteger(env, "WORKER_TIMEOUT_MS", 300_000),
    leaseMs: positiveInteger(env, "JOB_LEASE_MS", 60_000),
    renewalIntervalMs: positiveInteger(env, "JOB_RENEWAL_INTERVAL_MS", 20_000),
    pollIntervalMs: positiveInteger(env, "DISPATCH_POLL_INTERVAL_MS", 250),
    maxAttempts: positiveInteger(env, "MAX_ATTEMPTS", 3),
    retryInitialMs: positiveInteger(env, "RETRY_INITIAL_MS", 1_000),
    retryMaxMs: positiveInteger(env, "RETRY_MAX_MS", 60_000),
    shutdownTimeoutMs: positiveInteger(env, "SHUTDOWN_TIMEOUT_MS", 10_000),
    guestRetentionDays: positiveInteger(env, "GUEST_RETENTION_DAYS", 7),
    retentionCleanupIntervalMs: boundedInteger(
      env,
      "RETENTION_CLEANUP_INTERVAL_MS",
      6 * 60 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
  };
}
