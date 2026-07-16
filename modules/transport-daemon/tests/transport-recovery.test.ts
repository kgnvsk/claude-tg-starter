import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const telegramServer = join(root, "assets/telegram-server-fixed.ts");
const artifactResolver = join(root, "assets/bin/codex-image-result");
const healthcheck = join(root, "assets/bin/cash-healthcheck");

describe("daemon transport recovery contract", () => {
  test("retains an inbox update when delivery to Claude fails", () => {
    const source = readFileSync(telegramServer, "utf8");

    expect(source).toContain("class RetryableInboundDeliveryError extends Error");
    expect(source).toContain("throw new RetryableInboundDeliveryError(err)");
    expect(source).toContain("if (err.error instanceof RetryableInboundDeliveryError) throw err.error");
    expect(source).toContain("if (e instanceof RetryableInboundDeliveryError)");
    expect(source).toContain("break // keep the update on disk");
  });

  test("restarts the Claude drain when a durable update remains queued", () => {
    const source = readFileSync(healthcheck, "utf8");

    expect(source).toContain("DAEMON_INBOX=/home/claude/.claude/channels/telegram/daemon-inbox");
    expect(source).toContain("-mmin +2");
    expect(source).toContain("daemon inbox stalled");
    expect(source).toContain("sudo systemctl restart claude-telegram.service");
  });
});

describe("codex image artifact recovery", () => {
  test("copies the structured saved_path for the exact Codex session", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-image-result-"));
    const sessionId = "019f60aa-2463-7303-8abc-81b913b329ef";
    const generatedDir = join(home, ".codex/generated_images", sessionId);
    const rolloutDir = join(home, ".codex/sessions/2026/07/14");
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(rolloutDir, { recursive: true });

    const generated = join(generatedDir, "ig_expected.png");
    const unrelated = join(home, ".codex/generated_images/other/ig_wrong.png");
    mkdirSync(join(home, ".codex/generated_images/other"), { recursive: true });
    writeFileSync(generated, "expected-image");
    writeFileSync(unrelated, "wrong-image");
    writeFileSync(
      join(rolloutDir, `rollout-test-${sessionId}.jsonl`),
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "image_generation_end",
          saved_path: generated,
          result: "401 random encrypted-looking payload",
        },
      }) + "\n",
    );

    const log = join(home, "codex.log");
    const output = join(home, "deliver/final.png");
    writeFileSync(log, `session id: ${sessionId}\nGenerated the image\n`);

    const proc = Bun.spawn([artifactResolver, "--log", log, "--output", output], {
      env: { ...Bun.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(output);
    expect(readFileSync(output, "utf8")).toBe("expected-image");
    expect(readFileSync(generated, "utf8")).toBe("expected-image");
  });

  test("fails closed when no structured image artifact exists", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-image-result-missing-"));
    const log = join(home, "codex.log");
    const output = join(home, "deliver/final.png");
    writeFileSync(log, "session id: 019f60aa-2463-7303-8abc-81b913b329ef\n");

    const proc = Bun.spawn([artifactResolver, "--log", log, "--output", output], {
      env: { ...Bun.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no generated image artifact found");
  });
});
