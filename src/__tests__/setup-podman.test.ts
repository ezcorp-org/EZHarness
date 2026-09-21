import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 *    unreadable, so an accepted runner update must preserve the existing
 *    bytes and a configured re-run must not rewrite them. Held here by both
 *    cases, including concurrent setup processes.
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
const REAL_MV = Bun.which("mv") ?? (() => {
  throw new Error("setup-podman tests require mv on PATH");
})();
const REAL_CMP = Bun.which("cmp") ?? (() => {
  throw new Error("setup-podman tests require cmp on PATH");
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
stub("brew", "exit 0");
stub("podman", 'case "$1 $2" in "machine list") echo "NAME  VM TYPE  CREATED  LAST UP"; echo "podman-machine-default  applehv  1 hour ago  Currently running";; esac; exit 0');
stub("docker", `[ "$1 $2" = "compose version" ] && [ "\${EZ_TEST_DOCKER_COMPOSE_WORKS:-0}" = 1 ]`);
stub("docker-compose", `[ "$1" = version ] && [ "\${EZ_TEST_STANDALONE_COMPOSE_WORKS:-1}" = 1 ]`);
stub("systemctl", "exit 0");
stub("bash", "exit 0");
stub("openssl", `printf '%s\\n' '${SECRET_SENTINEL}'`);
stub("curl", `[ "\${EZ_TEST_CURL_SUCCESS:-0}" = 1 ] && printf '%s\\n' '{"ready":true}'`);
stub("sleep", `[ "\${EZ_TEST_FAST_SLEEP:-0}" = 1 ] && exit 0
exec "${REAL_SLEEP}" "$@"`);
stub("date", "exit 99");
stub("mv", `[ "\${EZ_TEST_MV_FAIL:-0}" != 1 ] || exit 73
exec "${REAL_MV}" "$@"`);
stub("cmp", `[ -z "\${EZ_TEST_DRIFT_FILE:-}" ] || printf '%s\\n' 'EXTERNAL_SETTING=must-survive' > "$EZ_TEST_DRIFT_FILE"
exec "${REAL_CMP}" "$@"`);
stub("awk", `exec "${REAL_AWK}" "$@"`);
stub("sed", `exec "${REAL_SED}" "$@"`);
stub("grep", `exec "${REAL_GREP}" "$@"`);

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

/** True only for an UNCOMMENTED `VAR=value` line. `.env.prod.example` carries
 *  the acknowledgement commented out, so a substring test on the variable name
 *  is satisfied by every fresh copy — and would pass the negative cases AND the
 *  positive case regardless of what the script did. */
function ackIsSet(text: string): boolean {
  return new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}$`, "m").test(text);
}

const PLACEHOLDERS = readFileSync(EXAMPLE, "utf8").match(/replace-with-openssl-rand-base64-\d+/g) ?? [];

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
    expect(r.stdout).toContain("left as is");
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
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
  });

  test("macOS with the flag: writes the exact sentence runner-mode.ts compares against", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    const text = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(ackIsSet(text)).toBe(true);
    expect(text).toMatch(/^EZCORP_RUNNER_COMPOSE_FILE=deploy\/extension-runner\/compose\.trusted-local\.yml$/m);
  });

  test("adds trusted-local atomically while preserving every byte of a pre-existing env file", () => {
    const env = scratch("Darwin");
    const original = [
      "# operator-owned production settings",
      "EZCORP_ENCRYPTION_SECRET=a-secret-that-must-survive",
      "EZCORP_JWT_SECRET=another-secret-that-must-survive",
      "CUSTOM_VALUE=with spaces and # literal text",
      "",
    ].join("\n");
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    const updated = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("EZCORP_ENCRYPTION_SECRET=a-secret-that-must-survive");
    expect(updated).toContain("EZCORP_JWT_SECRET=another-secret-that-must-survive");
    expect(ackIsSet(updated)).toBe(true);
    expect(statSync(env.EZ_SETUP_ENV_FILE).mode & 0o777).toBe(0o600);
  });

  test("a failed atomic install leaves the original env file byte-for-byte unchanged", () => {
    const env = scratch("Darwin");
    const original = "EZCORP_ENCRYPTION_SECRET=keep-this-secret\n";
    writeFileSync(env.EZ_SETUP_ENV_FILE, original, { mode: 0o600 });

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_MV_FAIL: "1" },
    );

    expect(r.exitCode).not.toBe(0);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(original);
    expect(readdirSync(join(env.EZ_SETUP_ENV_FILE, "..")).filter((name) => name.includes("trusted-local"))).toEqual([]);
  });

  test("refuses an external edit made after the snapshot and preserves that edit", () => {
    const env = scratch("Darwin");
    writeFileSync(env.EZ_SETUP_ENV_FILE, "ORIGINAL_SETTING=keep\n", { mode: 0o600 });

    const r = run(
      ["--no-start", "--accept-unsandboxed-extensions"],
      env,
      {},
      { EZ_TEST_DRIFT_FILE: env.EZ_SETUP_ENV_FILE },
    );

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("changed while trusted-local was being prepared");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe("EXTERNAL_SETTING=must-survive\n");
    expect(
      readdirSync(join(env.EZ_SETUP_ENV_FILE, "..")).filter((name) =>
        name.includes("snapshot") || name.includes("trusted-local") || name.includes("setup.lock")
      ),
    ).toEqual([]);
  });

  test("concurrent accepted runs publish one complete trusted-local block", async () => {
    const env = scratch("Darwin");
    writeFileSync(env.EZ_SETUP_ENV_FILE, "EZCORP_ENCRYPTION_SECRET=keep-this-secret\n", { mode: 0o600 });
    rmSync(CALLS, { force: true });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(["--no-start", "--accept-unsandboxed-extensions"], env)),
    );

    expect(results.map((result) => result.exitCode)).toEqual(Array(8).fill(0));
    const updated = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(updated.match(/^EZCORP_RUNNER_COMPOSE_FILE=/gm)?.length).toBe(1);
    expect(updated.match(new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=`, "gm"))?.length).toBe(1);
    expect(updated.endsWith(`${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}\n`)).toBe(true);
    expect(readdirSync(join(env.EZ_SETUP_ENV_FILE, "..")).filter((name) => name.includes("setup.lock") || name.includes("trusted-local"))).toEqual([]);
  });

  test("the exact Compose path without the exact acknowledgement is not configured", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      `EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml\n${UNSANDBOXED_ACK_VARIABLE}=wrong\n`,
      { mode: 0o600 },
    );

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("already configured");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(true);
  });

  test("Linux never lets an invalid trusted-local override fall through to stale isolated values", () => {
    const env = scratch("Linux");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      [
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=wrong`,
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=1",
        "",
      ].join("\n"),
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
      `EZCORP_RUNNER_COMPOSE_FILE=custom-compose.yml\n${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}\n`,
      { mode: 0o600 },
    );

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("already configured");
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toMatch(
      /^EZCORP_RUNNER_COMPOSE_FILE=deploy\/extension-runner\/compose\.trusted-local\.yml$/m,
    );
  });

  test("macOS does not mistake isolated Linux runner values for a usable runner", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      [
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("already configured");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(true);
  });

  test("macOS, a pipe on stdin carrying 'y': is NOT consent — fails closed", () => {
    // A pipe is not a TTY. Without the test-only seam the script must not
    // reach the prompt at all, even when the pipe says yes.
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "y\n" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not a terminal");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
  });

  test("macOS prompt, answered 'n': shows the consequence, writes nothing, changes nothing else", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start"], env, { stdin: "n\n" }, { EZ_SETUP_FORCE_TTY: "1" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("blast radius");
    expect(r.stdout).toContain("[y/N]");
    expect(r.stderr).toContain("stopped at your request");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
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
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
  });

  test("Linux by default: explains both options and stops — never downgrades to unsandboxed", () => {
    const env = scratch("Linux");
    const r = run(["--no-start"], env);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Isolated runner");
    expect(r.stderr).toContain("EZ_RUNNER_SOCKET_DIR");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
  });

  test("Linux with a provisioned runner already in the env file: leaves it alone", () => {
    const env = scratch("Linux");
    mkdirSync(join(env.EZ_SETUP_ENV_FILE, ".."), { recursive: true });
    // A PROVISIONED runner is all three values. The example ships two of them
    // pre-filled with EZ_RUNNER_GROUP empty, which is precisely the state the
    // script must NOT mistake for configured.
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      [
        "EZ_RUNNER_SOCKET_DIR=/run/ez-extension-runner",
        "EZ_RUNNER_TOKEN_FILE=/etc/ezharness/extension-runner-token",
        "EZ_RUNNER_GROUP=1",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const r = run(["--no-start"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("already configured");
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(false);
  });

  test("the example's pre-filled paths with an EMPTY group do not count as configured", () => {
    // This is what a fresh copy of .env.prod.example looks like, and it is
    // exactly what compose.prod.yml's `${EZ_RUNNER_GROUP:?}` rejects. The
    // first version of the script tested for the variable's presence and
    // skipped the decision on every fresh install.
    const env = scratch("Linux");
    const r = run(["--no-start"], env);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toMatch(/^EZ_RUNNER_GROUP=$/m);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("already configured");
  });

  test("recovers a lock left by a dead setup PID", () => {
    const env = scratch("Darwin");
    writeFileSync(env.EZ_SETUP_ENV_FILE, "ORIGINAL_SETTING=keep\n", { mode: 0o600 });
    const lock = `${env.EZ_SETUP_ENV_FILE}.setup.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.99999999"), "", { mode: 0o600 });

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("recovered stale setup lock");
    expect(existsSync(lock)).toBe(false);
    expect(ackIsSet(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8"))).toBe(true);
  });

  test("concurrent runs safely recover one dead-owner lock", async () => {
    const env = scratch("Darwin");
    writeFileSync(env.EZ_SETUP_ENV_FILE, "ORIGINAL_SETTING=keep\n", { mode: 0o600 });
    const lock = `${env.EZ_SETUP_ENV_FILE}.setup.lock`;
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.99999999"), "", { mode: 0o600 });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => runAsync(["--no-start", "--accept-unsandboxed-extensions"], env)),
    );

    expect(results.map((result) => result.exitCode)).toEqual(Array(8).fill(0));
    const updated = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");
    expect(updated.match(/^EZCORP_RUNNER_COMPOSE_FILE=/gm)?.length).toBe(1);
    expect(updated.match(new RegExp(`^${UNSANDBOXED_ACK_VARIABLE}=`, "gm"))?.length).toBe(1);
    expect(existsSync(lock)).toBe(false);
  });
});

