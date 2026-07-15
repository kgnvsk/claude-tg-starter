import { Dispatcher } from "./dispatcher";
import {
  installShutdownHandlers,
  prepareRuntimeDirectories,
  runGuestRetentionCleanup,
} from "./runtime";
import { loadDispatcherRuntimeConfig } from "./runtime-config";
import { Store } from "./store";
import { TelegramClient } from "./telegram";
import { ClaudeWorker } from "./worker";

export async function main(env: Record<string, string | undefined> = Bun.env): Promise<void> {
  const config = loadDispatcherRuntimeConfig(env);
  prepareRuntimeDirectories(config.stateDir, config.workspacesDir);
  const store = new Store(config.databasePath, { adminChatIds: config.adminChatIds });
  const telegram = new TelegramClient(config.telegramToken);
  const worker = new ClaudeWorker({
    claudeExecutable: config.claudeExecutable,
    ownerVault: config.ownerCwd,
    workspacesBase: config.workspacesDir,
    guestSystemPromptPath: config.guestSystemPromptPath,
    timeoutMs: config.workerTimeoutMs,
  });
  const dispatcher = new Dispatcher({
    store,
    worker,
    workspacesBase: config.workspacesDir,
    maxWorkers: config.maxWorkers,
    workerTimeoutMs: config.workerTimeoutMs,
    leaseMs: config.leaseMs,
    renewalIntervalMs: config.renewalIntervalMs,
    pollIntervalMs: config.pollIntervalMs,
    maxAttempts: config.maxAttempts,
    initialBackoffMs: config.retryInitialMs,
    maxBackoffMs: config.retryMaxMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    leaseOwner: `dispatcher-${process.pid}`,
    typing: (chatId) => telegram.sendTyping(chatId),
    onError: (error, context) => console.error("dispatcher failure", context, error),
  });
  const controller = new AbortController();
  const removeHandlers = installShutdownHandlers(controller);
  const cleanup = () => {
    try {
      runGuestRetentionCleanup(
        store,
        config.workspacesDir,
        config.guestRetentionDays,
      );
    } catch (error) {
      console.error("guest retention cleanup failed", error);
    }
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, config.retentionCleanupIntervalMs);
  try {
    await dispatcher.run(controller.signal);
  } finally {
    clearInterval(cleanupTimer);
    removeHandlers();
    store.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
