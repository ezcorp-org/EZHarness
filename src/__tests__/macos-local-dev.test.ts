import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const REAL_GIT = Bun.which("git");

if (!REAL_GIT) throw new Error("git is required for this test");

const SANDBOX = mkdtempSync(join(tmpdir(), "macos-local-dev-"));
const BIN = join(SANDBOX, "bin");
mkdirSync(BIN, { recursive: true });

// Stub engines preserve one argument per line. `$*` would flatten boundaries
// and make `bun run test` indistinguishable from one argument with two spaces.
const engineStub = join(BIN, "engine-stub");
writeFileSync(
  engineStub,
  [
    "#!/usr/bin/env bash",
    `if [ "$1" = "image" ]; then exit "\${STUB_IMAGE_EXISTS:-0}"; fi`,
    "{",
    "  printf '%s\\n' '---CALL---'",
    "  printf '%s\\n' \"$@\"",
    '} >> "$STUB_CALLS_FILE"',
    "",
  ].join("\n"),
);
chmodSync(engineStub, 0o755);
for (const engine of ["podman", "docker"]) {
  copyFileSync(engineStub, join(BIN, engine));
  chmodSync(join(BIN, engine), 0o755);
}

// Stable toolchain hash for the default image-name assertion.
writeFileSync(
  join(BIN, "git"),
  [
    "#!/usr/bin/env bash",
    `if [ -n "\${STUB_GIT_CALLS_DIR:-}" ]; then`,
    "  printf '%s\\n' \"$@\" > \"$STUB_GIT_CALLS_DIR/$$\"",
    "fi",
    `if [ "\${STUB_USE_REAL_GIT:-0}" = "1" ]; then`,
    `  exec ${JSON.stringify(REAL_GIT)} "$@"`,
    "fi",
    'if [ "$2" = "--stdin" ]; then',
    "  cat >/dev/null",
    "  echo 0123456789abcdef0123456789abcdef01234567",
    "else",
    `  for _ in "\${@:2}"; do echo abcdef0123456789abcdef0123456789abcdef01; done`,
    "fi",
    "",
  ].join("\n"),
);
chmodSync(join(BIN, "git"), 0o755);

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

let runCount = 0;

