import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNSANDBOXED_ACK_SENTENCE, UNSANDBOXED_ACK_VARIABLE } from "../extensions/runner-mode";

/**
 * Drives `scripts/setup-podman.sh` — the one-command install — against a
 * scratch tree and a stubbed engine, on the OS it is told it is on.
 *
 * ## The bugs these exist to prevent
 *
 * 1. Re-running setup regenerates the secrets in an existing .env.prod.
 *    Rotating EZCORP_ENCRYPTION_SECRET renders every stored credential
 *    unreadable, so existing files are immutable. Concurrent fresh runs must
 *    publish one complete candidate, and every loser must fully validate the
 *    winner before it continues.
 * 2. The unsandboxed-extensions acknowledgement gets written without being
 *    asked for. The sentence is imported from runner-mode.ts so it cannot
 *    drift, AND the script must refuse to write it non-interactively unless
 *    the flag is passed — on macOS. On Linux it must never be written by
 *    default at all: that host can run the isolated runner and downgrading it
 *    silently is the failure the acknowledgement exists to prevent.
 * 3. The script quietly requires bash 4 (associative arrays, mapfile) and so
 *    fails on the shell macOS ships. Linux runs use the available Bash and do
 *    not claim 3.2 coverage. The dedicated macOS CI job selects /bin/bash,
 *    verifies that it is 3.2, and then runs this complete behavior suite.
 *
 * ## Why this is not a tautology
 *
 * The expected values come from the runner-mode module and from the example
 * env file's own placeholders, not from literals repeated here; the engine
 * calls are read back from what the stubs recorded rather than from grepping
 * the script.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "setup-podman.sh");
const EXAMPLE = join(REPO_ROOT, ".env.prod.example");
const BASH = process.env.EZ_SETUP_TEST_BASH ?? Bun.which("bash") ?? (() => {
  throw new Error("setup-podman tests require bash on PATH");
})();
const REAL_AWK = Bun.which("awk") ?? (() => {
  throw new Error("setup-podman tests require awk on PATH");
})();
const REAL_SED = Bun.which("sed") ?? (() => {
  throw new Error("setup-podman tests require sed on PATH");
})();
const REAL_GREP = Bun.which("grep") ?? (() => {
  throw new Error("setup-podman tests require grep on PATH");
})();
const REAL_SLEEP = Bun.which("sleep") ?? (() => {
  throw new Error("setup-podman tests require sleep on PATH");
})();
const REAL_LN = Bun.which("ln") ?? (() => {
  throw new Error("setup-podman tests require ln on PATH");
})();
const REAL_CHMOD = Bun.which("chmod") ?? (() => {
  throw new Error("setup-podman tests require chmod on PATH");
})();

const SANDBOX = mkdtempSync(join(tmpdir(), "setup-podman-"));
const BIN = join(SANDBOX, "bin");
const CALLS = join(SANDBOX, "calls.log");
const SECRET_SENTINEL = "audit-secret-never-in-child-argv";
mkdirSync(BIN, { recursive: true });

// Stubs record their argv and answer the few probes the script makes.
// `podman machine list` reports a running machine so no init/start happens.
function stub(name: string, body: string) {
  writeFileSync(join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${CALLS}"\n${body}\n`);
  chmodSync(join(BIN, name), 0o755);
}
stub("brew", `if [ "$1 $2" = "install podman" ] && [ -n "\${EZ_TEST_BREW_BIN:-}" ]; then
  "${REAL_LN}" -s "$EZ_TEST_BREW_PODMAN_SOURCE" "$EZ_TEST_BREW_BIN/podman"
elif [ "$1 $2" = "install docker-compose" ] && [ -n "\${EZ_TEST_BREW_BIN:-}" ]; then
  "${REAL_LN}" -s "$EZ_TEST_BREW_COMPOSE_SOURCE" "$EZ_TEST_BREW_BIN/docker-compose"
fi
exit 0`);
stub("podman", `case "$1 $2" in
  "machine list")
    echo "NAME  VM TYPE  CREATED  LAST UP"
    case "\${EZ_TEST_MACHINE_STATE:-running}" in
      running) echo "podman-machine-default  applehv  1 hour ago  Currently running" ;;
      stopped) echo "podman-machine-default  applehv  1 hour ago  Never" ;;
      none) ;;
    esac
    ;;
esac
exit 0`);
stub("docker", `[ "$1 $2" = "compose version" ] && [ "\${EZ_TEST_DOCKER_COMPOSE_WORKS:-0}" = 1 ]`);
stub("docker-compose", `[ "$1" = version ] && [ "\${EZ_TEST_STANDALONE_COMPOSE_WORKS:-1}" = 1 ]`);
stub("systemctl", "exit 0");
stub("bash", "exit 0");
stub("openssl", `printf '%s\\n' '${SECRET_SENTINEL}'`);
stub("curl", `if [ "\${EZ_TEST_CURL_SUCCESS:-0}" = 1 ]; then
  printf '%s\\n' '{"ready":true}'
elif [ -n "\${EZ_TEST_CURL_SUCCEED_AFTER:-}" ]; then
  count=0
  [ ! -f "$EZ_TEST_CURL_COUNT_FILE" ] || count="$(cat "$EZ_TEST_CURL_COUNT_FILE")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "$EZ_TEST_CURL_COUNT_FILE"
  [ "$count" -lt "$EZ_TEST_CURL_SUCCEED_AFTER" ] || printf '%s\\n' '{"ready":true}'
fi`);
stub("sleep", `[ "\${EZ_TEST_FAST_SLEEP:-0}" = 1 ] && exit 0
exec "${REAL_SLEEP}" "$@"`);
stub("date", "exit 99");
stub("awk", `exec "${REAL_AWK}" "$@"`);
stub("sed", `exec "${REAL_SED}" "$@"`);
stub("grep", `exec "${REAL_GREP}" "$@"`);
stub("ln", `if [ -n "\${EZ_TEST_LN_RACE_FILE:-}" ] && [ ! -e "$EZ_TEST_LN_RACE_FILE" ]; then
  {
    printf '%s\\n' 'EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml'
    printf '%s\\n' 'EZCORP_EXTENSIONS_UNSANDBOXED_ACK=I-understand-extensions-run-with-the-apps-full-powers'
  } > "$EZ_TEST_LN_RACE_FILE"
  "${REAL_CHMOD}" 644 "$EZ_TEST_LN_RACE_FILE"
fi
exec "${REAL_LN}" "$@"`);

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

interface Run { exitCode: number; stdout: string; stderr: string; calls: string[] }

function run(
  args: string[],
  env: Record<string, string>,
  opts: { stdin?: string } = {},
  extraEnv: Record<string, string> = {},
): Run {
  rmSync(CALLS, { force: true });
  const proc = Bun.spawnSync({
    cmd: [BASH, SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...env, ...extraEnv },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    calls: existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

async function runAsync(args: string[], env: Record<string, string>): Promise<Run> {
  const proc = Bun.spawn({
    cmd: [BASH, SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}`, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stdout: await stdout, stderr: await stderr, calls: [] };
}

/** A fresh scratch tree: its own env-file path and data root, nothing pre-made. */
function scratch(os: "Darwin" | "Linux"): Record<string, string> {
  const dir = mkdtempSync(join(SANDBOX, `${os}-`));
  return {
    EZ_SETUP_OS: os,
    EZ_SETUP_ENV_FILE: join(dir, "env.prod"),
    EZ_SETUP_DATA_ROOT: join(dir, "ezcorp"),
    EZ_SETUP_PODMAN_SOCKET: join(dir, "podman.sock"),
  };
}

