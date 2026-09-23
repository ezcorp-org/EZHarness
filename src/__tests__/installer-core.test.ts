import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives `deploy/installer/ezcorp` — the core every OS installer package wraps
 * — against stub engine/compose/curl binaries, and holds the compose files it
 * layers against the contracts they depend on.
 *
 * ## What these protect
 *
 * The installer runs unattended in front of someone who cannot read a compose
 * error, so its failure modes are silent-and-destructive rather than loud:
 *
 *  - **Re-keying.** The three secrets live in `.env`. The data is encrypted
 *    with them. Anything that deletes one while keeping the other turns a
 *    reinstall into a fresh install with orphaned data — no error, every
 *    stored provider key undecryptable. This is the property the uninstall
 *    tests exist for; the non-purge path was doing exactly this when the
 *    lifecycle was first run by hand.
 *  - **Port coupling.** The image pins EZCORP_PORT=3000 and in-container
 *    loopback callers (web/src/lib/server/security/bundled-creds.ts) depend on
 *    it, while ORIGIN must track the HOST port or svelte-adapter-bun defaults
 *    the scheme to https and login breaks. Setting the wrong one of those two
 *    is invisible until a user tries to log in.
 *  - **A dead suggestion host.** With the ollama profile off there is no such
 *    service, so EZCORP_SUGGEST_OLLAMA_URL must be absent rather than
 *    pointing at a host that will never answer.
 *
 * ## Why this is not a tautology
 *
 * The script assertions run the REAL script and inspect the files it writes
 * and the argv it hands the engine, rather than grepping it for strings. The
 * compose assertions hold that file against the invariants stated elsewhere
 * in the repo (the image's fixed internal port, compose.prod.yml's build/guard
 * shape) instead of restating its own contents.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "deploy", "installer", "ezcorp");
const COMPOSE_INSTALLER = join(REPO_ROOT, "deploy", "installer", "compose.installer.yml");
const COMPOSE_ISOLATED = join(REPO_ROOT, "deploy", "installer", "compose.isolated.yml");
const COMPOSE_TRUSTED_LOCAL = join(REPO_ROOT, "deploy", "installer", "compose.trusted-local.yml");
const REAL_SED = Bun.which("sed") ?? "";
if (!REAL_SED) throw new Error("Installer CLI tests require sed");
const REAL_OPENSSL = Bun.which("openssl") ?? "";
if (!REAL_OPENSSL) throw new Error("Installer CLI tests require openssl");

const SANDBOX = mkdtempSync(join(tmpdir(), "ezcorp-installer-"));
const BIN = join(SANDBOX, "bin");
mkdirSync(BIN, { recursive: true });

function stub(name: string, body: string, directory = BIN): void {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

// Engine stub: claims a running VM, reports the image as already present (so
// the pull leg is skipped), and logs every invocation.
stub(
  "podman",
  [
    'echo "podman $*" >> "$EZCORP_TEST_LOG"',
    'case "$1 $2" in',
    '  "machine inspect")',
    `    [ "\${EZCORP_TEST_NATIVE_PODMAN:-0}" = 1 ] && exit 1`,
    `    case "$*" in *PodmanSocket*) echo "\${EZCORP_TEST_SOCKET:-/tmp/podman.sock}" ;; *) echo "running" ;; esac; exit 0 ;;`,
    '  "info --format") echo "/run/user/1000/podman/podman.sock"; exit 0 ;;',
    '  "image exists") exit 0 ;;',
    `  "pull "*) exit "\${EZCORP_TEST_FAIL_PULL:-0}" ;;`,
    "esac",
    "exit 0",
  ].join("\n"),
);
stub(
  "docker-compose",
  [
    `echo "compose host=\${DOCKER_HOST:-unset} $*" >> "$EZCORP_TEST_LOG"`,
    'case " $* " in',
    '  *" stop "*|*" down "*)',
    '    count=$(cat "$EZCORP_CONFIG_DIR/stop-count" 2>/dev/null || echo 0)',
    '    count=$((count + 1)); echo "$count" > "$EZCORP_CONFIG_DIR/stop-count"',
    `    [ "$count" = "\${EZCORP_TEST_FAIL_STOP_NUMBER:-0}" ] && exit 1 ;;`,
    '  *" up -d "*)',
    `    [ "\${EZCORP_TEST_FAIL_UP:-0}" = 1 ] && exit 1`,
    `    if [ "\${EZCORP_TEST_MUTATE_UPDATE:-0}" = 1 ] && ! grep -q "^EZCORP_IMAGE=ezcorp:test$" "$EZCORP_CONFIG_DIR/.env"; then`,
    '      echo migrated > "$EZCORP_DATA_ROOT/data/sentinel"',
    '    fi ;;',
    'esac',
    "exit 0",
  ].join("\n"),
);
// The readiness probe is what gates "open the browser"; always ready here.
stub(
  "curl",
  [
    'echo "curl $*" >> "$EZCORP_TEST_LOG"',
    `state="\${EZCORP_TEST_READY_STATE:-ready}"`,
    `if [ "\${EZCORP_TEST_MUTATE_UPDATE:-0}" = 1 ] && ! grep -q "^EZCORP_IMAGE=ezcorp:test$" "$EZCORP_CONFIG_DIR/.env"; then state=data-recovery-needed; fi`,
    'if [ "$state" != ready ]; then',
    '  case " $* " in *" -f"*|*" --fail "*) exit 22 ;; esac',
    'fi',
    'printf \'{"state":"%s","since":"now"}\\n\' "$state"',
    "exit 0",
  ].join("\n"),
);
// Keep the real install from opening a browser window on the test machine.
stub("open", ['echo "open $*" >> "$EZCORP_TEST_LOG"', "exit 0"].join("\n"));
stub("xdg-open", ['echo "open $*" >> "$EZCORP_TEST_LOG"', "exit 0"].join("\n"));
stub("docker", ['echo "docker $*" >> "$EZCORP_TEST_LOG"', "exit 0"].join("\n"));
stub("id", `echo "\${EZCORP_TEST_UID:-1000}"`);
stub("uname", `echo "\${EZCORP_TEST_OS:-Linux}"`);
stub(
  "getent",
  [
    `mode="\${EZCORP_TEST_PASSWD_MODE:-valid}"`,
    '[ "$mode" = missing ] && exit 2',
    'printf \'test:x:%s:1000::%s:/bin/sh\\n\' "$2" "$EZCORP_TEST_ACCOUNT_HOME"',
    '[ "$mode" = ambiguous ] && echo "extra:x:1000:1000::/other:/bin/sh"',
    "exit 0",
  ].join("\n"),
);
stub("openssl", ['echo generated >> "$EZCORP_TEST_KEY_LOG"', 'exec "$EZCORP_TEST_REAL_OPENSSL" "$@"'].join("\n"));
stub(
  "sed",
  [
    'if [ "$1" = -i.bak ]; then',
    '  count=$(cat "$EZCORP_CONFIG_DIR/env-edit-count" 2>/dev/null || echo 0)',
    '  count=$((count + 1)); echo "$count" > "$EZCORP_CONFIG_DIR/env-edit-count"',
    `  [ "$count" = "\${EZCORP_TEST_FAIL_ENV_EDIT:-0}" ] && exit 1`,
    "fi",
    'exec "$EZCORP_TEST_REAL_SED" "$@"',
  ].join("\n"),
);

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  log: string;
}

