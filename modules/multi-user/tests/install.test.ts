import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "multi-user-install-"));
  roots.push(root);
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  mkdirSync(bin);
  mkdirSync(join(root, "home/claude/.claude/channels/telegram"), { recursive: true });
  mkdirSync(join(root, "home/claude/.bun/bin"), { recursive: true });
  mkdirSync(join(root, "home/claude/.local/bin"), { recursive: true });
  writeFileSync(join(root, "home/claude/.claude/channels/telegram/.env"), "TELEGRAM_BOT_TOKEN=test\n");

  const bunExecutable = join(root, "home/claude/.bun/bin/bun");
  const claudeExecutable = join(root, "home/claude/.local/bin/claude");
  writeFileSync(bunExecutable, "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(
    claudeExecutable,
    "#!/usr/bin/env bash\nif [[ \" $* \" == *\" auth status \"* ]]; then echo '{\"loggedIn\": true}'; fi\nexit 0\n",
  );
  chmodSync(bunExecutable, 0o755);
  chmodSync(claudeExecutable, 0o755);

  const fake = `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$(basename \"$0\") $*\" >> \"$FAKE_LOG\"\nargs=\" $* \"\nif [[ \"$(basename \"$0\")\" == systemctl ]]; then\n  if [[ -n \"\${FAKE_FAIL_UNIT:-}\" && \"$args\" == *\" enable --now claude-multi-user-\${FAKE_FAIL_UNIT}.service \"* ]]; then exit 1; fi\n  if [[ \"$args\" == *\" is-active \"* ]]; then\n    case \"$args\" in\n      *claude-telegram.service*) [[ \"\${FAKE_SYSTEM_ACTIVE:-1}\" == 1 ]] ;;
      *cash-tg-receiver.service*) [[ \"\${FAKE_TRANSPORT_ACTIVE:-0}\" == 1 ]] ;;
      *) exit 1 ;;
    esac\n  fi\n  if [[ \"$args\" == *\" is-enabled \"* ]]; then\n    case \"$args\" in\n      *claude-telegram.service*) [[ \"\${FAKE_SYSTEM_ENABLED:-1}\" == 1 ]] ;;
      *cash-tg-receiver.service*) [[ \"\${FAKE_TRANSPORT_ENABLED:-0}\" == 1 ]] ;;
      *) exit 1 ;;
    esac\n  fi\nfi\n`;
  const fakeWithMarkerCheck = fake.replace(
    '  if [[ -n "${FAKE_FAIL_UNIT:-}"',
    '  if [[ "$args" == *" disable --now claude-telegram.service "* ]]; then\n' +
      '    [[ -f "$EXPECT_TRANSITION_MARKER" ]] || exit 88\n' +
      '    [[ "$(ls -ld "$EXPECT_TRANSITION_MARKER" | cut -c2-10)" == rw------- ]] || exit 89\n' +
      '    grep -qx "direction=enabling" "$EXPECT_TRANSITION_MARKER" || exit 90\n' +
      '    printf \'transition-marker present\\n\' >> "$FAKE_LOG"\n' +
      '    if [[ "${FAKE_PAUSE_ON_DISABLE:-0}" == 1 ]]; then\n' +
      '      : > "$FAKE_PAUSED"\n' +
      '      while [[ ! -f "$FAKE_RELEASE" ]]; do sleep 0.01; done\n' +
      '    fi\n' +
      '  fi\n' +
      '  if [[ "$args" == *" disable --now claude-multi-user-dispatcher.service "* && -f "$EXPECT_TRANSITION_MARKER" ]]; then\n' +
      '    printf \'transition-marker %s\\n\' "$(sed -n s/^direction=//p "$EXPECT_TRANSITION_MARKER")" >> "$FAKE_LOG"\n' +
      '  fi\n' +
      '  if [[ -n "${FAKE_FAIL_UNIT:-}"',
  );
  for (const name of ["systemctl", "loginctl"]) {
    writeFileSync(join(bin, name), fakeWithMarkerCheck);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, "runuser"), `#!/usr/bin/env bash\nset -euo pipefail\nprintf 'runuser %s\\n' \"$*\" >> \"$FAKE_LOG\"\nwhile [[ $# -gt 0 && $1 != -- ]]; do shift; done\nshift\nexec \"$@\"\n`);
  chmodSync(join(bin, "runuser"), 0o755);
  writeFileSync(join(bin, "timeout"), "#!/usr/bin/env bash\nshift\nexec \"$@\"\n");
  chmodSync(join(bin, "timeout"), 0o755);
  writeFileSync(join(bin, "flock"), `#!/usr/bin/env python3
import fcntl
import sys

flags = fcntl.LOCK_EX
if "-n" in sys.argv:
    flags |= fcntl.LOCK_NB
try:
    fcntl.flock(int(sys.argv[-1]), flags)
except BlockingIOError:
    raise SystemExit(1)
`);
  chmodSync(join(bin, "flock"), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    MULTI_USER_ROOT: root,
    MULTI_USER_SKIP_ROOT_CHECK: "1",
    CLAUDE_UID: "1001",
    OWNER_CHAT_ID: "4242",
    MODULE_TRANSPORT_DAEMON: "0",
    EXPECT_TRANSITION_MARKER: join(root, "home/claude/multi-user/state/transitioning"),
  };
  return { root, log, env };
}

