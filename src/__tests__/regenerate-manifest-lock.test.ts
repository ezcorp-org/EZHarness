/**
 * Phase post-perm-cleanup, task C2 — unit tests for the `--check`
 * exit-code behavior of `scripts/regenerate-manifest-lock.ts`.
 *
 * Pure-function form so CI doesn't spawn a subprocess: the script
 * exposes `computeCheckDecision(diff)` which returns `{ exitCode,
 * message }` without touching disk or `process.exit`. We feed it
 * `Diff` objects synthesized via `diffLockfiles` and assert the
 * exit-code behavior:
 *
 *   - clean tree (no added/removed/changed) → exit 0
 *   - any drift → exit 1 with a remediation hint
 *
 * Flag-parsing branches (mutually-exclusive `--check`+`--dry-run` and
 * unknown flags) live in `main()` and call `process.exit(2)` directly,
 * so we DO need a subprocess to test them — that's the second describe
 * block at the bottom of this file. Validator coverage gap: those exit-2
 * paths had no test before this phase.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const { computeCheckDecision, diffLockfiles } = await import(
  "../../scripts/regenerate-manifest-lock"
);

const EMPTY_LOCK = {
  schemaVersion: 1 as const,
  generatedAt: "2026-05-08T00:00:00Z",
  extensions: {},
};

describe("regenerate-manifest-lock --check", () => {
  test("clean tree (no diff) → exit 0 with up-to-date message", () => {
    const diff = diffLockfiles(EMPTY_LOCK, EMPTY_LOCK);
    const decision = computeCheckDecision(diff);
    expect(decision.exitCode).toBe(0);
    expect(decision.message).toBe("Lockfile is up to date.");
  });

  test("added extension → exit 1 with remediation hint", () => {
    const after = {
      schemaVersion: 1 as const,
      generatedAt: "2026-05-08T01:00:00Z",
      extensions: {
        newcomer: {
          version: "1.0.0",
          entrypoint: "./i.ts",
          toolsHash: "sha256-abc",
        },
      },
    };
    const diff = diffLockfiles(EMPTY_LOCK, after);
    const decision = computeCheckDecision(diff);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("+ newcomer");
    expect(decision.message).toContain(
      "manifest.lock.json is out of date",
    );
    expect(decision.message).toContain(
      "Run `bun run scripts/regenerate-manifest-lock.ts`",
    );
  });

  test("removed extension → exit 1 with remediation hint", () => {
    const before = {
      schemaVersion: 1 as const,
      generatedAt: "old",
      extensions: {
        gone: {
          version: "1.0.0",
          entrypoint: "./i.ts",
          toolsHash: "sha256-old",
        },
      },
    };
    const diff = diffLockfiles(before, EMPTY_LOCK);
    const decision = computeCheckDecision(diff);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("- gone");
  });

  test("changed toolsHash → exit 1 with diff line", () => {
    const before = {
      schemaVersion: 1 as const,
      generatedAt: "old",
      extensions: {
        ext: {
          version: "1.0.0",
          entrypoint: "./i.ts",
          toolsHash: "sha256-old",
        },
      },
    };
    const after = {
      schemaVersion: 1 as const,
      generatedAt: "new",
      extensions: {
        ext: {
          version: "1.0.0",
          entrypoint: "./i.ts",
          toolsHash: "sha256-new",
        },
      },
    };
    const diff = diffLockfiles(before, after);
    const decision = computeCheckDecision(diff);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("~ ext.toolsHash:");
    expect(decision.message).toContain("sha256-old -> sha256-new");
  });

  test("multiple drifts → exit 1, all reported", () => {
    const before = {
      schemaVersion: 1 as const,
      generatedAt: "old",
      extensions: {
        a: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-old" },
        b: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-bb" },
      },
    };
    const after = {
      schemaVersion: 1 as const,
      generatedAt: "new",
      extensions: {
        a: { version: "1.0.0", entrypoint: "./i.ts", toolsHash: "sha256-new" }, // changed
        c: { version: "0.1.0", entrypoint: "./i.ts", toolsHash: "sha256-cc" }, // added
        // b removed
      },
    };
    const diff = diffLockfiles(before, after);
    const decision = computeCheckDecision(diff);
    expect(decision.exitCode).toBe(1);
    expect(decision.message).toContain("+ c");
    expect(decision.message).toContain("- b");
    expect(decision.message).toContain("~ a.toolsHash");
  });
});

// --- Flag-parsing subprocess tests ---
//
// Phase post-perm-cleanup, validator coverage gap: the `main()`
// flag-parsing branches (mutual-exclusion + unknown-flag) call
// `process.exit(2)` directly, so they can't be exercised in-process —
// `process.exit` would tear down the test runner. We use
// `Bun.spawnSync` to invoke the script as a real subprocess and assert
// the exit code + stderr message.
//
// These tests intentionally feed flags that fail BEFORE `main()` does
// any IO (manifest loading, lockfile diffing), so they don't require a
// real bundled-extension tree on disk. They should complete in <1s on
// a warm runner; the timeout is a safety bound, not the expected
// duration.
//
// Path resolution: `import.meta.dir` here is `src/__tests__/`. The
// script is at `<repo-root>/scripts/regenerate-manifest-lock.ts`.
describe("regenerate-manifest-lock flag parsing (subprocess)", () => {
  const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "regenerate-manifest-lock.ts");

  test("--check and --dry-run together → exit 2 with mutually-exclusive message", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", SCRIPT, "--check", "--dry-run"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("--check and --dry-run are mutually exclusive");
  });

  test("--check and --dry-run in reverse order also exit 2", () => {
    // Order shouldn't matter for the mutex check — both flags are
    // collected via `args.includes()` before the gate fires.
    const result = Bun.spawnSync({
      cmd: ["bun", "run", SCRIPT, "--dry-run", "--check"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("mutually exclusive");
  });

  test("unknown flag → exit 2 with 'unknown flag' message", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", SCRIPT, "--bogus"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
    const stderr = result.stderr.toString();
    expect(stderr).toContain("unknown flag: --bogus");
  });

  test("unknown flag mixed with valid flag still exits 2", () => {
    // Even if the user passes a valid flag alongside the unknown one,
    // the unknown-flag gate must still fire — otherwise typos slip
    // through silently.
    const result = Bun.spawnSync({
      cmd: ["bun", "run", SCRIPT, "--check", "--typo"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("unknown flag: --typo");
  });
});