function run(
  args: string[] = [],
  options: {
    engine?: "docker" | "podman";
    imageExists?: boolean;
    script?: string;
    useRealGit?: boolean;
  } = {},
): { calls: string[][]; exitCode: number; gitCalls: string[][]; stderr: string } {
  const callsFile = join(SANDBOX, `calls-${runCount++}.txt`);
  const gitCallsDir = join(SANDBOX, `git-calls-${runCount}`);
  writeFileSync(callsFile, "");
  mkdirSync(gitCallsDir);
  const proc = Bun.spawnSync({
    cmd: ["bash", options.script ?? SCRIPT, ...args],
    env: {
      ...process.env,
      PATH: `${BIN}:${process.env.PATH ?? ""}`,
      EZCORP_CONTAINER_ENGINE: options.engine ?? "podman",
      EZCORP_TEST_IMAGE: "",
      STUB_CALLS_FILE: callsFile,
      STUB_GIT_CALLS_DIR: gitCallsDir,
      STUB_IMAGE_EXISTS: options.imageExists === false ? "1" : "0",
      STUB_USE_REAL_GIT: options.useRealGit ? "1" : "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const calls = readFileSync(callsFile, "utf8")
    .split("---CALL---\n")
    .slice(1)
    .map((call) => call.trimEnd().split("\n"));
  const gitCalls = readdirSync(gitCallsDir).map((file) =>
    readFileSync(join(gitCallsDir, file), "utf8").trimEnd().split("\n"),
  );
  return {
    calls,
    exitCode: proc.exitCode,
    gitCalls,
    stderr: proc.stderr.toString(),
  };
}

function runArgs(result: ReturnType<typeof run>): string[] {
  return result.calls.at(-1) ?? [];
}

describe("scripts/test-linux.sh — the invocation it guarantees", () => {
  test("mounts the working tree and masks BOTH node_modules trees with volumes", () => {
    const result = run();
    const argv = runArgs(result);
    const joined = argv.join(" ");
    expect(result.exitCode).toBe(0);

    // The working tree, not the image's stale COPY of it.
    expect(argv).toContain(`${REPO_ROOT}:/repo`);
    expect(joined).toContain("-w /repo");

    // Masks: without these the container reuses the host's macOS-native
    // installs and fails on multi-platform packages.
    expect(joined).toMatch(/:\/repo\/node_modules\b/);
    expect(joined).toMatch(/:\/repo\/web\/node_modules\b/);
  });

  test("defaults to the backend pool as three argv words, not one", () => {
    // `"${@:-bun run test}"` would pass the default as a single argument and
    // the exec inside the container would look for a program called
    // "bun run test".
    const argv = runArgs(run());
    const separator = argv.lastIndexOf("_");
    expect(argv.slice(separator + 1)).toEqual(["bun", "run", "test"]);
  });

  test("passes a caller's command through instead of the default", () => {
    const argv = runArgs(run(["bun", "run", "typecheck"]));
    const separator = argv.lastIndexOf("_");
    expect(argv.slice(separator + 1)).toEqual(["bun", "run", "typecheck"]);
  });

  test("keeps bun's install cache out of the bind-mounted tree", () => {
    // Bun defaults the cache to <cwd>/.bun, and cwd is the repo — so an unset
    // cache dir leaves a .bun/ directory in the developer's working tree on
    // every run.
    expect(runArgs(run()).join(" ")).toMatch(/BUN_INSTALL_CACHE_DIR=\/(?!repo\b)/);
  });

  test("keeps bind-mount writes owned by the developer under rootless podman", () => {
    expect(runArgs(run())).toContain("--userns=keep-id");
    const docker = run([], { engine: "docker" });
    expect(docker.exitCode).toBe(0);
    expect(runArgs(docker)).not.toContain("--userns=keep-id");
  });

  test("does not request a TTY when stdin is not one", () => {
    // Bun.spawnSync gives the child a pipe, so the script must choose -i.
    // With -t the engine refuses with "the input device is not a TTY".
    const argv = runArgs(run());
    expect(argv).toContain("-i");
    expect(argv).not.toContain("-it");
  });

  test("rebuilds a missing image under a toolchain-derived tag", () => {
    const result = run([], { imageExists: false });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toHaveLength(2);
    expect(result.calls[0]).toEqual([
      "build",
      "-f",
      "Dockerfile.test",
      "-t",
      "ezcorp-test-linux:0123456789ab",
      ".",
    ]);
    expect(result.calls[1]).toContain("ezcorp-test-linux:0123456789ab");
    expect(result.gitCalls).toContainEqual([
      "hash-object",
      "Dockerfile.test",
      "Dockerfile.test.dockerignore",
      ".bun-version",
      "web/package.json",
      "web/bun.lock",
    ]);
  });

  test("changes the image tag when the companion ignore file changes", () => {
    const fixture = join(SANDBOX, `repo-${runCount++}`);
    const scripts = join(fixture, "scripts");
    const web = join(fixture, "web");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(web, { recursive: true });
    const fixtureScript = join(scripts, "test-linux.sh");
    copyFileSync(SCRIPT, fixtureScript);
    for (const [path, contents] of [
      ["Dockerfile.test", "FROM scratch\n"],
      ["Dockerfile.test.dockerignore", "node_modules\n"],
      [".bun-version", "1.3.14\n"],
      ["web/package.json", "{}\n"],
      ["web/bun.lock", "lockfile\n"],
    ]) {
      writeFileSync(join(fixture, path), contents);
    }

    const first = run([], { imageExists: false, script: fixtureScript, useRealGit: true });
    writeFileSync(join(fixture, "Dockerfile.test.dockerignore"), "node_modules\n.git\n");
    const second = run([], { imageExists: false, script: fixtureScript, useRealGit: true });
    const firstTag = first.calls[0]?.[first.calls[0].indexOf("-t") + 1];
    const secondTag = second.calls[0]?.[second.calls[0].indexOf("-t") + 1];

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstTag).toStartWith("ezcorp-test-linux:");
    expect(secondTag).toStartWith("ezcorp-test-linux:");
    expect(secondTag).not.toBe(firstTag);
  });

  test("installs both dependency trees from their lockfiles", () => {
    const argv = runArgs(run());
    const bash = argv.indexOf("bash");
    const shell = argv[bash + 2];
    expect(shell).toContain("bun install --frozen-lockfile");
    expect(shell.match(/--frozen-lockfile/g)).toHaveLength(2);
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