async function install(action: string, env: Record<string, string | undefined>) {
  return Bun.$`bash modules/multi-user/install.sh ${action}`.env(env).quiet().nothrow();
}

async function reconcile(env: Record<string, string | undefined>) {
  return Bun.$`bash modules/multi-user/transport-reconcile.sh reconcile`.env(env).quiet().nothrow();
}

describe("multi-user installer", () => {
  test("enable is idempotent, exclusive, ordered, and writes private runtime files", async () => {
    const fx = fixture();
    expect((await install("enable", fx.env)).exitCode).toBe(0);
    expect((await install("enable", fx.env)).exitCode).toBe(0);

    const commands = readFileSync(fx.log, "utf8");
    const stopSystem = commands.indexOf("systemctl disable --now claude-telegram.service");
    const stopTransport = commands.indexOf("systemctl --user disable --now cash-tg-receiver.service");
    const startReceiver = commands.indexOf("systemctl --user enable --now claude-multi-user-receiver.service");
    const startDispatcher = commands.indexOf("systemctl --user enable --now claude-multi-user-dispatcher.service");
    expect(stopSystem).toBeGreaterThanOrEqual(0);
    expect(stopTransport).toBeGreaterThanOrEqual(0);
    expect(startReceiver).toBeGreaterThan(stopSystem);
    expect(startReceiver).toBeGreaterThan(stopTransport);
    expect(startDispatcher).toBeGreaterThan(startReceiver);
    expect(commands.indexOf("transition-marker present")).toBeGreaterThan(stopSystem);

    const home = join(fx.root, "home/claude");
    expect(statSync(join(home, "multi-user/state")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "multi-user/state/workspaces")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "multi-user/multi-user.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "logs/transport-lifecycle.lock")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "multi-user/multi-user.env"), "utf8"))
      .toContain("ADMIN_CHAT_IDS=4242");
    const metadata = join(fx.root, "var/lib/claude-multi-user/previous-transport-state");
    expect(readFileSync(metadata, "utf8"))
      .toContain("LEGACY_SYSTEM_ENABLED=1\nLEGACY_SYSTEM_ACTIVE=1");
    expect(statSync(metadata).mode & 0o777).toBe(0o600);
    expect(statSync(join(fx.root, "var/lib/claude-multi-user")).mode & 0o777).toBe(0o700);
    expect(existsSync(join(home, "multi-user/state/enabled"))).toBe(true);
    expect(existsSync(join(home, "multi-user/state/transitioning"))).toBe(false);
  });

  test("disable stops both module services before restoring the exact prior mode", async () => {
    const fx = fixture();
    expect((await install("enable", fx.env)).exitCode).toBe(0);
    const transitioning = join(fx.root, "home/claude/multi-user/state/transitioning");
    writeFileSync(transitioning, "direction=disabling\nstarted_at=1\n", { mode: 0o600 });
    writeFileSync(fx.log, "");
    expect((await install("disable", fx.env)).exitCode).toBe(0);
    expect(existsSync(transitioning)).toBe(false);

    const commands = readFileSync(fx.log, "utf8");
    const stopReceiver = commands.indexOf("systemctl --user disable --now claude-multi-user-receiver.service");
    const stopDispatcher = commands.indexOf("systemctl --user disable --now claude-multi-user-dispatcher.service");
    const restoreEnabled = commands.indexOf("systemctl enable claude-telegram.service");
    const restore = commands.indexOf("systemctl start claude-telegram.service");
    expect(stopReceiver).toBeGreaterThanOrEqual(0);
    expect(stopDispatcher).toBeGreaterThanOrEqual(0);
    expect(restoreEnabled).toBeGreaterThan(stopReceiver);
    expect(restore).toBeGreaterThan(restoreEnabled);
    expect(commands).toContain("transition-marker disabling");
  });

  test("serializes concurrent transitions with the shared lifecycle lock", async () => {
    const fx = fixture();
    const paused = join(fx.root, "paused");
    const release = join(fx.root, "release");
    const env = {
      ...fx.env,
      FAKE_PAUSE_ON_DISABLE: "1",
      FAKE_PAUSED: paused,
      FAKE_RELEASE: release,
    };
    const first = Bun.spawn(["bash", "modules/multi-user/install.sh", "enable"], {
      cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    for (let attempt = 0; attempt < 200 && !existsSync(paused); attempt++) await Bun.sleep(10);
    expect(existsSync(paused)).toBe(true);
    const beforeSecond = readFileSync(fx.log, "utf8");
    const second = Bun.spawn(["bash", "modules/multi-user/install.sh", "enable"], {
      cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe",
    });
    await Bun.sleep(100);
    expect(readFileSync(fx.log, "utf8")).toBe(beforeSecond);
    writeFileSync(release, "go\n");
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
  });

  test("reconciles stale enabling and disabling transitions with fixed commands", async () => {
    const enabling = fixture();
    expect((await install("enable", enabling.env)).exitCode).toBe(0);
    const enablingMarker = join(enabling.root, "home/claude/multi-user/state/transitioning");
    writeFileSync(enablingMarker, "direction=enabling\nstarted_at=1\n", { mode: 0o600 });
    writeFileSync(enabling.log, "");
    expect((await reconcile(enabling.env)).exitCode).toBe(0);
    const enablingCommands = readFileSync(enabling.log, "utf8");
    expect(enablingCommands.indexOf("disable --now claude-telegram.service")).toBeLessThan(
      enablingCommands.indexOf("enable --now claude-multi-user-receiver.service"),
    );
    expect(existsSync(enablingMarker)).toBe(false);

    const disabling = fixture();
    expect((await install("enable", disabling.env)).exitCode).toBe(0);
    const disablingMarker = join(disabling.root, "home/claude/multi-user/state/transitioning");
    writeFileSync(disablingMarker, "direction=disabling\nstarted_at=1\n", { mode: 0o600 });
    writeFileSync(disabling.log, "");
    expect((await reconcile(disabling.env)).exitCode).toBe(0);
    const disablingCommands = readFileSync(disabling.log, "utf8");
    expect(disablingCommands.indexOf("disable --now claude-multi-user-dispatcher.service"))
      .toBeLessThan(disablingCommands.indexOf("start claude-telegram.service"));
    expect(existsSync(disablingMarker)).toBe(false);
  });

  test("restores transport-daemon mode without starting its poller first", async () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      FAKE_TRANSPORT_ACTIVE: "1",
      FAKE_TRANSPORT_ENABLED: "1",
    };
    expect((await install("enable", env)).exitCode).toBe(0);
    expect(readFileSync(
      join(fx.root, "var/lib/claude-multi-user/previous-transport-state"),
      "utf8",
    )).toContain("LEGACY_USER_ENABLED=1\nLEGACY_USER_ACTIVE=1");
    writeFileSync(fx.log, "");
    expect((await install("disable", env)).exitCode).toBe(0);

    const commands = readFileSync(fx.log, "utf8");
    const systemStart = commands.indexOf("systemctl start claude-telegram.service");
    const transportStart = commands.indexOf("systemctl --user start cash-tg-receiver.service");
    expect(systemStart).toBeGreaterThanOrEqual(0);
    expect(transportStart).toBeGreaterThan(systemStart);
  });

  test("restores disabled and inactive legacy units without starting either", async () => {
    const fx = fixture();
    const env = {
      ...fx.env,
      FAKE_SYSTEM_ACTIVE: "0",
      FAKE_SYSTEM_ENABLED: "0",
      FAKE_TRANSPORT_ACTIVE: "0",
      FAKE_TRANSPORT_ENABLED: "0",
    };
    expect((await install("enable", env)).exitCode).toBe(0);
    writeFileSync(
      join(fx.root, "var/lib/claude-multi-user/previous-transport-state"),
      "LEGACY_SYSTEM_ENABLED=0\nLEGACY_SYSTEM_ACTIVE=0\nLEGACY_USER_ENABLED=0\nLEGACY_USER_ACTIVE=0\n",
    );
    writeFileSync(fx.log, "");
    expect((await install("disable", env)).exitCode).toBe(0);
    const commands = readFileSync(fx.log, "utf8");
    expect(commands).toContain("systemctl disable claude-telegram.service");
    expect(commands).toContain("systemctl --user disable cash-tg-receiver.service");
    expect(commands).not.toContain("systemctl start claude-telegram.service");
    expect(commands).not.toContain("systemctl --user start cash-tg-receiver.service");
  });

  test("update re-applies multi-user instead of restarting the legacy poller", () => {
    const source = readFileSync("update.sh", "utf8");
    expect(source).toContain("modules/multi-user/install.sh\" enable");
    expect(source).toMatch(/if \[\[ .*MODULE_MULTI_USER/);
    expect(source).not.toMatch(/MODULE_MULTI_USER.*\|\|.*state\/enabled/);
    expect(source).not.toMatch(/^systemctl restart claude-telegram\.service/m);
    expect(source).toContain("WAS_MULTI_USER");
  });

  test("preflight failure does not stop either legacy poller", async () => {
    const fx = fixture();
    rmSync(join(fx.root, "home/claude/.local/bin/claude"));
    const result = await install("enable", fx.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Claude executable");
    expect(existsSync(fx.log) ? readFileSync(fx.log, "utf8") : "").not.toContain("disable --now");
  });

  test("logged-out Claude preflight does not stop either legacy poller", async () => {
    const fx = fixture();
    writeFileSync(
      join(fx.root, "home/claude/.local/bin/claude"),
      "#!/usr/bin/env bash\necho '{\"loggedIn\": false}'\nexit 0\n",
    );
    const result = await install("enable", fx.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not authenticated");
    expect(existsSync(fx.log) ? readFileSync(fx.log, "utf8") : "").not.toContain("disable --now");
  });

  test("start failure stops multi services and restores captured legacy state", async () => {
    const fx = fixture();
    const result = await install("enable", { ...fx.env, FAKE_FAIL_UNIT: "dispatcher" });
    expect(result.exitCode).not.toBe(0);
    const commands = readFileSync(fx.log, "utf8");
    const failedStart = commands.indexOf("enable --now claude-multi-user-dispatcher.service");
    const stopReceiver = commands.indexOf(
      "disable --now claude-multi-user-receiver.service",
      failedStart,
    );
    const restoreLegacy = commands.indexOf("systemctl start claude-telegram.service", failedStart);
    expect(stopReceiver).toBeGreaterThan(failedStart);
    expect(restoreLegacy).toBeGreaterThan(stopReceiver);
    expect(existsSync(join(fx.root, "home/claude/multi-user/state/transitioning"))).toBe(false);
  });

  test("never executes captured-state payloads and rejects malformed metadata before services", async () => {
    const fx = fixture();
    expect((await install("enable", fx.env)).exitCode).toBe(0);
    const metadata = join(fx.root, "var/lib/claude-multi-user/previous-transport-state");
    const payload = join(fx.root, "payload-executed");
    writeFileSync(metadata, `LEGACY_SYSTEM_ENABLED=1\nLEGACY_SYSTEM_ACTIVE=1\nLEGACY_USER_ENABLED=0\nLEGACY_USER_ACTIVE=$(touch ${payload})\n`);
    writeFileSync(fx.log, "");

    const result = await install("disable", fx.env);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(payload)).toBe(false);
    expect(readFileSync(fx.log, "utf8")).not.toContain("disable --now");
    expect(result.stderr.toString()).toContain("invalid legacy transport state");
  });

  test("disable is a no-op without state and fails before services when transition metadata is missing", async () => {
    const fx = fixture();
    expect((await install("disable", fx.env)).exitCode).toBe(0);
    expect(existsSync(fx.log) ? readFileSync(fx.log, "utf8") : "").not.toContain("systemctl");

    const state = join(fx.root, "home/claude/multi-user/state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "transitioning"), "direction=disabling\nstarted_at=1\n");
    const result = await install("disable", fx.env);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(fx.log) ? readFileSync(fx.log, "utf8") : "").not.toContain("disable --now");
  });

  test("saved module flag is authoritative for core install and update", () => {
    const core = readFileSync("assets/install-core.sh", "utf8");
    const update = readFileSync("update.sh", "utf8");
    expect(core).toMatch(/MODULE_MULTI_USER.*== 0[\s\S]*install\.sh\" disable/);
    expect(update).toMatch(/MODULE_MULTI_USER.*== 1[\s\S]*install\.sh\" enable[\s\S]*install\.sh\" disable/);
    expect(core).toContain('multi-user/state/transitioning');
    expect(update).toContain('multi-user/state/transitioning');
  });

  test("normalizes admin IDs and Bash-quotes persisted values without execution", async () => {
    const fx = fixture();
    expect((await install("enable", { ...fx.env, ADMIN_CHAT_IDS: " 42, -7 " })).exitCode)
      .toBe(0);
    expect(readFileSync(join(fx.root, "home/claude/multi-user/multi-user.env"), "utf8"))
      .toContain("ADMIN_CHAT_IDS=42,-7");

    const invalid = fixture();
    const rejected = await install("enable", { ...invalid.env, ADMIN_CHAT_IDS: "123 456" });
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain("ADMIN_CHAT_IDS must contain numeric Telegram IDs");
    expect(existsSync(join(invalid.root, "commands.log"))).toBe(false);

    const core = readFileSync("assets/install-core.sh", "utf8");
    expect(core.indexOf('[[ "$ADMIN_CHAT_IDS" =~')).toBeLessThan(
      core.indexOf("ADMIN_CHAT_IDS//[[:space:]]/"),
    );
    expect(core).toContain("printf '%s=%q\\n'");
    const saved = join(fx.root, "saved.env");
    const payload = join(fx.root, "quoted-payload-executed");
    const dangerous = `name with spaces; $(touch ${payload})`;
    expect(Bun.spawnSync(
      ["bash", "-c", "printf 'VALUE=%q\\n' \"$VALUE\" > \"$SAVED\""],
      { env: { ...process.env, VALUE: dangerous, SAVED: saved } },
    ).exitCode).toBe(0);
    const read = Bun.spawnSync(
      ["bash", "-c", "source \"$SAVED\"; printf '%s' \"$VALUE\""],
      { env: { ...process.env, SAVED: saved }, stdout: "pipe" },
    );
    expect(read.stdout.toString()).toBe(dangerous);
    expect(existsSync(payload)).toBe(false);
  });

  test("health scripts have an isolated multi-user supervision path", () => {
    const healthcheck = readFileSync("assets/bin/cash-healthcheck", "utf8");
    const doctor = readFileSync("assets/bin/cash-doctor", "utf8");
    const installer = readFileSync("modules/multi-user/install.sh", "utf8");
    expect(healthcheck).toContain("claude-multi-user-receiver.service");
    expect(healthcheck).toContain("claude-multi-user-dispatcher.service");
    expect(healthcheck).toContain("/home/claude/multi-user/state/transitioning");
    expect(healthcheck).toContain("/home/claude/logs/transport-lifecycle.lock");
    expect(healthcheck).toContain("claude-multi-user-reconcile reconcile");
    expect(healthcheck).toMatch(/NOW - STARTED_AT[^\n]*-ge 300/);
    expect(healthcheck).toMatch(/flock[^\n]*-n[^\n]*-x|flock[^\n]*-x[^\n]*-n/);
    expect(healthcheck.indexOf("flock")).toBeLessThan(
      healthcheck.indexOf("sudo systemctl stop claude-telegram.service"),
    );
    expect(healthcheck).toMatch(/MULTI_USER_ENABLED[\s\S]*if[\s\S]*else[\s\S]*claude-telegram/);
    const multiHealth = healthcheck.slice(
      healthcheck.indexOf('if [ "$MULTI_USER_ENABLED" -eq 1 ]'),
      healthcheck.indexOf("\nelse\n"),
    );
    expect(multiHealth).not.toMatch(/(?:start|restart) claude-telegram/);
    expect(multiHealth).not.toContain("plugins-official.*telegram");
    expect(doctor).toContain("router.sqlite");
    expect(doctor).toContain("sole poller");
    expect(doctor).toContain("transitioning");
    expect(doctor).toContain("integrity unchecked");
    expect(healthcheck).toContain("DB_OK=null");
    expect(installer).toMatch(/chown[^\n]*transport-lifecycle|chown[^\n]*LIFECYCLE_LOCK/);
    const receiverUnit = readFileSync(
      "modules/multi-user/systemd/claude-multi-user-receiver.service",
      "utf8",
    );
    const dispatcherUnit = readFileSync(
      "modules/multi-user/systemd/claude-multi-user-dispatcher.service",
      "utf8",
    );
    expect(receiverUnit).toContain("ProtectHome=read-only");
    expect(receiverUnit).toContain("NoNewPrivileges=true");
    expect(dispatcherUnit).not.toContain("NoNewPrivileges=true");
    expect(dispatcherUnit).not.toContain("ProtectSystem=");
  });

  test("fails loudly when transport-daemon and multi-user are both requested", async () => {
    const fx = fixture();
    const result = await install("enable", { ...fx.env, MODULE_TRANSPORT_DAEMON: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("MODULE_TRANSPORT_DAEMON=1");
  });
});
