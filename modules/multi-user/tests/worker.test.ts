import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeWorker,
  ClaudeStreamParser,
  WorkerInputError,
  buildClaudeInvocation,
  parseClaudeStream,
  type ClaudeWorkerOptions,
  type WorkerRequest,
} from "../src/worker";
import type {
  NormalizedUpdate,
  Role,
  StoredConversation,
  StoredJob,
} from "../src/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-worker-"));
  temporaryDirectories.push(directory);
  return directory;
}

function update(text = "hello", localPath?: string): NormalizedUpdate {
  return {
    updateId: 10,
    message: {
      messageId: 20,
      date: 1_752_528_000,
      text,
      sender: { id: 22, username: "guest" },
      chat: { id: 22, type: "private" },
      attachments: localPath
        ? [{
            kind: "document",
            fileId: "file-1",
            fileName: "notes.txt",
            mimeType: "text/plain",
            fileSize: 12,
            localPath,
          }]
        : undefined,
    },
  };
}

function request(
  role: Role,
  workspacePath: string,
  sessionId: string | null = null,
  payload = update(),
  sessionRole: Role | null = null,
): WorkerRequest {
  const conversationKey = payload.message.chat.type === "private"
    ? `dm:${payload.message.chat.id}`
    : `group:${payload.message.chat.id}`;
  const conversation: StoredConversation = {
    key: conversationKey,
    chatId: payload.message.chat.id,
    sessionId,
    sessionRole,
    generation: 0,
    state: "active",
    nextSequence: 2,
    leaseOwner: "dispatcher",
    leaseUntil: Date.now() + 60_000,
    lastActivityAt: Date.now(),
  };
  const job: StoredJob = {
    id: 1,
    updateId: payload.updateId,
    conversationKey: conversation.key,
    generation: conversation.generation,
    sequence: 1,
    status: "running",
    role,
    payload,
    attempts: 1,
    leaseOwner: "dispatcher",
    leaseToken: "lease",
    leaseUntil: Date.now() + 60_000,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { job, conversation, workspacePath };
}

function fixture(): {
  root: string;
  ownerVault: string;
  workspacesBase: string;
  guestWorkspace: string;
  guestPromptPath: string;
} {
  const root = temporaryDirectory();
  const ownerVault = join(root, "owner-vault");
  const workspacesBase = join(root, "workspaces");
  const guestWorkspace = join(workspacesBase, "dm%3A22");
  mkdirSync(ownerVault);
  mkdirSync(guestWorkspace, { recursive: true });
  const guestPromptPath = join(root, "guest-prompt.md");
  writeFileSync(guestPromptPath, "Guest public-only system prompt.\n");
  return { root, ownerVault, workspacesBase, guestWorkspace, guestPromptPath };
}

function workerOptions(
  paths: ReturnType<typeof fixture>,
  extra: Partial<ClaudeWorkerOptions> = {},
): ClaudeWorkerOptions {
  return {
    claudeExecutable: "claude",
    ownerVault: paths.ownerVault,
    workspacesBase: paths.workspacesBase,
    guestSystemPromptPath: paths.guestPromptPath,
    timeoutMs: 2_000,
    env: { PATH: process.env.PATH ?? "" },
    ...extra,
  };
}

function valueAfter(argv: readonly string[], flag: string): string {
  const index = argv.indexOf(flag);
  expect(index).toBeGreaterThanOrEqual(0);
  return argv[index + 1]!;
}

describe("buildClaudeInvocation", () => {
  test("creates a UUID session and preserves normal admin configuration while denying Telegram transport tools", async () => {
    const paths = fixture();
    const invocation = await buildClaudeInvocation(
      workerOptions(paths),
      request("admin", paths.ownerVault),
    );

    expect(invocation.cwd).toBe(realpathSync(paths.ownerVault));
    expect(invocation.argv.slice(0, 6)).toEqual([
      "claude",
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
    ]);
    expect(valueAfter(invocation.argv, "--session-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(invocation.argv).not.toContain("--safe-mode");
    expect(invocation.argv).not.toContain("--strict-mcp-config");
    expect(valueAfter(invocation.argv, "--disallowedTools")).toBe(
      "mcp__plugin_telegram_telegram__*",
    );
  });

  test("resumes the stored session without generating another session ID", async () => {
    const paths = fixture();
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const invocation = await buildClaudeInvocation(
      workerOptions(paths),
      request("admin", paths.ownerVault, sessionId, update(), "admin"),
    );

    expect(valueAfter(invocation.argv, "--resume")).toBe(sessionId);
    expect(invocation.argv).not.toContain("--session-id");
  });

  test("forces forged admin group jobs through guest policy and rotates an admin session", async () => {
    const paths = fixture();
    const groupWorkspace = join(paths.workspacesBase, "group%3A-100");
    mkdirSync(groupWorkspace);
    const groupUpdate = update("group message");
    groupUpdate.message.chat = { id: -100, type: "group", title: "Mixed group" };
    const invocation = await buildClaudeInvocation(
      workerOptions(paths),
      request(
        "admin",
        groupWorkspace,
        "123e4567-e89b-42d3-a456-426614174000",
        groupUpdate,
        "admin",
      ),
    );

    expect(invocation.effectiveRole).toBe("guest");
    expect(invocation.cwd).toBe(realpathSync(groupWorkspace));
    expect(invocation.argv).toContain("--safe-mode");
    expect(invocation.argv).not.toContain("--resume");
    expect(invocation.argv).toContain("--session-id");

    const guestResume = await buildClaudeInvocation(
      workerOptions(paths),
      request(
        "guest",
        groupWorkspace,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        groupUpdate,
        "guest",
      ),
    );
    expect(guestResume.effectiveRole).toBe("guest");
    expect(valueAfter(guestResume.argv, "--resume")).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  test("resumes only when the stored session role matches the effective policy", async () => {
    const paths = fixture();
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const matching = await buildClaudeInvocation(
      workerOptions(paths),
      request("guest", paths.guestWorkspace, sessionId, update(), "guest"),
    );
    const unknown = await buildClaudeInvocation(
      workerOptions(paths),
      request("guest", paths.guestWorkspace, sessionId, update(), null),
    );

    expect(valueAfter(matching.argv, "--resume")).toBe(sessionId);
    expect(unknown.argv).not.toContain("--resume");
    expect(valueAfter(unknown.argv, "--session-id")).not.toBe(sessionId);
  });

  test("locks guests to safe built-in tools and an empty MCP configuration", async () => {
    const paths = fixture();
    const invocation = await buildClaudeInvocation(
      workerOptions(paths),
      request("guest", paths.guestWorkspace),
    );

    const resolvedWorkspace = realpathSync(paths.guestWorkspace);
    expect(invocation.cwd).toBe(resolvedWorkspace);
    expect(invocation.argv).toEqual(expect.arrayContaining([
      "--safe-mode",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,WebSearch,WebFetch",
      "--allowedTools",
      `Read(/${resolvedWorkspace}/**)`,
      "--system-prompt",
      "Guest public-only system prompt.\n",
    ]));
    expect(invocation.argv).not.toEqual(expect.arrayContaining([
      "Bash",
      "Edit",
      "Write",
      "--plugin-dir",
    ]));
  });

  test("local Claude help exposes every isolation flag used by guest argv", async () => {
    const executable = Bun.which("claude");
    if (executable === null) return;
    const subprocess = Bun.spawn([executable, "--help"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
    ]);

    expect(exitCode).toBe(0);
    for (const flag of [
      "--allowedTools",
      "--permission-mode",
      "--safe-mode",
      "--strict-mcp-config",
    ]) {
      expect(stdout).toContain(flag);
    }
  });

  test("builds a data-only prompt with normalized text and validated attachment metadata", async () => {
    const paths = fixture();
    const attachment = join(paths.guestWorkspace, "notes.txt");
    writeFileSync(attachment, "fixture");
    const invocation = await buildClaudeInvocation(
      workerOptions(paths),
      request("guest", paths.guestWorkspace, null, update("$(touch /tmp/no)", attachment)),
    );
    const prompt = invocation.argv.at(-1)!;

    expect(prompt).toContain('"text": "$(touch /tmp/no)"');
    expect(prompt).toContain(`"localPath": "${realpathSync(attachment)}"`);
    expect(prompt).toContain('"mimeType": "text/plain"');
    expect(prompt).toContain("Return the final response only through stdout");
    expect(prompt).toContain("Never target, reply to, or edit a Telegram chat directly");
    expect(invocation.argv).toHaveLength(invocation.argv.indexOf(prompt) + 1);
  });

  test("rejects guest workspace and attachment symlink escapes", async () => {
    const paths = fixture();
    const outside = join(paths.root, "outside");
    mkdirSync(outside);
    const escapedWorkspace = join(paths.workspacesBase, "escaped");
    symlinkSync(outside, escapedWorkspace);

    await expect(
      buildClaudeInvocation(workerOptions(paths), request("guest", escapedWorkspace)),
    ).rejects.toBeInstanceOf(WorkerInputError);

    const outsideFile = join(outside, "secret.txt");
    writeFileSync(outsideFile, "secret");
    const linkedFile = join(paths.guestWorkspace, "linked.txt");
    symlinkSync(outsideFile, linkedFile);
    await expect(
      buildClaudeInvocation(
        workerOptions(paths),
        request("guest", paths.guestWorkspace, null, update("read", linkedFile)),
      ),
    ).rejects.toThrow("attachment path escapes");
  });

  test("rejects a safe sibling workspace that does not match the conversation key", async () => {
    const paths = fixture();
    const sibling = join(paths.workspacesBase, "dm%3A99");
    mkdirSync(sibling);

    await expect(
      buildClaudeInvocation(workerOptions(paths), request("guest", sibling)),
    ).rejects.toThrow("does not match conversation");
  });

  test("sanitizes the default inherited environment by effective role", async () => {
    const paths = fixture();
    const original = {
      TELEGRAM_BOT_TOKEN: Bun.env.TELEGRAM_BOT_TOKEN,
      OPENAI_API_KEY: Bun.env.OPENAI_API_KEY,
      CALENDAR_OAUTH_TOKEN: Bun.env.CALENDAR_OAUTH_TOKEN,
      EMAIL_INTEGRATION_SECRET: Bun.env.EMAIL_INTEGRATION_SECRET,
      CLAUDE_CODE_OAUTH_TOKEN: Bun.env.CLAUDE_CODE_OAUTH_TOKEN,
    };
    Object.assign(Bun.env, {
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      OPENAI_API_KEY: "openai-secret",
      CALENDAR_OAUTH_TOKEN: "calendar-secret",
      EMAIL_INTEGRATION_SECRET: "email-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    });
    try {
      const options = workerOptions(paths);
      delete options.env;
      const guest = await buildClaudeInvocation(
        options,
        request("guest", paths.guestWorkspace),
      );
      const admin = await buildClaudeInvocation(
        options,
        request("admin", paths.ownerVault),
      );

      expect(guest.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-oauth");
      expect(guest.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(guest.env.OPENAI_API_KEY).toBeUndefined();
      expect(guest.env.CALENDAR_OAUTH_TOKEN).toBeUndefined();
      expect(guest.env.EMAIL_INTEGRATION_SECRET).toBeUndefined();
      expect(admin.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete Bun.env[key];
        else Bun.env[key] = value;
      }
    }
  });

  test("sanitizes explicit environments instead of treating them as prefiltered", async () => {
    const paths = fixture();
    const secrets = {
      HOME: paths.root,
      USER: "claude",
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      TELEGRAM_CHANNEL_TOKEN: "channel-secret",
      BOT_TOKEN: "generic-bot-secret",
      OPENAI_API_KEY: "openai-secret",
      CALENDAR_OAUTH_TOKEN: "calendar-secret",
    };
    const guest = await buildClaudeInvocation(
      workerOptions(paths, { env: secrets }),
      request("guest", paths.guestWorkspace),
    );
    const admin = await buildClaudeInvocation(
      workerOptions(paths, { env: secrets }),
      request("admin", paths.ownerVault),
    );

    expect(guest.env).toEqual({
      HOME: paths.root,
      USER: "claude",
      PATH: process.env.PATH ?? "",
      LANG: "C.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth",
    });
    expect(admin.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(admin.env.TELEGRAM_CHANNEL_TOKEN).toBeUndefined();
    expect(admin.env.BOT_TOKEN).toBeUndefined();
    expect(admin.env.OPENAI_API_KEY).toBe("openai-secret");
  });
});

describe("parseClaudeStream progress", () => {
  test("captures assistant and tool progress with bounded entries and text", () => {
    const lines = Array.from({ length: 50 }, (_, index) => JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: `${index}:${"x".repeat(600)}` },
          { type: "tool_use", name: `Read-${index}`, id: `tool-${index}` },
        ],
      },
    }));
    lines.push(JSON.stringify({ type: "result", result: "done" }));

    const parsed = parseClaudeStream(lines.join("\n"));

    expect(parsed.progress.length).toBeLessThanOrEqual(32);
    expect(parsed.progress[0]).toMatchObject({ type: "assistant" });
    expect(parsed.progress[1]).toMatchObject({ type: "tool", name: "Read-0" });
    expect(parsed.progress.every((entry) =>
      entry.type !== "assistant" || entry.text.length <= 256)).toBeTrue();
  });

  test("parses JSONL split across arbitrary chunks without breaking UTF-8", () => {
    const parser = new ClaudeStreamParser({
      lineLimitBytes: 1_024,
      answerLimitBytes: 1_024,
    });
    const bytes = new TextEncoder().encode([
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "héllo" }] },
      }),
      JSON.stringify({ type: "result", result: "final ✓" }),
      "",
    ].join("\n"));
    for (let index = 0; index < bytes.length; index += 3) {
      parser.feed(bytes.subarray(index, index + 3));
    }

    expect(parser.finish()).toMatchObject({
      text: "final ✓",
      overflow: null,
      progress: [{ type: "assistant", text: "héllo" }],
    });
  });

  test("bounds oversized lines and cumulative answer content", () => {
    const hugeLine = new ClaudeStreamParser({
      lineLimitBytes: 64,
      answerLimitBytes: 1_024,
    });
    hugeLine.feed(new TextEncoder().encode(`${"x".repeat(1_000)}\n`));
    expect(hugeLine.finish().overflow).toContain("line exceeds 64 bytes");

    const hugeAnswer = new ClaudeStreamParser({
      lineLimitBytes: 1_024,
      answerLimitBytes: 64,
    });
    for (let index = 0; index < 10; index++) {
      hugeAnswer.feed(new TextEncoder().encode(`${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "answer-part" }] },
      })}\n`));
    }
    expect(hugeAnswer.finish().overflow).toContain("answer exceeds 64 bytes");
  });

  test("treats non-object JSON values as bounded diagnostics", () => {
    const parsed = parseClaudeStream([
      "null",
      "42",
      '"text"',
      "[]",
      ...Array.from({ length: 30 }, () => "null"),
      JSON.stringify({ type: "result", result: "valid" }),
    ].join("\n"));

    expect(parsed.text).toBe("valid");
    expect(parsed.diagnostics).toHaveLength(20);
    expect(parsed.diagnostics.every((diagnostic) =>
      diagnostic.includes("must be an object"))).toBeTrue();
    expect(parsed.diagnostics.every((diagnostic) =>
      new TextEncoder().encode(diagnostic).byteLength <= 512)).toBeTrue();
  });
});

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function fakeClaude(paths: ReturnType<typeof fixture>): string {
  const executable = join(paths.root, "fake-claude.ts");
  writeExecutable(executable, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";

const argv = Bun.argv.slice(2);
const capturePath = process.env.CAPTURE_PATH ?? process.env.CLAUDE_CONFIG_DIR;
if (capturePath) {
  writeFileSync(capturePath, JSON.stringify({ argv, cwd: process.cwd(), env: process.env }));
}
const mode = process.env.FAKE_MODE ?? "success";
if (mode === "success") {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "draft text" }] } }));
  console.log("not json");
  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: " delta" } } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", result: "final answer", session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
} else if (mode === "auth") {
  console.error("Authentication failed: OAuth token expired");
  process.exit(1);
} else if (mode === "auth_overflow") {
  console.log("x".repeat(10_000));
  console.error("Authentication failed: OAuth token expired");
  process.exit(1);
} else if (mode === "config") {
  console.error("Invalid MCP config file");
  process.exit(2);
} else if (mode === "stderr") {
  console.error("x".repeat(10000));
  process.exit(3);
} else if (mode === "huge_line") {
  console.log("x".repeat(10_000));
} else if (mode === "huge_answer") {
  for (let index = 0; index < 20; index++) {
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "answer-part" }] } }));
  }
} else if (mode === "tree") {
  const child = Bun.spawn([process.env.CHILD_SCRIPT!, process.env.CHILD_MARKER!, process.env.CHILD_PID!], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env,
  });
  appendFileSync(process.env.CHILD_PID!, String(child.pid));
  await Bun.sleep(60_000);
}
`);
  return executable;
}

describe("ClaudeWorker", () => {
  test("spawns an argv array with explicit cwd/env and parses stream-json", async () => {
    const paths = fixture();
    const capturePath = join(paths.root, "capture.json");
    const executable = fakeClaude(paths);
    const worker = new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: executable,
      env: {
        PATH: process.env.PATH ?? "",
        CLAUDE_CONFIG_DIR: capturePath,
        CLAUDE_CODE_OAUTH_TOKEN: "inherited-auth",
      },
    }));

    const result = await worker.run(request("guest", paths.guestWorkspace));

    expect(result).toEqual({
      ok: true,
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      text: "final answer",
      diagnostics: ["Malformed stream-json line 3: not json"],
      effectiveRole: "guest",
      progress: [{ type: "assistant", text: "draft text" }],
    });
    const capture = JSON.parse(readFileSync(capturePath, "utf8"));
    expect(capture.cwd).toBe(realpathSync(paths.guestWorkspace));
    expect(capture.argv).toContain("--safe-mode");
    expect(capture.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("inherited-auth");
    expect(capture.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  test("classifies retryable auth failures and terminal configuration failures", async () => {
    const paths = fixture();
    const executable = fakeClaude(paths);
    const baseEnv = { PATH: process.env.PATH ?? "" };

    const auth = await new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: executable,
      env: { ...baseEnv, FAKE_MODE: "auth" },
    })).run(request("admin", paths.ownerVault));
    const config = await new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: executable,
      env: { ...baseEnv, FAKE_MODE: "config" },
    })).run(request("admin", paths.ownerVault));
    const authWithOverflow = await new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: executable,
      stdoutLineLimitBytes: 128,
      env: { ...baseEnv, FAKE_MODE: "auth_overflow" },
    })).run(request("admin", paths.ownerVault));

    expect(auth).toMatchObject({ ok: false, error: { kind: "auth", retryable: true, exitCode: 1 } });
    expect(config).toMatchObject({ ok: false, error: { kind: "config", retryable: false, exitCode: 2 } });
    expect(authWithOverflow).toMatchObject({
      ok: false,
      error: { kind: "auth", retryable: true, exitCode: 1 },
    });
  });

  test("bounds captured stderr", async () => {
    const paths = fixture();
    const result = await new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: fakeClaude(paths),
      stderrLimitBytes: 128,
      env: { PATH: process.env.PATH ?? "", FAKE_MODE: "stderr" },
    })).run(request("admin", paths.ownerVault));

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.stderr.length).toBeLessThanOrEqual(128);
      expect(result.error.stderr).toEndWith("[truncated]");
    }
  });

  test("returns terminal structured failures for stdout line and answer overflow", async () => {
    const paths = fixture();
    for (const mode of ["huge_line", "huge_answer"]) {
      const result = await new ClaudeWorker(workerOptions(paths, {
        claudeExecutable: fakeClaude(paths),
        stdoutLineLimitBytes: 128,
        answerLimitBytes: 64,
        env: { PATH: process.env.PATH ?? "", FAKE_MODE: mode },
      })).run(request("admin", paths.ownerVault));

      expect(result).toMatchObject({
        ok: false,
        error: { kind: "output", retryable: false },
      });
      if (!result.ok) expect(result.error.message).toContain("exceeds");
    }
  });

  test("returns workspace validation as a terminal input failure", async () => {
    const paths = fixture();
    const outside = join(paths.root, "outside-worker");
    mkdirSync(outside);
    const escapedWorkspace = join(paths.workspacesBase, "escaped-worker");
    symlinkSync(outside, escapedWorkspace);
    const result = await new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: fakeClaude(paths),
      env: { PATH: process.env.PATH ?? "", FAKE_MODE: "success" },
    })).run(request("guest", escapedWorkspace));

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "input", retryable: false, exitCode: null },
    });
  });

  test("times out and kills descendants in the worker process group", async () => {
    const paths = fixture();
    const childScript = join(paths.root, "child.ts");
    const childMarker = join(paths.root, "child-finished");
    const childPid = join(paths.root, "child-pid");
    writeExecutable(childScript, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(Bun.argv[3], String(process.pid));
await Bun.sleep(700);
writeFileSync(Bun.argv[2], "survived");
`);
    const worker = new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: fakeClaude(paths),
      timeoutMs: 400,
      killGraceMs: 25,
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_MODE: "tree",
        CHILD_SCRIPT: childScript,
        CHILD_MARKER: childMarker,
        CHILD_PID: childPid,
      },
    }));

    const result = await worker.run(request("admin", paths.ownerVault));
    await Bun.sleep(1_300);

    expect(result).toMatchObject({ ok: false, error: { kind: "timeout", retryable: true } });
    expect(existsSync(childPid)).toBeTrue();
    expect(existsSync(childMarker)).toBeFalse();
  });

  test("abort kills the worker process group and returns a terminal cancellation", async () => {
    const paths = fixture();
    const childScript = join(paths.root, "abort-child.ts");
    const childMarker = join(paths.root, "abort-child-finished");
    const childPid = join(paths.root, "abort-child-pid");
    writeExecutable(childScript, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(Bun.argv[3], String(process.pid));
await Bun.sleep(800);
writeFileSync(Bun.argv[2], "survived");
`);
    const controller = new AbortController();
    const worker = new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: fakeClaude(paths),
      timeoutMs: 5_000,
      killGraceMs: 25,
      env: {
        PATH: process.env.PATH ?? "",
        FAKE_MODE: "tree",
        CHILD_SCRIPT: childScript,
        CHILD_MARKER: childMarker,
        CHILD_PID: childPid,
      },
    }));
    setTimeout(() => controller.abort(), 400);

    const result = await worker.run({
      ...request("admin", paths.ownerVault),
      signal: controller.signal,
    });
    await Bun.sleep(1_000);

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "aborted", retryable: false },
    });
    expect(existsSync(childPid)).toBeTrue();
    expect(existsSync(childMarker)).toBeFalse();
  });

  test("SIGKILLs a descendant that ignores SIGTERM after its leader exits", async () => {
    const paths = fixture();
    const childScript = join(paths.root, "stubborn-child.ts");
    const childMarker = join(paths.root, "stubborn-finished");
    const childPid = join(paths.root, "stubborn-pid");
    writeExecutable(childScript, `#!/bin/sh
trap '' TERM
printf '%s' "$$" > "$2"
while :; do sleep 1; done
`);
    const executable = join(paths.root, "exiting-leader.ts");
    writeExecutable(executable, `#!/usr/bin/env bun
process.on("SIGTERM", () => process.exit(0));
Bun.spawn([${JSON.stringify(childScript)}, ${JSON.stringify(childMarker)}, ${JSON.stringify(childPid)}], {
  stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env,
});
await Bun.sleep(60_000);
`);
    const worker = new ClaudeWorker(workerOptions(paths, {
      claudeExecutable: executable,
      timeoutMs: 400,
      killGraceMs: 250,
      env: { PATH: process.env.PATH ?? "" },
    }));

    const result = await Promise.race([
      worker.run(request("admin", paths.ownerVault)),
      Bun.sleep(1_500).then(() => "hung" as const),
    ]);
    if (result === "hung" && existsSync(childPid)) {
      try { process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL"); } catch {}
    }
    await Bun.sleep(1_300);

    expect(result).not.toBe("hung");
    expect(result).toMatchObject({ ok: false, error: { kind: "timeout" } });
    expect(existsSync(childMarker)).toBeFalse();
  });
});
