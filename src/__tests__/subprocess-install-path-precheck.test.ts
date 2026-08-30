/**
 * ExtensionProcess install-path spawn pre-check (src/extensions/subprocess.ts):
 *
 *   - an unresolvable install path (entrypoint file missing on disk) THROWS
 *     the actionable, environment-shaped message BEFORE `Bun.spawn` — no
 *     subprocess starts, `consecutive_failures` never increments, the
 *     extension is never auto-disabled;
 *   - a GENUINE crash (the entrypoint exists, the child spawns, and exits
 *     non-zero on its own) still counts and still reaches the
 *     AUTO_DISABLE_THRESHOLD exactly as before — this pre-check narrows
 *     WHICH failures count, it does not weaken the crash-loop protection.
 *
 * Live incident this regresses: a host-side process reading a database
 * whose bundled `extensions.install_path` rows were written by a container
 * boot (`/app/docs/extensions/examples/web-search`, unresolvable from the
 * host). Before this pre-check, the resulting "Module not found" spawn
 * failure was indistinguishable from a real code crash and burned the
 * failure counter until the extension was permanently disabled — a
 * destructive write triggered by what should have been a read-only,
 * loudly-diagnosable failure. Companion fix: `src/extensions/bundled.ts` +
 * `src/extensions/install-roots.ts` make the install path portable in the
 * first place, so this pre-check is the defence-in-depth backstop for
 * every OTHER way an install path can go stale (moved directory, foreign
 * root, deleted checkout).
 *
 * Mirrors the structure of `subprocess-npm-deps.test.ts` — same mock.module
 * shape for the DB + registry so the crash/auto-disable path runs without a
 * live DB.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let failureCount = 0;
const disableCalls: string[] = [];
let reloadCalled = false;

mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => ++failureCount,
  disableExtension: async (id: string) => {
    disableCalls.push(id);
  },
  resetFailures: async () => {
    failureCount = 0;
  },
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        reloadCalled = true;
      },
    }),
  },
}));

afterAll(() => restoreModuleMocks());

import { ExtensionProcess } from "../extensions/subprocess";

const crashPath = join(import.meta.dir, "helpers", "crash-extension.ts");
const missingPath = join(
  import.meta.dir,
  "helpers",
  "does-not-exist-on-disk",
  "index.ts",
);
const allowedEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
};

beforeEach(() => {
  failureCount = 0;
  disableCalls.length = 0;
  reloadCalled = false;
});

describe("ExtensionProcess install-path spawn pre-check", () => {
  test("an unresolvable install path throws BEFORE spawning and never runs", () => {
    const ep = new ExtensionProcess("env-mismatch", missingPath, allowedEnv);
    expect(() => ep.ensureRunning()).toThrow(/install path could not be resolved/);
    expect(() => ep.ensureRunning()).toThrow(missingPath);
    // No spawn happened → isRunning stays false.
    expect(ep.isRunning).toBe(false);
  });

  test("the pre-check error names the extension when extensionName is provided", () => {
    const ep = new ExtensionProcess("0000-uuid-like-id", missingPath, allowedEnv, {
      extensionName: "web-search",
    });
    expect(() => ep.ensureRunning()).toThrow(/Extension "web-search" install path/);
  });

  test("falls back to the extension id when no name is provided", () => {
    const ep = new ExtensionProcess("raw-id-123", missingPath, allowedEnv);
    expect(() => ep.ensureRunning()).toThrow(/Extension "raw-id-123" install path/);
  });

  test("names it as an environment problem, distinct from a spawn crash message", () => {
    const ep = new ExtensionProcess("env-mismatch-2", missingPath, allowedEnv);
    expect(() => ep.ensureRunning()).toThrow(/environment problem/);
    // Distinct from the language a real crash gets (subprocess-npm-deps.test.ts
    // and the "auto-disable" test below): never "auto-disabled", never
    // "Module not found" — this never even reaches a spawn attempt.
    expect(() => ep.ensureRunning()).not.toThrow(/auto-disabled|module not found/i);
  });

  test("call() surfaces the pre-check failure without incrementing failures", async () => {
    const ep = new ExtensionProcess("env-mismatch-3", missingPath, allowedEnv);
    await expect(ep.call("tools/call", { name: "x", arguments: {} })).rejects.toThrow(
      /install path could not be resolved/,
    );
    expect(ep.isRunning).toBe(false);
    // The DB failure-counter mock was never touched: no spawn ever ran,
    // so `proc.exited` never fired to call `incrementFailures`.
    expect(failureCount).toBe(0);
    expect(disableCalls).toEqual([]);
  });

  test("three failed calls against a missing install path do NOT auto-disable", async () => {
    // The exact contract the incident violated: a persistently-unresolvable
    // path must never accumulate toward AUTO_DISABLE_THRESHOLD (3), however
    // many times it is called.
    const ep = new ExtensionProcess("env-mismatch-persistent", missingPath, allowedEnv);
    for (let i = 0; i < 5; i++) {
      await expect(ep.call("tools/call", { name: "x", arguments: {} })).rejects.toThrow(
        /install path could not be resolved/,
      );
    }
    expect(failureCount).toBe(0);
    expect(disableCalls).toEqual([]);
    expect(reloadCalled).toBe(false);
  });

  test("a RESOLVABLE install path passes the pre-check unaffected", async () => {
    // crash-extension.ts exists on disk — proves the new check does not
    // false-positive on a real, present entrypoint (the actual crash is
    // asserted separately, below, and in subprocess-npm-deps.test.ts).
    const ep = new ExtensionProcess("resolvable", crashPath, allowedEnv);
    let caught: Error | null = null;
    try {
      await ep.callTool("boom", {});
    } catch (err) {
      caught = err as Error;
    } finally {
      ep.kill();
    }
    // It DID spawn (and then crashed on its own) — a different failure
    // mode than "install path could not be resolved".
    expect(caught).toBeTruthy();
    expect(caught!.message).not.toContain("install path could not be resolved");
  }, 15000);

  test("a GENUINE crash-loop (entrypoint exists, child crashes on its own) still auto-disables", async () => {
    // The contract this pre-check must NOT weaken: three real crashes still
    // hit AUTO_DISABLE_THRESHOLD and disable the extension, exactly as
    // subprocess-npm-deps.test.ts already proves for the npm-dep pre-check.
    failureCount = 2; // the next crash increments to 3 === AUTO_DISABLE_THRESHOLD
    const ep = new ExtensionProcess("genuine-crash-loop", crashPath, allowedEnv);
    try {
      await ep.callTool("boom", {}).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    } finally {
      ep.kill();
    }
    expect(disableCalls).toContain("genuine-crash-loop");
    expect(reloadCalled).toBe(true);
  }, 15000);
});