function isolatedPathWithout(...excluded: string[]): string {
  const dir = mkdtempSync(join(SANDBOX, "path-"));
  const commands = [
    "awk",
    "bash",
    "brew",
    "cat",
    "chmod",
    "curl",
    "dirname",
    "docker",
    "docker-compose",
    "grep",
    "id",
    "ln",
    "mkdir",
    "mktemp",
    "openssl",
    "podman",
    "rm",
    "rmdir",
    "sed",
    "sleep",
    "stat",
    "systemctl",
    "tail",
    "uname",
  ];
  for (const command of commands) {
    if (excluded.includes(command)) continue;
    const stubPath = join(BIN, command);
    const source = existsSync(stubPath) ? stubPath : Bun.which(command);
    if (!source) throw new Error(`setup-podman tests require ${command} on PATH`);
    symlinkSync(source, join(dir, command));
  }
  return dir;
}

/** True only for an UNCOMMENTED `VAR=value` line. `.env.prod.example` carries
 *  the acknowledgement commented out, so a substring test on the variable name
 *  is satisfied by every fresh copy — and would pass the negative cases AND the
 *  positive case regardless of what the script did. */
function ackIsSet(text: string): boolean {
  return new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}$`, "m").test(text);
}

const PLACEHOLDERS = readFileSync(EXAMPLE, "utf8").match(/replace-with-openssl-rand-base64-\d+/g) ?? [];
const VALID_ENCRYPTION_SECRET = "valid-encryption-secret-for-setup-tests";
const VALID_ENCRYPTION_SALT = "valid-encryption-salt-for-setup-tests";
const VALID_JWT_SECRET = "valid-jwt-secret-for-setup-tests";

function validProdEnv(lines: string[] = [], publicUrl = "http://localhost:4000"): string {
  return [
    `EZCORP_ENCRYPTION_SECRET=${VALID_ENCRYPTION_SECRET}`,
    `EZCORP_ENCRYPTION_SALT=${VALID_ENCRYPTION_SALT}`,
    `EZCORP_JWT_SECRET=${VALID_JWT_SECRET}`,
    `EZCORP_PUBLIC_URL=${publicUrl}`,
    ...lines,
    "",
  ].join("\n");
}

function isolatedRunnerEnv(runnerDir: string, tokenFile: string): string {
  return validProdEnv([
    `EZ_RUNNER_SOCKET_DIR=${runnerDir}`,
    `EZ_RUNNER_TOKEN_FILE=${tokenFile}`,
    "EZ_RUNNER_GROUP=1",
  ]);
}

async function withLiveRunnerSocket<T>(runnerDir: string, runTest: () => T | Promise<T>): Promise<T> {
  mkdirSync(runnerDir, { recursive: true });
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(runnerDir, "runner.sock"), () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    return await runTest();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("setup-podman.sh — the env file", () => {
  test("parses under the selected Bash; the macOS lane selects and verifies Apple Bash 3.2", () => {
    const version = Bun.spawnSync({ cmd: [BASH, "--version"], stdout: "pipe", stderr: "pipe" });
    expect(version.exitCode).toBe(0);
    if (process.env.EZ_SETUP_REQUIRE_BASH_32 === "1") {
      expect(version.stdout.toString()).toMatch(/^GNU bash, version 3\.2\./);
    }
    expect(Bun.spawnSync({ cmd: [BASH, "-n", SCRIPT] }).exitCode).toBe(0);
  });

  test("creates it from the example with every placeholder replaced, mode 600", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);

    const text = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(PLACEHOLDERS.length).toBeGreaterThan(0);
    for (const p of PLACEHOLDERS) expect(text).not.toContain(p);
    expect(text).toContain("EZCORP_PUBLIC_URL=http://localhost:4000");
    expect(statSync(env.EZ_SETUP_ENV_FILE).mode & 0o777).toBe(0o600);
  });

  test("never places generated secrets in child argv or process output", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toContain(
      `EZCORP_ENCRYPTION_SECRET=${SECRET_SENTINEL}`,
    );
    expect([r.stdout, r.stderr, ...r.calls].join("\n")).not.toContain(SECRET_SENTINEL);
    expect(
      readdirSync(join(env.EZ_SETUP_ENV_FILE, "..")).filter((name) => name.includes(".secrets.")),
    ).toEqual([]);
  });

  test("does not rotate secrets or rewrite an already configured file on re-run", () => {
    const env = scratch("Darwin");
    run(["--no-start", "--accept-unsandboxed-extensions"], env);
    const first = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(first);
    expect(r.stdout).toContain("left byte-for-byte unchanged");
  });

  test("refuses an existing env file with group or other access and changes nothing", () => {
    const env = scratch("Darwin");
    const original = "EZCORP_ENCRYPTION_SECRET=keep-this-secret\n";
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o644 });

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("permissions");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(statSync(env.EZ_SETUP_ENV_FILE).mode & 0o777).toBe(0o644);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("revalidates a concurrently created env file and refuses unsafe permissions", () => {
    const env = scratch("Darwin");

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_LN_RACE_FILE: env.EZ_SETUP_ENV_FILE },
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unsafe permissions");
    expect(statSync(env.EZ_SETUP_ENV_FILE).mode & 0o777).toBe(0o644);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("does not publish a partial file when the example shape is invalid", () => {
    const env = scratch("Darwin");
    const dir = join(env.EZ_SETUP_ENV_FILE, "..");
    const invalidExample = join(dir, "invalid.env.example");
    writeFileSync(invalidExample, "EZCORP_PUBLIC_URL=https://ezcorp.example.com\n");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], {
      ...env,
      EZ_SETUP_ENV_EXAMPLE: invalidExample,
    });

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("placeholder substitution failed");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("env.prod.tmp."))).toBe(false);
  });

  test("refuses known production placeholders in an existing trusted-local env", () => {
    const env = scratch("Darwin");
    const original = `${readFileSync(EXAMPLE, "utf8")}
EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml
${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}
`;
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid required production values");
    expect(r.stderr).toContain("EZCORP_ENCRYPTION_SECRET");
    expect(r.stderr).toContain("EZCORP_ENCRYPTION_SALT");
    expect(r.stderr).toContain("EZCORP_JWT_SECRET");
    expect(r.stderr).toContain("EZCORP_PUBLIC_URL");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("refuses known production placeholders in an existing isolated-runner env", () => {
    const env = scratch("Linux");
    const original = readFileSync(EXAMPLE, "utf8").replace(
      /^EZ_RUNNER_GROUP=$/m,
      "EZ_RUNNER_GROUP=1",
    );
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid required production values");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("refuses a missing required production secret without changing the file", () => {
    const env = scratch("Darwin");
    const original = validProdEnv([
      "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
      `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
    ]).replace(/^EZCORP_ENCRYPTION_SALT=.*\n/m, "");
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EZCORP_ENCRYPTION_SALT");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
  });

  test("rejects a placeholder shell override even when the file value is safe", () => {
    const env = scratch("Darwin");
    const original = validProdEnv([
      "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
      `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
    ]);
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(
      ["--no-start"],
      { ...env, EZCORP_JWT_SECRET: "replace-with-openssl-rand-base64-32" },
    );

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EZCORP_JWT_SECRET");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
  });

  test.each([
    "not-a-url",
    "ftp://chat.example.com",
    "http://",
    "http://bad host.example.com",
    "http://[broken",
    "https://chat.example.com:65536",
  ])("refuses malformed production public URL %s without changing the file", (publicUrl) => {
    const env = scratch("Darwin");
    const original = validProdEnv(
      [
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
      ],
      publicUrl,
    );
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("EZCORP_PUBLIC_URL");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("pre-creates the four bind-mount sources without any chown", () => {
    const env = scratch("Darwin");
    run(["--no-start", "--accept-unsandboxed-extensions"], env);
    for (const d of ["data", "extensions", "extension-data", "projects"]) {
      expect(existsSync(join(env.EZ_SETUP_DATA_ROOT, d))).toBe(true);
    }
  });
});

describe("setup-podman.sh — the unsandboxed-extensions decision", () => {
  test("macOS, non-interactive, no flag: refuses and names the flag; writes nothing", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start"], env);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--accept-unsandboxed-extensions");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("macOS with the flag: writes the exact sentence runner-mode.ts compares against", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    const text = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(ackIsSet(text)).toBe(true);
    expect(text).toMatch(/^EZCORP_RUNNER_COMPOSE_FILE=deploy\/extension-runner\/compose\.trusted-local\.yml$/m);
  });

  test("never rewrites an existing env file and prints the exact manual trusted-local lines", () => {
    const env = scratch("Darwin");
    const original = validProdEnv([
      "# operator-owned production settings",
      "CUSTOM_VALUE=with spaces and # literal text",
    ]);
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(2);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(r.stderr).toContain("Existing environment files are never modified");
    expect(r.stderr).toContain("EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml");
    expect(r.stderr).toContain(`${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`);
    expect(statSync(env.EZ_SETUP_ENV_FILE).mode & 0o777).toBe(0o600);
  });

  test("--check stops at an incomplete existing runner instead of claiming it would start", () => {
    const env = scratch("Darwin");
    const original = validProdEnv(["# runner decision is intentionally unresolved"]);
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--check"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Existing environment files are never modified");
    expect(r.stdout).not.toContain("bind-mount directories");
    expect(r.stdout).not.toContain("would run: bash scripts/podman-compose.sh");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
  });

  test("concurrent accepted runs publish one complete trusted-local block", async () => {
    const env = scratch("Darwin");
    rmSync(CALLS, { force: true });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(["--no-start", "--accept-unsandboxed-extensions"], env)),
    );

    expect(results.map((result) => result.exitCode)).toEqual(Array(8).fill(0));
    const updated = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(updated.match(/^EZCORP_RUNNER_COMPOSE_FILE=/gm)?.length).toBe(1);
    expect(updated.match(new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=`, "gm"))?.length).toBe(1);
    expect(updated.endsWith(`${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}\n`)).toBe(true);
    expect(
      readdirSync(join(env.EZ_SETUP_ENV_FILE, "..")).filter((name) =>
        name.includes(".tmp.") || name.includes(".secrets.") || name.includes(".watchdog.") || name.includes(".ready.")
      ),
    ).toEqual([]);
  });

  test("the exact Compose path without the exact acknowledgement is not configured", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=wrong`,
      ]),
      { mode: 0o600 },
    );
    const original = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(ackIsSet(original)).toBe(false);
  });

  test("Linux never lets an invalid trusted-local override fall through to stale isolated values", () => {
    const env = scratch("Linux");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=wrong`,
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=1",
      ]),
      { mode: 0o600 },
    );

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).not.toMatch(
      new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}$`, "m"),
    );
  });

  test("an unrelated Compose override does not count as trusted-local configuration", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZCORP_RUNNER_COMPOSE_FILE=custom-compose.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
      ]),
      { mode: 0o600 },
    );
    const original = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
  });

  test("macOS does not mistake isolated Linux runner values for a usable runner", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=1",
      ]),
      { mode: 0o600 },
    );
    const original = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
  });

  test("macOS, a pipe on stdin carrying 'y': is NOT consent — fails closed", () => {
    // A pipe is not a TTY. Without the test-only seam the script must not
    // reach the prompt at all, even when the pipe says yes.
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "y\n" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not a terminal");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("macOS prompt, answered 'n': shows the consequence, writes nothing, changes nothing else", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "n\n" }, { EZ_SETUP_FORCE_TTY: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("blast radius");
    expect(r.stdout).toContain("[y/N]");
    expect(r.stderr).toContain("stopped at your request");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("macOS prompt, answered 'y': writes the acknowledgement", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "y\n" }, { EZ_SETUP_FORCE_TTY: "1" });
    expect(r.exitCode).toBe(0);
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(true);
  });

  test("macOS prompt, empty answer (just Enter): the default is No", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "\n" }, { EZ_SETUP_FORCE_TTY: "1" });
    expect(r.exitCode).toBe(1);
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("Linux by default: explains both options and stops — never downgrades to unsandboxed", () => {
    const env = scratch("Linux");
    const r = run(["--no-start"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Isolated runner");
    expect(r.stderr).toContain("EZ_RUNNER_SOCKET_DIR");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("Linux with a provisioned runner already in the env file: leaves it alone", async () => {
    const env = scratch("Linux");
    const runnerDir = join(env.EZ_SETUP_ENV_FILE, "..", "runner");
    const runnerToken = join(runnerDir, "runner-token");
    mkdirSync(runnerDir, { recursive: true });
    writeFileSync(runnerToken, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    // A PROVISIONED runner is all three values. The example ships two of them
    // pre-filled with EZ_RUNNER_GROUP empty, which is precisely the state the
    // script must NOT mistake for configured.
    writeFileSync(env.EZ_SETUP_ENV_FILE, isolatedRunnerEnv(runnerDir, runnerToken), { mode: 0o600 });
    await withLiveRunnerSocket(runnerDir, () => {
      const r = run(["--no-start"], env);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("already configured");
      expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
    });
  });

  test("Linux rejects runner credential sources that production cannot read", async () => {
    const env = scratch("Linux");
    const runnerDir = join(env.EZ_SETUP_ENV_FILE, "..", "runner");
    const tokenDir = join(runnerDir, "token-directory");
    const shortToken = join(runnerDir, "short-token");
    const unsafeToken = join(runnerDir, "unsafe-token");
    const symlinkTarget = join(runnerDir, "symlink-target");
    const symlinkToken = join(runnerDir, "symlink-token");
    const oversizedToken = join(runnerDir, "oversized-token");
    const whitespaceToken = join(runnerDir, "whitespace-token");
    const nulToken = join(runnerDir, "nul-token");
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(shortToken, "too-short\n", { mode: 0o600 });
    writeFileSync(unsafeToken, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    chmodSync(unsafeToken, 0o620);
    writeFileSync(symlinkTarget, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
    symlinkSync(symlinkTarget, symlinkToken);
    writeFileSync(oversizedToken, `${"a".repeat(4097)}\n`, { mode: 0o600 });
    writeFileSync(whitespaceToken, "0123456789abcdef 123456789abcdef0\n", { mode: 0o600 });
    writeFileSync(nulToken, Buffer.from(`0123456789abcdef0123456789abcdef\0`), { mode: 0o600 });

    await withLiveRunnerSocket(runnerDir, () => {
      for (const tokenFile of [
        tokenDir,
        shortToken,
        unsafeToken,
        symlinkToken,
        oversizedToken,
        whitespaceToken,
        nulToken,
        "relative-token",
      ]) {
        const original = isolatedRunnerEnv(runnerDir, tokenFile);
        writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });
        const r = run(["--no-start"], env);
        expect({ tokenFile, exitCode: r.exitCode }).toEqual({ tokenFile, exitCode: 2 });
        expect(r.stdout).not.toContain("already configured");
        expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
      }
    });
  });

  test("Linux does not call runner path strings provisioned when the host objects are absent", () => {
    const env = scratch("Linux");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZ_RUNNER_SOCKET_DIR=/missing/runner-directory",
        "EZ_RUNNER_TOKEN_FILE=/missing/runner-token",
        "EZ_RUNNER_GROUP=not-a-number",
      ]),
      { mode: 0o600 },
    );

    const r = run(["--no-start"], env);

    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("provision");
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
  });

  test("the example's pre-filled paths with an EMPTY group do not count as configured", () => {
    // This is what a fresh copy of .env.prod.example looks like, and it is
    // exactly what compose.prod.yml's `${EZ_RUNNER_GROUP:?}` rejects. The
    // first version of the script tested for the variable's presence and
    // skipped the decision on every fresh install.
    const env = scratch("Linux");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv([
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=",
      ]),
      { mode: 0o600 },
    );
    const r = run(["--no-start"], env);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toMatch(/^EZ_RUNNER_GROUP=$/m);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
  });
});

describe("setup-podman.sh — the engine and the check mode", () => {
  test("macOS with everything installed and running: installs and starts nothing", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.calls.some((c) => c.startsWith("brew install"))).toBe(false);
    expect(r.calls.some((c) => /podman machine (init|start)/.test(c))).toBe(false);
  });

  test("macOS accepts a working docker compose plugin without Homebrew or standalone Compose", () => {
    const env = scratch("Darwin");
    const path = isolatedPathWithout("brew", "docker-compose");

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_DOCKER_COMPOSE_WORKS: "1", PATH: path },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("docker compose version");
    expect(r.calls.some((call) => call.startsWith("brew "))).toBe(false);
  });

  test("macOS installs and verifies standalone Compose when no Compose client works", () => {
    const env = scratch("Darwin");
    const path = isolatedPathWithout("docker", "docker-compose");

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      {
        EZ_TEST_BREW_BIN: path,
        EZ_TEST_BREW_COMPOSE_SOURCE: join(BIN, "docker-compose"),
        PATH: path,
      },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("brew install docker-compose");
    expect(r.calls).toContain("docker-compose version");
  });

  test("macOS rejects Compose executables that cannot answer the version probe", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_DOCKER_COMPOSE_WORKS: "0", EZ_TEST_STANDALONE_COMPOSE_WORKS: "0" },
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("working Compose CLI");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("macOS installs Podman when it is missing", () => {
    const env = scratch("Darwin");
    const path = isolatedPathWithout("podman");

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      {
        EZ_TEST_BREW_BIN: path,
        EZ_TEST_BREW_PODMAN_SOURCE: join(BIN, "podman"),
        EZ_TEST_MACHINE_STATE: "none",
        PATH: path,
      },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("brew install podman");
    expect(r.calls).toContain("podman machine init --cpus 4 --memory 8192 --disk-size 60");
    expect(r.calls).toContain("podman machine start");
  });

  test("macOS starts an existing stopped Podman machine", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_MACHINE_STATE: "stopped" },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("podman machine start");
    expect(r.calls.some((call) => call.startsWith("podman machine init"))).toBe(false);
  });

  test("macOS initializes and starts a machine when none exists", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_MACHINE_STATE: "none" },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("podman machine init --cpus 4 --memory 8192 --disk-size 60");
    expect(r.calls).toContain("podman machine start");
  });

  test("Linux without a socket: enables the systemd user socket, no brew", () => {
    const env = scratch("Linux");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.calls).toContain("systemctl --user enable --now podman.socket");
    expect(r.calls.some((c) => c.startsWith("brew"))).toBe(false);
  });

  test("Linux probes docker compose and falls back to a working standalone CLI", () => {
    const env = scratch("Linux");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("docker compose version");
    expect(r.calls).toContain("docker-compose version");
  });

  test("Linux refuses a docker executable whose Compose plugin is unavailable", () => {
    const env = scratch("Linux");
    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_STANDALONE_COMPOSE_WORKS: "0" },
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Compose CLI is required");
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
  });

  test("--check with an accepted runner changes nothing on disk and calls no engine", () => {
    const env = scratch("Darwin");
    const r = run(["--check", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
    expect(
      r.calls.filter((c) =>
        !c.startsWith("podman machine list") &&
        !c.startsWith("grep ") &&
        !c.startsWith("docker compose version") &&
        !c.startsWith("docker-compose version")
      ),
    ).toEqual([]);
  });

  test("--check reports an already accepted fresh trusted-local choice", () => {
    const env = scratch("Linux");
    const r = run(["--check", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("would add trusted-local");
    expect(r.stdout).not.toContain("select an isolated runner");
  });

  test("Linux --check reports the Linux runner decision", () => {
    const env = scratch("Linux");
    const r = run(["--check"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("on Linux select an isolated runner");
    expect(r.stdout).not.toContain("on macOS this script would ask");
    expect(r.stdout).not.toContain("bind-mount directories");
    expect(r.stdout).not.toContain("would run: bash scripts/podman-compose.sh");
  });
});

describe("setup-podman.sh — start and readiness", () => {
  test("starts the production stack and exits when readiness returns a body", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_CURL_SUCCESS: "1" },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("bash scripts/podman-compose.sh --prod up -d --build");
    expect(r.calls.some((call) => call.startsWith("curl "))).toBe(true);
    expect(r.calls.some((call) => call.startsWith("sleep "))).toBe(false);
    expect(r.stdout).toContain('ready: {"ready":true}');
  });

  test("derives readiness from the host port and the admin URL from the public URL", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv(
        [
          "EZCORP_PORT_HOST=5123",
          "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
          `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
        ],
        "https://chat.example.com",
      ),
      { mode: 0o600 },
    );

    const r = run([], env, {}, { EZ_TEST_CURL_SUCCESS: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("curl -fsS --max-time 5 http://localhost:5123/api/ready");
    expect(r.stdout).toContain("Open https://chat.example.com and create the admin account");
  });

  test("an explicit readiness URL overrides the env file's host port", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv(
        [
          "EZCORP_PORT_HOST=5123",
          "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
          `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
        ],
        "https://chat.example.com",
      ),
      { mode: 0o600 },
    );
    const readyUrl = "http://127.0.0.1:6123/custom-ready";

    const r = run([], { ...env, EZ_SETUP_READY_URL: readyUrl }, {}, { EZ_TEST_CURL_SUCCESS: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain(`curl -fsS --max-time 5 ${readyUrl}`);
    expect(r.calls.some((call) => call.includes("localhost:5123"))).toBe(false);
    expect(r.stdout).toContain("Open https://chat.example.com and create the admin account");
    expect(r.stdout).not.toContain(`Open ${readyUrl}`);
  });

  test("uses shell overrides before env-file values for readiness and the admin URL", () => {
    const env = scratch("Darwin");
    const prepared = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(prepared.exitCode).toBe(0);

    const r = run(
      [],
      {
        ...env,
        EZCORP_PORT_HOST: "6123",
        EZCORP_PUBLIC_URL: "https://shell-override.example.com",
      },
      {},
      { EZ_TEST_CURL_SUCCESS: "1" },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("curl -fsS --max-time 5 http://localhost:6123/api/ready");
    expect(r.calls.some((call) => call.includes("localhost:4000"))).toBe(false);
    expect(r.stdout).toContain("Open https://shell-override.example.com and create the admin account");
  });

  test("reads quoted Compose scalars when deriving readiness and the admin URL", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      validProdEnv(
        [
          'EZCORP_PORT_HOST="5123" # custom published port',
          "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
          `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
        ],
        '"https://quoted.example.com" # operator URL',
      ),
      { mode: 0o600 },
    );

    const r = run([], env, {}, { EZ_TEST_CURL_SUCCESS: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("curl -fsS --max-time 5 http://localhost:5123/api/ready");
    expect(r.stdout).toContain("Open https://quoted.example.com and create the admin account");
  });

  test("fast failed probes do not consume the advertised readiness duration", () => {
    const env = scratch("Darwin");
    const countFile = join(env.EZ_SETUP_ENV_FILE, "..", "curl-count");
    const r = run(
      ["--accept-unsandboxed-extensions"],
      { ...env, EZ_SETUP_READY_TIMEOUT: "7" },
      {},
      {
        EZ_TEST_CURL_COUNT_FILE: countFile,
        EZ_TEST_CURL_SUCCEED_AFTER: "3",
        EZ_TEST_FAST_SLEEP: "1",
      },
    );

    expect(r.exitCode).toBe(0);
    expect(r.calls.filter((call) => call.startsWith("curl "))).toHaveLength(3);
    expect(readFileSync(countFile, "utf8")).toBe("3\n");
    expect(r.calls.some((call) => call.startsWith("date "))).toBe(false);
    expect(r.stdout).toContain('ready: {"ready":true}');
  });

  test("the watchdog ends readiness without consulting the wall clock", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--accept-unsandboxed-extensions"],
      { ...env, EZ_SETUP_READY_TIMEOUT: "1" },
    );

    expect(r.exitCode).toBe(1);
    expect(r.calls.some((call) => call.startsWith("curl "))).toBe(true);
    expect(r.calls.some((call) => call.startsWith("date "))).toBe(false);
    expect(r.stderr).toContain("within 1s");
  });
});