let caseDir: string;
let configDir: string;
let dataRoot: string;
let runnerSocket: ReturnType<typeof Bun.listen>;
let runnerDir: string;
let runnerToken: string;
let runtimeDir: string;
let accountHome: string;

beforeEach(() => {
  caseDir = mkdtempSync(join(SANDBOX, "case-"));
  configDir = join(caseDir, "config");
  dataRoot = join(caseDir, "data");
  runnerDir = join(caseDir, "runner");
  runnerToken = join(caseDir, "runner-token");
  runtimeDir = join(caseDir, "runtime");
  accountHome = join(caseDir, "account-home");
  mkdirSync(runtimeDir);
  mkdirSync(accountHome);
  mkdirSync(runnerDir);
  writeFileSync(runnerToken, "test-only-runner-token");
  runnerSocket = Bun.listen({ unix: join(runnerDir, "runner.sock"), socket: { data() {} } });
});

afterEach(() => runnerSocket.stop(true));

function cliEnv(extraEnv: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH ?? ""}`,
    XDG_RUNTIME_DIR: runtimeDir,
    EZCORP_CONFIG_DIR: configDir,
    EZCORP_DATA_ROOT: dataRoot,
    EZCORP_CONTAINER_ENGINE: "podman",
    EZCORP_IMAGE: "ezcorp:test",
    EZCORP_TEST_LOG: join(caseDir, "invocations.log"),
    EZCORP_TEST_REAL_SED: REAL_SED,
    EZCORP_TEST_REAL_OPENSSL: REAL_OPENSSL,
    EZCORP_TEST_KEY_LOG: join(caseDir, "key-generation.log"),
    EZCORP_TEST_ACCOUNT_HOME: accountHome,
    EZCORP_READY_TIMEOUT: "30",
    EZ_RUNNER_SOCKET_DIR: runnerDir,
    EZ_RUNNER_TOKEN_FILE: runnerToken,
    EZ_RUNNER_GROUP: "1",
    ...extraEnv,
  };
}

function run(args: string[], extraEnv: Record<string, string | undefined> = {}, stdin = ""): Run {
  const logPath = join(caseDir, "invocations.log");
  writeFileSync(logPath, "");
  const proc = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    env: cliEnv(extraEnv),
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

function envFile(): string {
  return readFileSync(join(configDir, ".env"), "utf8");
}

function commandPath(commands: string[]): string {
  const directory = join(caseDir, "minimal-bin");
  mkdirSync(directory);
  for (const command of commands) {
    const executable = Bun.which(command);
    if (!executable) throw new Error(`Missing fixture command: ${command}`);
    symlinkSync(executable, join(directory, command));
  }
  return directory;
}

describe("ezcorp install — the config it generates", () => {
  test("writes every secret the stack needs, readable only by the owner", () => {
    const result = run(["install"]);
    expect(result.exitCode).toBe(0);

    const env = envFile();
    for (const key of [
      "EZCORP_ENCRYPTION_SECRET",
      "EZCORP_ENCRYPTION_SALT",
      "EZCORP_JWT_SECRET",
      "SEARXNG_SECRET",
    ]) {
      expect(env, `${key} missing`).toContain(`${key}=`);
      // A present-but-empty assignment would satisfy a substring check and
      // fail at boot, so require actual material.
      const value = env.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
      expect(value.length, `${key} is empty`).toBeGreaterThan(16);
    }

    expect(statSync(join(configDir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("points ORIGIN at the host port but never overrides the container's port", () => {
    run(["install"]);
    const env = envFile();

    const port = env.match(/^EZCORP_PORT_HOST=(\d+)$/m)?.[1];
    expect(port).toBeDefined();
    expect(env).toContain(`EZCORP_PUBLIC_URL=http://localhost:${port}`);

    // EZCORP_PORT is the CONTAINER's port, pinned to 3000 by the image.
    // Setting it from the host side breaks in-container loopback callers.
    expect(env).not.toMatch(/^EZCORP_PORT=/m);
  });

  test("creates all four bind-mount sources before starting the stack", () => {
    run(["install"]);
    for (const dir of ["data", "extensions", "extension-data", "projects"]) {
      expect(existsSync(join(dataRoot, dir)), `${dir} not created`).toBe(true);
    }
  });

  test("layers the rootless keep-id overlay", () => {
    const result = run(["install"]);
    // Without it the uid-1000 runtime cannot write the bind mount and PGlite
    // fails to open on first boot.
    expect(result.log).toContain("compose.machine.yml");
  });

  test("skips the download when the image is already on the machine", () => {
    const result = run(["install"]);
    expect(result.log).not.toMatch(/compose .*\bpull\b/);
    expect(result.stdout).toContain("already on this machine");
  });

  test("leaves the suggestion model off, and its URL unset with it", () => {
    run(["install"]);
    // A set URL with the profile off means the composer dials a host that
    // does not exist on every keystroke.
    expect(envFile()).not.toContain("EZCORP_SUGGEST_OLLAMA_URL");
    expect(run(["status"]).stdout).toContain("suggestions: off");
  });
});

