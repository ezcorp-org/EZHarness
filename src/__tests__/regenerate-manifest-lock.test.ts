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
 *   - mutual-exclusion of --check and --dry-run is a flag-parsing
 *     concern handled in main(); we assert behavior of the pure
 *     decision helper here.
 */

import { describe, expect, test } from "bun:test";

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
