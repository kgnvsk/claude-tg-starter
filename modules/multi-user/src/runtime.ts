import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import type { EmergencyControls } from "./admin";
import type { ExpiredGuestSession, Store } from "./store";
import { encodeConversationKey } from "./types";

const MAX_EMERGENCY_OUTPUT_BYTES = 16 * 1024;
const GUEST_CLEANUP_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_GUEST_CLEANUPS_PER_RUN = 100;

interface RetentionFilesystem {
  renameWorkspace?: (source: string, quarantine: string) => void;
  removeQuarantine?: (path: string) => void;
}

export function prepareRuntimeDirectories(stateDir: string, workspacesDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(workspacesDir, { recursive: true, mode: 0o700 });
}

export function installShutdownHandlers(controller: AbortController): () => void {
  const stop = () => controller.abort(new Error("shutdown requested"));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  return () => {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  };
}

export function runGuestRetentionCleanup(
  store: Store,
  workspacesDir: string,
  retentionDays: number,
  now = Date.now(),
  filesystem: RetentionFilesystem = {},
): ExpiredGuestSession[] {
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw new Error("guest retention days must be a positive integer");
  }
  const retentionMs = retentionDays * 24 * 60 * 60 * 1_000;
  if (!Number.isSafeInteger(retentionMs) || retentionMs > now) return [];
  const renameWorkspace = filesystem.renameWorkspace ?? renameSync;
  const removeQuarantine = filesystem.removeQuarantine ?? ((path: string) => rmSync(path, {
    recursive: true, force: true,
  }));
  const root = resolve(workspacesDir);
  const trashRoot = resolve(root, ".retention-trash");
  if (trashRoot !== join(root, ".retention-trash")) throw new Error("invalid retention trash path");
  mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
  const trashStat = lstatSync(trashRoot);
  if (!trashStat.isDirectory() || trashStat.isSymbolicLink()) {
    throw new Error("retention trash must be a real directory");
  }
  const expired: ExpiredGuestSession[] = [];
  const processClaim = (claim: ReturnType<Store["claimInactiveGuestSession"]>): void => {
    if (!claim) return;
    if (!/^[0-9a-f-]{36}$/.test(claim.token)) return;
    const source = resolve(root, encodeConversationKey(claim.conversationKey));
    const quarantine = resolve(trashRoot, claim.token);
    if (!source.startsWith(`${root}/`) || !quarantine.startsWith(`${trashRoot}/`)) return;
    try {
      if (existsSync(source)) {
        if (lstatSync(source).isSymbolicLink() || existsSync(quarantine)) return;
        renameWorkspace(source, quarantine);
      } else if (!existsSync(quarantine)) {
        return;
      }
    } catch {
      return;
    }
    if (store.completeGuestSessionCleanup(claim.conversationKey, claim.token, now)) {
      expired.push({ conversationKey: claim.conversationKey, sessionId: claim.sessionId });
    }
  };

  const pending = store.listPendingGuestSessionCleanups(MAX_GUEST_CLEANUPS_PER_RUN);
  for (const claim of pending) processClaim(claim);
  for (let count = pending.length; count < MAX_GUEST_CLEANUPS_PER_RUN; count += 1) {
    const claim = store.claimInactiveGuestSession(
      now - retentionMs,
      now,
      GUEST_CLEANUP_CLAIM_TIMEOUT_MS,
    );
    if (!claim) break;
    processClaim(claim);
  }

  for (const entry of readdirSync(trashRoot).slice(0, MAX_GUEST_CLEANUPS_PER_RUN)) {
    if (!/^[0-9a-f-]{36}$/.test(entry)) continue;
    if (store.isGuestSessionCleanupPending(entry)) continue;
    try {
      removeQuarantine(join(trashRoot, entry));
    } catch {
      // Quarantine deletion is retried later and never blocks the conversation.
    }
  }
  return expired;
}

function boundedOutput(output: Uint8Array): string {
  const bounded = output.byteLength > MAX_EMERGENCY_OUTPUT_BYTES
    ? output.slice(0, MAX_EMERGENCY_OUTPUT_BYTES)
    : output;
  const text = new TextDecoder().decode(bounded).trim();
  return output.byteLength > bounded.byteLength ? `${text}\n[output truncated]` : text;
}

export function createEmergencyControls(
  doctorExecutable: string,
  systemctlExecutable: string,
): EmergencyControls {
  return {
    doctor: () => {
      try {
        const result = Bun.spawnSync([doctorExecutable], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        });
        const message = boundedOutput(result.stdout.length > 0 ? result.stdout : result.stderr);
        return {
          ok: result.exitCode === 0,
          message: message || `cash-doctor exited with status ${result.exitCode}`,
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
    restart: () => {
      try {
        const result = Bun.spawnSync([
          systemctlExecutable,
          "--user",
          "restart",
          "claude-multi-user-dispatcher.service",
        ], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 30_000 });
        return result.exitCode === 0
          ? { ok: true, message: "Dispatcher restart requested." }
          : {
              ok: false,
              message: boundedOutput(result.stderr) || "Dispatcher restart request failed.",
            };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
