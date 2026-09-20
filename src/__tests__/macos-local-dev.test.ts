import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Covers the two artifacts that make the local suite usable on macOS:
 * `scripts/test-linux.sh` (run the pool in a Linux container) and the bash-4
 * guard at the top of `scripts/lib/test-file-sets.sh`.
 *
 * ## The bugs these exist to prevent
 *
 * 1. A Mac developer runs `bun run test` and gets 115 red files that have
 *    nothing to do with their change — `prlimit`/`flock`/`setsid` missing and
 *    `/proc/self/fd` absent. The container script is the supported way out,
 *    and its two `node_modules` masks are what keep the host's macOS-native
 *    installs from leaking into the Linux container (18 further failures when
 *    they do).
 * 2. `/bin/bash` on macOS is 3.2, which has no associative arrays, so the
 *    pool dies with `declare: -A: invalid option` from deep inside a sourced
 *    library and names no fix.
 *
 * ## Why this is not a tautology
 *
 * The script assertions drive the REAL script with a stub engine on $PATH and
 * read back the argv it would have exec'd, rather than grepping the source for
 * the flags — so a flag that moves, is quoted wrong, or is dropped by a later
 * edit fails here. The guard assertions hold the guard's POSITION against the
 * construct it protects (the first `declare -A`), which is the property that
 * actually matters: a guard placed after it never runs.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "test-linux.sh");
const FILE_SETS = join(REPO_ROOT, "scripts", "lib", "test-file-sets.sh");

const SANDBOX = mkdtempSync(join(tmpdir(), "macos-local-dev-"));
const BIN = join(SANDBOX, "bin");
mkdirSync(BIN, { recursive: true });

// Stub engine: answers the image-presence probe so the script skips its build
// step, then records the argv of the `run` it would have exec'd.
writeFileSync(
  join(BIN, "podman"),
  [
    "#!/usr/bin/env bash",
    'if [ "$1" = "image" ]; then exit 0; fi',
    'printf "ARGV=%s\\n" "$*"',
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "podman"), 0o755);

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

function run(args: string[] = []): { exitCode: number; argv: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      EZCORP_CONTAINER_ENGINE: "podman",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  return {
    exitCode: proc.exitCode,
    argv: stdout.match(/^ARGV=(.*)$/m)?.[1] ?? "",
    stderr: proc.stderr.toString(),
  };
}

describe("scripts/test-linux.sh — the invocation it guarantees", () => {
  test("mounts the working tree and masks BOTH node_modules trees with volumes", () => {
    const { exitCode, argv } = run();
    expect(exitCode).toBe(0);

    // The working tree, not the image's stale COPY of it.
    expect(argv).toContain(`${REPO_ROOT}:/repo`);
    expect(argv).toContain("-w /repo");

    // Masks: without these the container reuses the host's macOS-native
    // installs and fails on multi-platform packages.
    expect(argv).toMatch(/:\/repo\/node_modules\b/);
    expect(argv).toMatch(/:\/repo\/web\/node_modules\b/);
  });

  test("defaults to the backend pool as three argv words, not one", () => {
    // `"${@:-bun run test}"` would pass the default as a single argument and
    // the exec inside the container would look for a program called
    // "bun run test".
    expect(run().argv).toMatch(/\bbun run test\b/);
    expect(run().argv).not.toMatch(/'bun run test'|"bun run test"/);
  });

  test("passes a caller's command through instead of the default", () => {
    const { argv } = run(["bun", "run", "typecheck"]);
    expect(argv).toMatch(/\bbun run typecheck\b/);
    expect(argv).not.toMatch(/\bbun run test\b/);
  });

  test("keeps bun's install cache out of the bind-mounted tree", () => {
    // Bun defaults the cache to <cwd>/.bun, and cwd is the repo — so an unset
    // cache dir leaves a .bun/ directory in the developer's working tree on
    // every run.
    const { argv } = run();
    expect(argv).toMatch(/BUN_INSTALL_CACHE_DIR=\/(?!repo\b)/);
  });

  test("installs both dependency trees from their frozen lockfiles", () => {
    const { argv } = run();
    expect(argv).toContain("bun install --frozen-lockfile");
    expect(argv).toContain("bun install --cwd web --frozen-lockfile");
  });

  test("keeps bind-mount writes owned by the developer under rootless podman", () => {
    expect(run().argv).toContain("--userns=keep-id");
  });

  test("does not request a TTY when stdin is not one", () => {
    // Bun.spawnSync gives the child a pipe, so the script must choose -i.
    // With -t the engine refuses with "the input device is not a TTY".
    const { argv } = run();
    expect(argv).toContain(" -i ");
    expect(argv).not.toContain(" -it ");
  });
});

describe("bash-4 guard in scripts/lib/test-file-sets.sh", () => {
  test("runs BEFORE the associative array it protects", async () => {
    const text = await Bun.file(FILE_SETS).text();
    const lines = text.split("\n");
    const guard = lines.findIndex((l) => l.includes("BASH_VERSINFO"));
    const declare = lines.findIndex((l) => /^\s*declare\s+-A\b/.test(l));

    expect(guard).toBeGreaterThan(-1);
    expect(declare).toBeGreaterThan(-1);
    // A guard after the construct never runs: bash fails on the declare first.
    expect(guard).toBeLessThan(declare);
  });

  test("names the required version and an actionable fix", async () => {
    const text = await Bun.file(FILE_SETS).text();
    const guardBlock = text.slice(text.indexOf("BASH_VERSINFO") - 600, text.indexOf("BASH_VERSINFO") + 600);
    expect(guardBlock).toContain("bash 4");
    expect(guardBlock).toContain("brew install bash");
  });
});