describe("ezcorp install — port selection", () => {
  test("moves to the next port when the preferred one is taken", async () => {
    const blocker = Bun.listen({ hostname: "127.0.0.1", port: 4000, socket: { data() {} } });
    try {
      const result = run(["install"]);
      expect(result.exitCode).toBe(0);
      const port = Number(envFile().match(/^EZCORP_PORT_HOST=(\d+)$/m)?.[1]);
      expect(port).toBeGreaterThan(4000);
      expect(result.stdout).toContain("was busy");
    } finally {
      blocker.stop(true);
    }
  });

  test("skips a port held by a listener that never accepts", () => {
    // The real case: a stopped container leaves podman's port forward bound.
    // Nothing accepts connections there, so a connect-probe calls the port
    // free and compose then fails to bind it. Observed on a dev machine with
    // a leftover forward on 4000 after the VM restarted.
    stub(
      "lsof",
      [
        // Report a listener on 4000 only, like the leftover forward.
        'for arg in "$@"; do case "$arg" in -iTCP:4000) echo "ssh 1 u IPv4 TCP *:4000 (LISTEN)"; exit 0 ;; esac; done',
        "exit 1",
      ].join("\n"),
    );
    try {
      const result = run(["install"]);
      expect(result.exitCode).toBe(0);
      expect(Number(envFile().match(/^EZCORP_PORT_HOST=(\d+)$/m)?.[1])).toBe(4001);
    } finally {
      rmSync(join(BIN, "lsof"), { force: true });
    }
  });

  test("a second install resumes instead of re-keying", () => {
    run(["install"]);
    const first = envFile();
    const again = run(["install"]);

    expect(again.stdout).toContain("already set up");
    // Re-running the installer must never mint new secrets: the data on disk
    // is encrypted with the old ones.
    expect(envFile()).toBe(first);
  });
});

