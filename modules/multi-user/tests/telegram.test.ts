import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import {
  TelegramApiError,
  TelegramClient,
  isTelegramConflict,
} from "../src/telegram";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "multi-user-telegram-"));
  temporaryDirectories.push(directory);
  return directory;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TelegramClient", () => {
  test("sends offset and long-poll timeout to getUpdates", async () => {
    const requests: URL[] = [];
    const client = new TelegramClient("secret", {
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return json({ ok: true, result: [{ update_id: 42 }] });
      },
    });

    expect(await client.getUpdates(41, 37)).toEqual([{ update_id: 42 }]);
    expect(requests[0].pathname).toBe("/botsecret/getUpdates");
    expect(requests[0].searchParams.get("offset")).toBe("41");
    expect(requests[0].searchParams.get("timeout")).toBe("37");
  });

  test("aborts an active getUpdates fetch through its AbortSignal", async () => {
    let receivedSignal: AbortSignal | null = null;
    let started!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = new TelegramClient("secret", {
      fetch: async (_input, init) => {
        receivedSignal = init?.signal as AbortSignal;
        started();
        if (!receivedSignal) throw new Error("getUpdates fetch is missing signal");
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const controller = new AbortController();

    const polling = client.getUpdates(0, 50, controller.signal);
    await fetchStarted;
    controller.abort();

    await expect(polling).rejects.toMatchObject({ name: "AbortError" });
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal.reason).toBe(controller.signal.reason);
  });

  test("times out a stalled getUpdates fetch slightly after its server timeout", async () => {
    let signal!: AbortSignal;
    const client = new TelegramClient("secret", {
      getUpdatesDeadlineGraceMs: 10,
      fetch: async (_input, init) => {
        signal = init?.signal as AbortSignal;
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await expect(client.getUpdates(0, 0)).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(signal.aborted).toBe(true);
  });

  test("propagates Bot API errors and classifies 409 conflicts", async () => {
    const client = new TelegramClient("secret", {
      fetch: async () =>
        json(
          { ok: false, error_code: 409, description: "terminated by other getUpdates" },
          409,
        ),
    });

    try {
      await client.getUpdates(0, 50);
      throw new Error("expected getUpdates to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TelegramApiError);
      expect(error).toMatchObject({ status: 409, errorCode: 409 });
      expect(isTelegramConflict(error)).toBe(true);
    }
  });

  test("preserves Telegram retry_after response parameters", async () => {
    const client = new TelegramClient("secret", {
      fetch: async () => json({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 17 },
      }, 429),
    });

    await expect(client.sendMessage(22, "retry")).rejects.toMatchObject({
      status: 429,
      errorCode: 429,
      parameters: { retry_after: 17 },
      retryAfterSeconds: 17,
    });
  });

  test("composes caller aborts and deadlines for send, getFile, and download", async () => {
    const seenSignals: AbortSignal[] = [];
    const client = new TelegramClient("secret", {
      deadlines: { sendMessageMs: 10, getFileMs: 10, downloadMs: 10 },
      fetch: async (_input, init) => {
        const signal = init?.signal as AbortSignal;
        seenSignals.push(signal);
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await expect(client.sendMessage(22, "timeout")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    const controller = new AbortController();
    const gettingFile = client.getFile("f1", controller.signal);
    controller.abort(new DOMException("shutdown", "AbortError"));
    await expect(gettingFile).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      client.downloadAttachment(
        temporaryDirectory(),
        "dm:1",
        "docs/f.bin",
        "f.bin",
        "1:0:document:f1",
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
  });

  test("chunks messages to 4096 UTF-16 units without splitting Unicode", async () => {
    const bodies: Array<{ chat_id: number; text: string }> = [];
    const client = new TelegramClient("secret", {
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ ok: true, result: { message_id: bodies.length } });
      },
    });
    const message = `${"a".repeat(4095)}😀${"b".repeat(4096)}`;

    await client.sendMessage(-100, message);

    expect(bodies.map(({ text }) => text).join("")).toBe(message);
    expect(bodies.length).toBe(3);
    expect(bodies.every(({ text }) => text.length <= 4096)).toBe(true);
    expect(bodies.every(({ text }) => !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
    expect(bodies.every(({ text }) => !/^[\uDC00-\uDFFF]/.test(text))).toBe(true);
  });

  test("sends typing actions and resolves Telegram files", async () => {
    const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
    const client = new TelegramClient("secret", {
      fetch: async (input, init) => {
        const method = new URL(String(input)).pathname.split("/").at(-1)!;
        calls.push({
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (method === "getFile") {
          return json({ ok: true, result: { file_id: "f1", file_path: "docs/a.txt" } });
        }
        return json({ ok: true, result: true });
      },
    });

    await client.sendTyping(123);
    expect(await client.getFile("f1")).toEqual({
      file_id: "f1",
      file_path: "docs/a.txt",
    });
    expect(calls).toEqual([
      { method: "sendChatAction", body: { chat_id: 123, action: "typing" } },
      { method: "getFile", body: { file_id: "f1" } },
    ]);
  });

  test("downloads attachments atomically into the encoded conversation upload root", async () => {
    const base = temporaryDirectory();
    const client = new TelegramClient("secret", {
      fetch: async (input) => {
        expect(String(input)).toContain("/file/botsecret/docs/file.bin");
        return new Response("attachment bytes");
      },
    });

    const download = await client.downloadAttachment(
      base,
      "group:-100",
      "docs/file.bin",
      "../../report.txt",
      "42:0:document:file-id",
    );
    const path = download.path;
    const uploadRoot = realpathSync(resolve(
      base,
      "workspaces",
      encodeURIComponent("group:-100"),
      "uploads",
    ));

    expect(dirname(path)).toBe(uploadRoot);
    expect(relative(uploadRoot, path).startsWith("..")).toBe(false);
    expect(path.endsWith("-report.txt")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("attachment bytes");
    expect(download.created).toBe(true);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  test("rejects an uploads symlink that escapes the base directory", async () => {
    const base = temporaryDirectory();
    const outside = temporaryDirectory();
    const uploads = join(
      base,
      "workspaces",
      encodeURIComponent("dm:1"),
      "uploads",
    );
    mkdirSync(dirname(uploads), { recursive: true });
    symlinkSync(outside, uploads, "dir");
    const client = new TelegramClient("secret", {
      fetch: async () => new Response("must not be written"),
    });

    await expect(
      client.downloadAttachment(
        base,
        "dm:1",
        "docs/file.bin",
        "file.bin",
        "1:0:document:file-id",
      ),
    ).rejects.toThrow(/workspace|symlink|escape/i);
    expect(existsSync(join(outside, "file.bin"))).toBe(false);
  });

  test("rejects malformed conversation and remote file paths before fetching", async () => {
    const base = temporaryDirectory();
    let fetched = false;
    const client = new TelegramClient("secret", {
      fetch: async () => {
        fetched = true;
        return new Response("must not be fetched");
      },
    });

    await expect(
      client.downloadAttachment(
        base,
        "..",
        "docs/file.bin",
        "file.bin",
        "1:0:document:file-id",
      ),
    ).rejects.toThrow(/conversation key/i);
    await expect(
      client.downloadAttachment(
        base,
        "dm:1",
        "../getMe",
        "file.bin",
        "1:0:document:file-id",
      ),
    ).rejects.toThrow(/Telegram file path/i);
    expect(fetched).toBe(false);
  });

  test("reuses deterministic complete attachments and cleans failed temp files", async () => {
    const base = temporaryDirectory();
    let fetches = 0;
    let failBody = false;
    const client = new TelegramClient("secret", {
      fetch: async () => {
        fetches++;
        if (failBody) {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => {
              throw new Error("body failed");
            },
          } as Response;
        }
        return new Response("stable bytes");
      },
    });

    const first = await client.downloadAttachment(
      base,
      "dm:1",
      "docs/file.bin",
      "report.txt",
      "50:0:document:file-id",
    );
    const second = await client.downloadAttachment(
      base,
      "dm:1",
      "docs/file.bin",
      "report.txt",
      "50:0:document:file-id",
    );

    expect(second).toEqual({ path: first.path, created: false });
    expect(fetches).toBe(1);

    failBody = true;
    await expect(
      client.downloadAttachment(
        base,
        "dm:1",
        "docs/other.bin",
        "other.txt",
        "50:1:document:other-id",
      ),
    ).rejects.toThrow("body failed");
    const uploadRoot = dirname(first.path);
    expect(
      (await Array.fromAsync(new Bun.Glob("*.part").scan({ cwd: uploadRoot }))).length,
    ).toBe(0);
  });

  test("caps deterministic filenames at 240 UTF-8 bytes without splitting emoji", async () => {
    const base = temporaryDirectory();
    const client = new TelegramClient("secret", {
      fetch: async () => new Response("bytes"),
    });
    const longName = `${"😀".repeat(200)}.txt`;

    const result = await client.downloadAttachment(
      base,
      "dm:1",
      "docs/f.bin",
      longName,
      "77:0:document:f1",
    );
    const localName = result.path.split("/").at(-1)!;

    expect(new TextEncoder().encode(localName).byteLength).toBeLessThanOrEqual(240);
    expect(localName.endsWith(".txt")).toBe(true);
    expect(readFileSync(result.path, "utf8")).toBe("bytes");
    expect(localName).not.toContain("�");
  });
});