describe("setup-podman.sh — the engine and the check mode", () => {
  test("macOS with everything installed and running: installs and starts nothing", () => {
    const env = scratch("Darwin");
    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.calls.some((c) => c.startsWith("brew install"))).toBe(false);
    expect(r.calls.some((c) => /podman machine (init|start)/.test(c))).toBe(false);
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

  test("--check changes nothing on disk and calls no engine", () => {
    const env = scratch("Darwin");
    const r = run(["--check"], env);
    expect(r.exitCode).toBe(0);
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
    expect(
      r.calls.filter((c) => !c.startsWith("podman machine list") && !c.startsWith("grep ")),
    ).toEqual([]);
  });

  test("Linux --check reports the Linux runner decision", () => {
    const env = scratch("Linux");
    const r = run(["--check"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("on Linux select an isolated runner");
    expect(r.stdout).not.toContain("on macOS this script would ask");
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

  test("derives readiness and the completion URL from the documented host port", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      [
        "EZCORP_PORT_HOST=5123",
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    const r = run([], env, {}, { EZ_TEST_CURL_SUCCESS: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain("curl -fsS --max-time 5 http://localhost:5123/api/ready");
    expect(r.stdout).toContain("Open http://localhost:5123 and create the admin account");
  });

  test("an explicit readiness URL overrides the env file's host port", () => {
    const env = scratch("Darwin");
    writeFileSync(
      env.EZ_SETUP_ENV_FILE,
      [
        "EZCORP_PORT_HOST=5123",
        "EZCORP_RUNNER_COMPOSE_FILE=deploy/extension-runner/compose.trusted-local.yml",
        `${UNSANDBOXED_ACK_VARIABLE}=${UNSANDBOXED_ACK_SENTENCE}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const readyUrl = "http://127.0.0.1:6123/custom-ready";

    const r = run([], { ...env, EZ_SETUP_READY_URL: readyUrl }, {}, { EZ_TEST_CURL_SUCCESS: "1" });

    expect(r.exitCode).toBe(0);
    expect(r.calls).toContain(`curl -fsS --max-time 5 ${readyUrl}`);
    expect(r.calls.some((call) => call.includes("localhost:5123"))).toBe(false);
  });

  test("counts curl time toward the deadline and caps the final sleep", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--accept-unsandboxed-extensions"],
      { ...env, EZ_SETUP_READY_TIMEOUT: "7" },
      {},
      { EZ_TEST_FAST_SLEEP: "1" },
    );

    expect(r.exitCode).toBe(1);
    expect(r.calls.filter((call) => call.startsWith("curl "))).toEqual([
      `curl -fsS --max-time 5 ${env.EZ_SETUP_READY_URL ?? "http://localhost:4000/api/ready"}`,
    ]);
    expect(r.calls.filter((call) => call.startsWith("sleep "))).toEqual(["sleep 2"]);
    expect(r.calls.some((call) => call.startsWith("date "))).toBe(false);
    expect(r.stderr).toContain("within 7s");
  });

  test("caps curl itself when the deadline is less than five seconds away", () => {
    const env = scratch("Darwin");
    const r = run(
      ["--accept-unsandboxed-extensions"],
      { ...env, EZ_SETUP_READY_TIMEOUT: "3" },
      {},
      { EZ_TEST_FAST_SLEEP: "1" },
    );

    expect(r.exitCode).toBe(1);
    expect(r.calls.filter((call) => call.startsWith("curl "))).toEqual([
      "curl -fsS --max-time 3 http://localhost:4000/api/ready",
    ]);
    expect(r.calls.some((call) => call.startsWith("sleep "))).toBe(false);
    expect(r.calls.some((call) => call.startsWith("date "))).toBe(false);
  });
});
