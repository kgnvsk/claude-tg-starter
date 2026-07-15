import { Receiver } from "./receiver";
import { createEmergencyControls, installShutdownHandlers, prepareRuntimeDirectories } from "./runtime";
import { loadReceiverRuntimeConfig } from "./runtime-config";
import { Store } from "./store";
import { TelegramClient } from "./telegram";

export async function main(env: Record<string, string | undefined> = Bun.env): Promise<void> {
  const config = loadReceiverRuntimeConfig(env);
  prepareRuntimeDirectories(config.stateDir, config.workspacesDir);
  const store = new Store(config.databasePath, { adminChatIds: config.adminChatIds });
  const telegram = new TelegramClient(config.telegramToken);
  const receiver = new Receiver({
    telegram,
    store,
    config,
    baseDirectory: config.workspacesDir,
    longPollSeconds: config.longPollSeconds,
    backoff: { initialMs: config.retryInitialMs, maxMs: config.retryMaxMs },
    outbound: {
      leaseOwner: `receiver-${process.pid}`,
      leaseMs: config.outboxLeaseMs,
      sendTimeoutMs: config.outboxSendTimeoutMs,
      maxAttempts: config.outboxMaxAttempts,
      initialBackoffMs: config.outboxRetryInitialMs,
      maxBackoffMs: config.outboxRetryMaxMs,
    },
    emergency: createEmergencyControls(config.doctorExecutable, config.systemctlExecutable),
    onPollError: (error, conflict, retryInMs) => {
      console.error("receiver poll failed", { conflict, retryInMs, error });
    },
  });
  const controller = new AbortController();
  const removeHandlers = installShutdownHandlers(controller);
  try {
    await receiver.run(controller.signal);
  } finally {
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