describe("ezcorp uninstall — what it may and may not destroy", () => {
  test("keeps the data AND the key that data is encrypted with", () => {
    run(["install"]);
    const secretBefore = envFile().match(/^EZCORP_ENCRYPTION_SECRET=(.*)$/m)?.[1];
    mkdirSync(join(dataRoot, "data", "ezcorp"), { recursive: true });

    const result = run(["uninstall"]);
    expect(result.exitCode).toBe(0);

    expect(existsSync(join(dataRoot, "data", "ezcorp"))).toBe(true);
    expect(envFile().match(/^EZCORP_ENCRYPTION_SECRET=(.*)$/m)?.[1]).toBe(secretBefore);
  });

  test("--purge deletes nothing unless the confirmation is typed exactly", () => {
    run(["install"]);
    mkdirSync(join(dataRoot, "data", "ezcorp"), { recursive: true });

    const refused = run(["uninstall", "--purge"], {}, "yes\n");
    expect(refused.exitCode).not.toBe(0);
    expect(existsSync(join(dataRoot, "data", "ezcorp"))).toBe(true);

    const confirmed = run(["uninstall", "--purge"], {}, "DELETE\n");
    expect(confirmed.exitCode).toBe(0);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test("reinstall keeps the suggestion opt-in together with its URL", () => {
    expect(run(["install"]).exitCode).toBe(0);
    expect(run(["suggestions", "on"]).exitCode).toBe(0);
    expect(run(["uninstall"]).exitCode).toBe(0);
    const restarted = run(["install"]);
    expect(restarted.exitCode).toBe(0);
    expect(envFile()).toContain("EZCORP_SUGGEST_OLLAMA_URL=http://ollama:11434");
    expect(restarted.log).toContain("--profile suggest");
  });
});

describe("installer lifecycle failures", () => {
  test("concurrent lifecycle commands cannot pass an install's key-generation boundary", async () => {
    const reached = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    const barrier = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          release = () => socket.end("continue\n");
          reached.resolve();
        },
      },
    });
    const barrierBin = join(caseDir, "barrier-bin");
    mkdirSync(barrierBin);
    stub("lsof", ['exec 3<>"/dev/tcp/127.0.0.1/$EZCORP_TEST_BARRIER_PORT"', 'echo ready >&3', 'read -r gate <&3', "exit 1"].join("\n"), barrierBin);
    const first = Bun.spawn({
      cmd: ["bash", SCRIPT, "install"],
      env: cliEnv({ PATH: `${barrierBin}:${BIN}:${process.env.PATH ?? ""}`, EZCORP_TEST_BARRIER_PORT: String(barrier.port) }),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await Promise.race([
        reached.promise,
        first.exited.then(async (code) => {
          throw new Error(`Install exited before barrier (${code}): ${await new Response(first.stderr).text()}`);
        }),
      ]);
      expect(existsSync(join(configDir, ".env"))).toBe(false);
      const otherRuntime = join(caseDir, "other-runtime");
      const otherTemp = join(caseDir, "other-temp");
      mkdirSync(otherRuntime);
      mkdirSync(otherTemp);
      for (const environment of [{}, { XDG_RUNTIME_DIR: otherRuntime, TMPDIR: otherTemp }, { XDG_RUNTIME_DIR: undefined, TMPDIR: otherTemp }]) {
        for (const args of [["install"], ["start"], ["stop"], ["update", "next"], ["suggestions", "on"], ["uninstall"]]) {
          const contender = run(args, environment);
          expect(contender.exitCode).not.toBe(0);
          expect(contender.stderr).toContain("another EZCorp lifecycle command");
          expect(contender.log).not.toContain("compose ");
        }
      }
    } finally {
      if (release) release();
      else first.kill();
      await first.exited;
      barrier.stop(true);
    }
    expect(first.exitCode).toBe(0);
    const original = envFile();
    expect(run(["install"]).exitCode).toBe(0);
    expect(envFile()).toBe(original);
    expect(readFileSync(join(caseDir, "key-generation.log"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  test("purge preserves the lock inode for the next lifecycle command", () => {
    expect(run(["install"]).exitCode).toBe(0);
    const lockPath = join(accountHome, ".ezcorp-installer-lock", "lifecycle.lock");
    const inode = statSync(lockPath).ino;
    expect(run(["uninstall", "--purge"], {}, "DELETE\n").exitCode).toBe(0);
    expect(statSync(lockPath).ino).toBe(inode);
    expect(run(["install"]).exitCode).toBe(0);
    expect(statSync(lockPath).ino).toBe(inode);
  });

  test.each(["EZCORP_CONFIG_DIR", "EZCORP_DATA_ROOT"])("rejects %s when its purge would contain the lock", (key) => {
    const result = run(["install"], { [key]: caseDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("lock must stay outside");
    expect(existsSync(join(configDir, ".env"))).toBe(false);
    expect(result.log).not.toContain("compose ");
  });

  test("missing flock stops before config or data creation", () => {
    const result = run(["install"], { PATH: commandPath(["bash", "dirname", "uname"]) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("flock");
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test("missing account lookup stops before config or data creation", () => {
    const result = run(["install"], { PATH: commandPath(["bash", "dirname", "uname", "flock"]) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("getent");
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test.each(["missing", "ambiguous"])("a %s account record cannot select an alternate lock", (mode) => {
    const result = run(["install"], { EZCORP_TEST_PASSWD_MODE: mode });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("account home");
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
  });

  test.each(["EZ_RUNNER_SOCKET_DIR", "EZ_RUNNER_TOKEN_FILE", "EZ_RUNNER_GROUP"])(
    "missing %s stops installation before any data or secrets are created",
    (key) => {
      const result = run(["install"], { [key]: "" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(key);
      expect(result.stderr).toContain("deploy/extension-runner/README.md");
      expect(existsSync(dataRoot)).toBe(false);
      expect(result.log).not.toContain("compose ");
    },
  );

  test("runner paths and group are saved for later starts", () => {
    expect(run(["install"]).exitCode).toBe(0);
    expect(envFile()).toContain(`EZ_RUNNER_SOCKET_DIR=${runnerDir}`);
    expect(envFile()).toContain(`EZ_RUNNER_TOKEN_FILE=${runnerToken}`);
    expect(envFile()).toContain("EZ_RUNNER_GROUP=1");
    const result = run(["start"], { EZ_RUNNER_SOCKET_DIR: undefined, EZ_RUNNER_TOKEN_FILE: undefined, EZ_RUNNER_GROUP: undefined });
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("up -d");
  });

  test.each([
    ["EZ_RUNNER_SOCKET_DIR", "relative/runner"],
    ["EZ_RUNNER_TOKEN_FILE", "relative/runner-token"],
    ["EZ_RUNNER_GROUP", "not-a-group"],
  ])("invalid %s stops installation before Compose", (key, value) => {
    const result = run(["install"], { [key]: value });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(key);
    expect(result.log).not.toContain("compose ");
    expect(existsSync(dataRoot)).toBe(false);
  });

  test("leaves mapped-group access checks to the app container", () => {
    chmodSync(runnerDir, 0o000);
    chmodSync(runnerToken, 0o000);
    try {
      const result = run(["install"]);
      expect(result.exitCode).toBe(0);
      expect(result.log).toContain("up -d");
    } finally {
      chmodSync(runnerDir, 0o700);
      chmodSync(runnerToken, 0o600);
    }
  });

  test("stops an update before copying live data if the stack cannot stop", () => {
    expect(run(["install"]).exitCode).toBe(0);
    writeFileSync(join(dataRoot, "data", "sentinel"), "original");
    const before = envFile();
    const result = run(["update", "next"], { EZCORP_TEST_FAIL_STOP_NUMBER: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not stop");
    expect(envFile()).toBe(before);
    expect(readdirSync(dataRoot)).not.toContainEqual(expect.stringMatching(/^pre-update-/));
    expect(result.log).not.toContain("pull ");
  });

  test("keeps both copies when the failed update cannot stop for rollback", () => {
    expect(run(["install"]).exitCode).toBe(0);
    writeFileSync(join(dataRoot, "data", "sentinel"), "original");
    const result = run(["update", "next"], { EZCORP_TEST_FAIL_STOP_NUMBER: "2", EZCORP_TEST_MUTATE_UPDATE: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not stop");
    expect(readFileSync(join(dataRoot, "data", "sentinel"), "utf8")).toBe("migrated\n");
    const snapshots = readdirSync(dataRoot).filter((name) => name.startsWith("pre-update-"));
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(join(dataRoot, snapshots[0]!, "sentinel"), "utf8")).toBe("original");
    expect(result.stderr).toContain(join(dataRoot, snapshots[0]!));
  });

  test("restores the old image and data after a failed update", () => {
    expect(run(["install"]).exitCode).toBe(0);
    writeFileSync(join(dataRoot, "data", "sentinel"), "original");
    const before = envFile();
    const result = run(["update", "next"], { EZCORP_TEST_MUTATE_UPDATE: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("rolled back");
    expect(envFile()).toBe(before);
    expect(readFileSync(join(dataRoot, "data", "sentinel"), "utf8")).toBe("original");
  });

  test("a failed download does not claim the app restarted when Compose fails", () => {
    expect(run(["install"]).exitCode).toBe(0);
    const before = envFile();
    const result = run(["update", "next"], { EZCORP_TEST_FAIL_PULL: "1", EZCORP_TEST_FAIL_UP: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not restart");
    expect(result.stderr).not.toContain("was restarted");
    expect(envFile()).toBe(before);
  });

  test("a successful update retains data and removes its temporary snapshot", () => {
    expect(run(["install"]).exitCode).toBe(0);
    writeFileSync(join(dataRoot, "data", "sentinel"), "original");
    const result = run(["update", "next"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Updated to");
    expect(envFile()).toContain("EZCORP_IMAGE=ghcr.io/ezcorp-org/ezcorp:next");
    expect(readFileSync(join(dataRoot, "data", "sentinel"), "utf8")).toBe("original");
    expect(readdirSync(dataRoot).filter((name) => name.startsWith("pre-update-"))).toEqual([]);
  });

  test.each([1, 2])("image configuration write %i failure keeps both copies and stops before restart", (failedWrite) => {
    expect(run(["install"]).exitCode).toBe(0);
    writeFileSync(join(dataRoot, "data", "sentinel"), "original");
    const result = run(["update", "next"], { EZCORP_TEST_FAIL_ENV_EDIT: String(failedWrite), EZCORP_TEST_MUTATE_UPDATE: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not save");
    expect(result.stdout).not.toContain("Updated to");
    expect(result.log.split("\n").filter((line) => line.startsWith("compose ") && line.includes("up -d"))).toHaveLength(failedWrite - 1);
    const snapshots = readdirSync(dataRoot).filter((name) => name.startsWith("pre-update-"));
    expect(snapshots).toHaveLength(1);
    expect(readFileSync(join(dataRoot, snapshots[0]!, "sentinel"), "utf8")).toBe("original");
    expect(result.stderr).toContain(join(dataRoot, snapshots[0]!));
    expect(readFileSync(join(dataRoot, "data", "sentinel"), "utf8")).toBe(failedWrite === 1 ? "original" : "migrated\n");
  });

  test("failed suggestion URL removal keeps the opt-in and makes no container changes", () => {
    expect(run(["install"]).exitCode).toBe(0);
    expect(run(["suggestions", "on"]).exitCode).toBe(0);
    const result = run(["suggestions", "off"], { EZCORP_TEST_FAIL_ENV_EDIT: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not save");
    expect(result.log).not.toContain("compose ");
    expect(existsSync(join(configDir, ".suggestions-on"))).toBe(true);
    expect(envFile()).toContain("EZCORP_SUGGEST_OLLAMA_URL=http://ollama:11434");
  });

  test.each(["install", "start", "open"])("%s shows recovery details without opening a browser", (command) => {
    if (command !== "install") expect(run(["install"]).exitCode).toBe(0);
    const result = run([command], { EZCORP_TEST_READY_STATE: "data-recovery-needed" });
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(join(dataRoot, "data", "backups"));
    expect(result.log).not.toContain("open http");
  });

  test("open checks readiness before opening a healthy app", () => {
    expect(run(["install"]).exitCode).toBe(0);
    const result = run(["open"]);
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("/api/ready");
    expect(result.log.indexOf("/api/ready")).toBeLessThan(result.log.indexOf("open http"));
  });

  test("disabling suggestions recreates the app without the sidecar URL", () => {
    expect(run(["install"]).exitCode).toBe(0);
    expect(run(["suggestions", "on"]).exitCode).toBe(0);
    const result = run(["suggestions", "off"]);
    expect(result.exitCode).toBe(0);
    expect(envFile()).not.toContain("EZCORP_SUGGEST_OLLAMA_URL");
    expect(result.log).toContain("up -d");
    const composeCalls = result.log.split("\n").filter((line) => line.startsWith("compose "));
    expect(composeCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of composeCalls) {
      expect(call).toContain("host=unix:///tmp/podman.sock");
      expect(call).toContain("compose.machine.yml");
    }
  });

  test("native Podman directs Compose to Podman even with a Docker host set", () => {
    const result = run(["install"], { EZCORP_TEST_NATIVE_PODMAN: "1", DOCKER_HOST: "unix:///wrong/docker.sock" });
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("compose host=unix:///run/user/1000/podman/podman.sock");
    expect(result.log).not.toContain("host=unix:///wrong/docker.sock");
  });

  test("Podman socket paths can contain spaces", () => {
    const result = run(["install"], { EZCORP_TEST_SOCKET: "/tmp/Podman socket/podman.sock" });
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("compose host=unix:///tmp/Podman socket/podman.sock");
  });

  test("Docker on Linux rejects an incompatible user before creating data", () => {
    const result = run(["install"], { EZCORP_CONTAINER_ENGINE: "docker", EZCORP_TEST_UID: "1001" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("1000");
    expect(result.stderr).toContain("Podman");
    expect(existsSync(dataRoot)).toBe(false);
    expect(existsSync(join(configDir, ".env"))).toBe(false);
  });

  test.each(["stop", "uninstall"])("%s reports an engine failure instead of claiming success", (command) => {
    expect(run(["install"]).exitCode).toBe(0);
    const result = run([command], { EZCORP_TEST_FAIL_STOP_NUMBER: "1" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not");
    expect(existsSync(join(configDir, ".env"))).toBe(true);
  });
});

describe("compose.installer.yml — the contracts it must honor", () => {
  test("pulls a released image and never builds on the user's machine", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    expect(text).not.toMatch(/^\s*build:/m);
    expect(text).toMatch(/\$\{EZCORP_IMAGE\}/);
  });

  test("carries no fail-fast interpolation guards, because the installer writes every value", async () => {
    // Comment lines are stripped first: the header explains the fail-fast
    // interpolation convention it declines to use, and prose is not config.
    const yaml = (await Bun.file(COMPOSE_INSTALLER).text())
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // compose.prod.yml aborts on a missing secret, which is right for a
    // hand-edited .env.prod. Here it would surface a compose stack trace to
    // someone who has never opened a terminal; the installer validates first.
    expect(yaml).not.toMatch(/\$\{[A-Z_]+:\?/);
  });

  test("maps the host port onto the container port the image actually pins", async () => {
    const compose = await Bun.file(COMPOSE_INSTALLER).text();
    const dockerfile = await Bun.file(join(REPO_ROOT, "Dockerfile")).text();

    const pinned = dockerfile.match(/^ENV EZCORP_PORT=(\d+)/m)?.[1];
    expect(pinned).toBeDefined();
    expect(compose).toContain(`"127.0.0.1:\${EZCORP_PORT_HOST}:${pinned}"`);
    expect(compose).toContain(`EZCORP_PORT: "${pinned}"`);
  });

  test("keeps the suggestion sidecars behind an opt-in profile", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    const ollamaBlock = text.slice(text.indexOf("\n  ollama:"));
    expect(ollamaBlock).toContain('profiles: ["suggest"]');
  });

  test("relabels every user-data bind for SELinux, and nothing the package owns", async () => {
    // Without `:z` an SELinux-enforcing host (Fedora, RHEL, CoreOS, ...) cannot
    // let the container write the user's data dir, and the app crash-loops on
    // EACCES — measured on Fedora CoreOS at 430 restarts. The rule is derived
    // from the binds themselves: every source under EZCORP_DATA_ROOT is the
    // user's and must be relabeled; anything else (the searxng config, which a
    // package installs under /usr) must NOT be, or compose would rewrite labels
    // on files the package manager owns.
    type Svc = { volumes?: unknown[] };
    // Built, not written, so no string literal contains a template-like `${`.
    const interpolated = `$${"{"}`;
    const dataRoot = `${interpolated}EZCORP_DATA_ROOT}`;
    const compose = Bun.YAML.parse(await Bun.file(COMPOSE_INSTALLER).text()) as { services: Record<string, Svc> };
    const binds = Object.values(compose.services)
      .flatMap((svc) => svc.volumes ?? [])
      .filter((v): v is string => typeof v === "string" && v.startsWith(interpolated));
    const userData = binds.filter((v) => v.startsWith(dataRoot));
    const other = binds.filter((v) => !v.startsWith(dataRoot));

    expect(userData.length).toBeGreaterThanOrEqual(4);
    for (const bind of userData) expect(bind, bind).toMatch(/:z$/);
    expect(other.length).toBeGreaterThan(0);
    for (const bind of other) expect(bind, bind).not.toMatch(/:[zZ](,|$)/);
  });

  test("pins the data and secrets paths into the mounted volume", async () => {
    const text = await Bun.file(COMPOSE_INSTALLER).text();
    // Left unset, getSecretsDir() falls back to process.cwd() — /app inside
    // the image, which is image state and vanishes on the next pull.
    expect(text).toContain("EZCORP_DB_PATH: /app/data/ezcorp");
    expect(text).toContain("EZCORP_SECRETS_DIR: /app/data");
  });

  // The isolated wiring moved from compose.installer.yml into its own overlay
  // when trusted-local became a choice, so the two modes cannot both be wired
  // at once. This is the same contract as before, pointed at where it now
  // lives: the startup check stays in the base (it is mode-aware), and the
  // connection stays byte-for-byte equal to production's compose.runner.yml.
  test("keeps the isolated runner connection and startup check used by production", async () => {
    type AppService = { services: { app: { entrypoint: string[]; environment: Record<string, string>; group_add: string[]; volumes: unknown[] } } };
    const baseFile = Bun.YAML.parse(await Bun.file(COMPOSE_INSTALLER).text()) as AppService;
    const compose = Bun.YAML.parse(await Bun.file(COMPOSE_ISOLATED).text()) as AppService;
    const runner = Bun.YAML.parse(await Bun.file(join(REPO_ROOT, "deploy/extension-runner/compose.runner.yml")).text()) as AppService;
    const base = Bun.YAML.parse(await Bun.file(join(REPO_ROOT, "deploy/extension-runner/compose.app.yml")).text()) as AppService;
    expect(baseFile.services.app.entrypoint).toEqual(base.services.app.entrypoint);
    for (const [key, value] of Object.entries(runner.services.app.environment)) {
      expect(compose.services.app.environment[key]).toBe(value);
    }
    expect(compose.services.app.group_add).toEqual([`\${EZ_RUNNER_GROUP}`]);
    const mounts = compose.services.app.volumes.filter((value) => typeof value === "object");
    expect(mounts).toEqual([
      { type: "bind", source: `\${EZ_RUNNER_SOCKET_DIR}`, target: "/run/ez-extension-runner", read_only: true, bind: { create_host_path: false } },
      { type: "bind", source: `\${EZ_RUNNER_TOKEN_FILE}`, target: "/run/secrets/extension-runner-token", read_only: true, bind: { create_host_path: false } },
    ]);
  });
});

// ── trusted-local: decision C, chosen by a person, never by default ─────────
//
// The consent must be impossible from a pipe, so these tests allocate a REAL
// terminal with util-linux `script` rather than adding an override the
// installer would honor. An override would be precisely the "copy one line to
// switch it on" path the app's acknowledgement sentence exists to prevent.

/** No isolated runner configured at all — the only state that may offer consent. */
const NO_RUNNER = { EZ_RUNNER_SOCKET_DIR: undefined, EZ_RUNNER_TOKEN_FILE: undefined, EZ_RUNNER_GROUP: undefined };

function runTty(args: string[], answer: string, extraEnv: Record<string, string | undefined> = {}): { exitCode: number; output: string; log: string } {
  const logPath = join(caseDir, "invocations.log");
  writeFileSync(logPath, "");
  const quoted = ["bash", SCRIPT, ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const proc = Bun.spawnSync({
    // -e: exit with the child's status. -q: no banner. /dev/null: no typescript file.
    cmd: ["script", "-q", "-e", "-c", quoted, "/dev/null"],
    env: cliEnv(extraEnv),
    stdin: new TextEncoder().encode(`${answer}\n`),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    log: existsSync(logPath) ? readFileSync(logPath, "utf8") : "",
  };
}

describe("trusted-local — offered only with nothing configured, taken only when typed", () => {
  test("without a terminal it refuses, names both ways forward, and creates nothing", () => {
    const result = run(["install"], NO_RUNNER, "I understand\n");
    expect(result.exitCode).not.toBe(0);
    // Piping the answer in must not work — that is the point of the check.
    expect(result.stderr).toContain("terminal");
    expect(result.stderr).toContain("deploy/extension-runner/README.md");
    expect(existsSync(join(configDir, ".env"))).toBe(false);
    expect(existsSync(dataRoot)).toBe(false);
    expect(result.log).not.toContain("compose ");
  });

  // Every non-empty proper subset of the three runner variables. Checking only
  // one of them let a mutation that dropped the other two checks survive, so
  // each is exercised as the lone survivor and as the lone gap.
  const RUNNER_VALUES = (): Record<string, string> => ({
    EZ_RUNNER_SOCKET_DIR: runnerDir,
    EZ_RUNNER_TOKEN_FILE: runnerToken,
    EZ_RUNNER_GROUP: "1",
  });
  const PARTIALS: string[][] = [
    ["EZ_RUNNER_SOCKET_DIR"],
    ["EZ_RUNNER_TOKEN_FILE"],
    ["EZ_RUNNER_GROUP"],
    ["EZ_RUNNER_SOCKET_DIR", "EZ_RUNNER_TOKEN_FILE"],
    ["EZ_RUNNER_SOCKET_DIR", "EZ_RUNNER_GROUP"],
    ["EZ_RUNNER_TOKEN_FILE", "EZ_RUNNER_GROUP"],
  ];
  test.each(PARTIALS)("a half-configured isolated runner (%s…) is an error, never an invitation to downgrade", (...present) => {
    // Someone setting up isolation who made a mistake must not be walked into
    // the unsandboxed mode — even at a terminal, even typing the answer.
    const values = RUNNER_VALUES();
    const env: Record<string, string | undefined> = { ...NO_RUNNER };
    for (const key of present) env[key] = values[key];
    const result = runTty(["install"], "I understand", env);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("Type I understand");
    expect(existsSync(join(configDir, ".env"))).toBe(false);
    expect(result.log).not.toContain("compose ");
  });

  test("any other answer stops the install with nothing written", () => {
    for (const answer of ["yes", "i understand", "I understand.", ""]) {
      const result = runTty(["install"], answer, NO_RUNNER);
      expect(result.exitCode, answer).not.toBe(0);
      expect(existsSync(join(configDir, ".env")), answer).toBe(false);
      expect(result.log, answer).not.toContain("compose ");
    }
  });

  test("the typed answer records the mode, the app's sentence, and no runner paths", () => {
    const result = runTty(["install"], "I understand", NO_RUNNER);
    expect(result.exitCode).toBe(0);
    // The explanation is shown before the question, not after.
    expect(result.output.indexOf("None of the seven sandbox controls apply")).toBeLessThan(
      result.output.indexOf("Type I understand"),
    );
    const env = envFile();
    expect(env).toContain("EZCORP_INSTALL_RUNNER_MODE=trusted-local");
    expect(env).toContain("EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers");
    // The app refuses to boot with trusted-local and an isolated socket both set.
    expect(env).not.toMatch(/^EZ_RUNNER_/m);
    expect(result.log).toContain("compose.trusted-local.yml");
    expect(result.log).not.toContain("compose.isolated.yml");
  });

  test("later starts keep the recorded mode and need no runner or terminal", () => {
    expect(runTty(["install"], "I understand", NO_RUNNER).exitCode).toBe(0);
    const result = run(["start"], NO_RUNNER);
    expect(result.exitCode).toBe(0);
    expect(result.log).toContain("compose.trusted-local.yml");
    expect(result.log).not.toContain("compose.isolated.yml");
  });

  test("a recorded mode without its acknowledgement refuses to start", () => {
    expect(runTty(["install"], "I understand", NO_RUNNER).exitCode).toBe(0);
    writeFileSync(join(configDir, ".env"), envFile().replace(/^EZCORP_EXTENSIONS_UNSANDBOXED_ACK=.*\n/m, ""));
    const result = run(["start"], NO_RUNNER);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("acknowledgement");
    expect(result.log).not.toContain("up -d");
  });

  test("an isolated install layers the isolated overlay and never the unsandboxed one", () => {
    const result = run(["install"]);
    expect(result.exitCode).toBe(0);
    expect(envFile()).toContain("EZCORP_INSTALL_RUNNER_MODE=isolated");
    expect(envFile()).not.toContain("EZCORP_EXTENSIONS_UNSANDBOXED_ACK");
    expect(result.log).toContain("compose.isolated.yml");
    expect(result.log).not.toContain("compose.trusted-local.yml");
  });
});

describe("compose.trusted-local.yml — held to the app and to production", () => {
  test("the installer writes exactly the sentence the app checks for", async () => {
    const script = await Bun.file(SCRIPT).text();
    const { UNSANDBOXED_ACK_SENTENCE } = await import("../extensions/runner-mode");
    expect(script).toContain(`UNSANDBOXED_ACK="${UNSANDBOXED_ACK_SENTENCE}"`);
  });

  test("mirrors production's trusted-local connection", async () => {
    type AppService = { services: { app: { user?: string; environment: Record<string, string> } } };
    const installer = Bun.YAML.parse(await Bun.file(COMPOSE_TRUSTED_LOCAL).text()) as AppService;
    const production = Bun.YAML.parse(
      await Bun.file(join(REPO_ROOT, "deploy/extension-runner/compose.trusted-local.yml")).text(),
    ) as AppService;
    expect(installer.services.app.user).toBe(production.services.app.user);
    expect(installer.services.app.environment.EZCORP_EXTENSION_RUNNER).toBe(
      production.services.app.environment.EZCORP_EXTENSION_RUNNER,
    );
    expect(Object.keys(installer.services.app.environment).sort()).toEqual(
      Object.keys(production.services.app.environment).sort(),
    );
  });

  test("carries no isolated-runner wiring, which the app refuses alongside it", async () => {
    const text = await Bun.file(COMPOSE_TRUSTED_LOCAL).text();
    const yaml = text.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
    expect(yaml).not.toContain("EZ_RUNNER_");
    expect(yaml).not.toContain("EZCORP_EXTENSION_RUNNER_SOCKET");
  });
});

describe("ezcorp launch — what the desktop entry runs", () => {
  test("first launch installs", () => {
    const result = run(["launch"]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(configDir, ".env"))).toBe(true);
    expect(result.log).toContain("up -d");
  });

  test("later launches start the existing install without re-keying it", () => {
    expect(run(["launch"]).exitCode).toBe(0);
    const before = envFile();
    const again = run(["launch"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).not.toContain("already set up");
    // Secrets encrypt the data on disk; a second launch must never mint new ones.
    expect(envFile()).toBe(before);
    expect(again.log).toContain("up -d");
  });
});

describe("a compose binary shipped beside the core is preferred", () => {
  // The Linux packages vendor docker-compose beside the core, because a stock
  // Linux with only podman has no compose provider at all. Run a copy of the
  // core from a directory that also holds a vendored stub, with the PATH stub
  // still present, and require the vendored one to win.
  test("the vendored binary is used over one on PATH", () => {
    const home = mkdtempSync(join(caseDir, "packaged-"));
    for (const file of readdirSync(join(REPO_ROOT, "deploy", "installer"))) {
      if (file.endsWith(".yml") || file === "ezcorp") {
        writeFileSync(join(home, file), readFileSync(join(REPO_ROOT, "deploy", "installer", file)));
      }
    }
    chmodSync(join(home, "ezcorp"), 0o755);
    writeFileSync(join(home, "docker-compose"), `#!/usr/bin/env bash\necho "vendored-compose $*" >> "$EZCORP_TEST_LOG"\n`);
    chmodSync(join(home, "docker-compose"), 0o755);

    const logPath = join(caseDir, "invocations.log");
    writeFileSync(logPath, "");
    const proc = Bun.spawnSync({
      cmd: ["bash", join(home, "ezcorp"), "install"],
      env: cliEnv({ EZCORP_SEARXNG_CONFIG: join(REPO_ROOT, "deploy", "searxng") }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = readFileSync(logPath, "utf8");
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    expect(log).toContain("vendored-compose ");
    expect(log.split("\n").some((line) => line.startsWith("compose "))).toBe(false);
  });
});
