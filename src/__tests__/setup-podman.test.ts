import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 *    unreadable, so the script's most important property is that the file,
 *    once it exists, is never rewritten. Held here by running twice.
 * 2. The unsandboxed-extensions acknowledgement gets written without being
 *    asked for. The sentence is imported from runner-mode.ts so it cannot
 *    drift, AND the script must refuse to write it non-interactively unless
 *    the flag is passed — on macOS. On Linux it must never be written by
 *    default at all: that host can run the isolated runner and downgrading it
 *    silently is the failure the acknowledgement exists to prevent.
 * 3. The script quietly requires bash 4 (associative arrays, mapfile) and so
 *    fails on the shell macOS ships. Every case here runs under /bin/bash,
 *    which on a macOS runner IS 3.2 and on Linux is whatever is installed —
 *    either way the script has to work under it.
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

const SANDBOX = mkdtempSync(join(tmpdir(), "setup-podman-"));
const BIN = join(SANDBOX, "bin");
const CALLS = join(SANDBOX, "calls.log");
mkdirSync(BIN, { recursive: true });

// Stubs record their argv and answer the few probes the script makes.
// `podman machine list` reports a running machine so no init/start happens.
function stub(name: string, body: string) {
  writeFileSync(join(BIN, name), `#!/bin/sh\necho "${name} $*" >> "${CALLS}"\n${body}\n`);
  chmodSync(join(BIN, name), 0o755);
}
stub("brew", "exit 0");
stub("podman", 'case "$1 $2" in "machine list") echo "NAME  VM TYPE  CREATED  LAST UP"; echo "podman-machine-default  applehv  1 hour ago  Currently running";; esac; exit 0');
stub("docker-compose", "exit 0");
stub("systemctl", "exit 0");

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
    cmd: ["/bin/bash", SCRIPT, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${BIN}:/usr/bin:/bin`, ...env, ...extraEnv },
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

/** A fresh scratch tree: its own env-file path and data root, nothing pre-made. */
function scratch(os: "Darwin" | "Linux"): Record<string, string> {
  const dir = mkdtempSync(join(SANDBOX, `${os}-`));
  return {
    EZ_SETUP_OS: os,
    EZ_SETUP_ENV_FILE: join(dir, "env.prod"),
    EZ_SETUP_DATA_ROOT: join(dir, "ezcorp"),
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

  test("NEVER rewrites an existing file — the secrets survive a re-run byte for byte", () => {
    const env = scratch("Darwin");
    run(["--no-start", "--accept-unsandboxed-extensions"], env);
    const first = readFileSync(env.EZ_SETUP_ENV_FILE, "utf8");

    const r = run(["--no-start", "--accept-unsandboxed-extensions"], env);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(env.EZ_SETUP_ENV_FILE, "utf8")).toBe(first);
    expect(r.stdout).toContain("left untouched");
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

  test("--check changes nothing on disk and calls no engine", () => {
    const env = scratch("Darwin");
    const r = run(["--check"], env);
    expect(r.exitCode).toBe(0);
    expect(existsSync(env.EZ_SETUP_ENV_FILE)).toBe(false);
    expect(existsSync(env.EZ_SETUP_DATA_ROOT)).toBe(false);
    expect(r.calls.filter((c) => !c.startsWith("podman machine list"))).toEqual([]);
  });
});
