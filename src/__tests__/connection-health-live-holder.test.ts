/**
 * Regression for "Live-holder guard does not cover same-process double-open of
 * the PGlite datadir (vite dev-server restart)".
 *
 * The cross-process sidecar pidfile passes when the recorded pid is our own,
 * so a vite dev-server force-reload — which re-instantiates connection.ts with
 * fresh module state while the previous PGlite instance stays open in-process —
 * would double-open the same live datadir. The fix adds a globalThis-anchored
 * process-local holder registry so a re-instantiated module closes the stale
 * prior instance first. These tests drive that registry directly.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import {
  recordProcessHolder,
  clearProcessHolder,
  closeStaleProcessHolder,
  assertNoLiveHolder,
  claimHolder,
  holderPidPath,
  DbInUseError,
} from "../db/live-holder-guard";

const PATH_A = "/tmp/connection-health-holder-a";
const PATH_B = "/tmp/connection-health-holder-b";

afterEach(async () => {
  // Drop any registry entries a test left behind so cases stay independent.
  await closeStaleProcessHolder(PATH_A);
  await closeStaleProcessHolder(PATH_B);
});

describe("process-local holder registry", () => {
  test("closeStaleProcessHolder returns false when nothing is recorded", async () => {
    expect(await closeStaleProcessHolder("/tmp/connection-health-holder-unrecorded")).toBe(false);
  });

  test("a recorded holder is closed exactly once by closeStaleProcessHolder", async () => {
    let closed = 0;
    recordProcessHolder(PATH_A, () => { closed++; });

    expect(await closeStaleProcessHolder(PATH_A)).toBe(true);
    expect(closed).toBe(1);

    // Registry entry is consumed — a second call is a no-op.
    expect(await closeStaleProcessHolder(PATH_A)).toBe(false);
    expect(closed).toBe(1);
  });

  test("awaits an async close callback", async () => {
    let closed = false;
    recordProcessHolder(PATH_A, async () => {
      await new Promise((r) => setTimeout(r, 1));
      closed = true;
    });
    await closeStaleProcessHolder(PATH_A);
    expect(closed).toBe(true);
  });

  test("a throwing close callback is swallowed and still clears the entry", async () => {
    recordProcessHolder(PATH_A, () => { throw new Error("half-torn-down"); });
    // Must not reject.
    expect(await closeStaleProcessHolder(PATH_A)).toBe(true);
    // Entry was removed even though the close threw.
    expect(await closeStaleProcessHolder(PATH_A)).toBe(false);
  });

  test("clearProcessHolder forgets WITHOUT closing (caller closed it themselves)", async () => {
    let closed = 0;
    recordProcessHolder(PATH_A, () => { closed++; });
    clearProcessHolder(PATH_A);
    expect(await closeStaleProcessHolder(PATH_A)).toBe(false);
    expect(closed).toBe(0);
  });

  test("holders are keyed per datadir — closing one leaves the other live", async () => {
    let closedA = 0;
    let closedB = 0;
    recordProcessHolder(PATH_A, () => { closedA++; });
    recordProcessHolder(PATH_B, () => { closedB++; });

    await closeStaleProcessHolder(PATH_A);
    expect(closedA).toBe(1);
    expect(closedB).toBe(0);
    expect(await closeStaleProcessHolder(PATH_B)).toBe(true);
    expect(closedB).toBe(1);
  });

  test("re-recording the same datadir replaces the close callback", async () => {
    const calls: string[] = [];
    recordProcessHolder(PATH_A, () => { calls.push("first"); });
    recordProcessHolder(PATH_A, () => { calls.push("second"); });
    await closeStaleProcessHolder(PATH_A);
    // Only the latest instance's close runs.
    expect(calls).toEqual(["second"]);
  });
});

describe("assertNoLiveHolder — cross-process pidfile guard", () => {
  const PATH_C = "/tmp/connection-health-holder-c";

  afterEach(() => {
    try { rmSync(holderPidPath(PATH_C)); } catch { /* already gone */ }
  });

  test("throws DbInUseError when a DIFFERENT live JS-runtime process holds the datadir", () => {
    // Spawn a real, live `bun` child so the pid is alive AND its /proc cmdline
    // looks like a JS runtime (isLiveHolder => true) — the exact condition that
    // must refuse a second open. pid differs from ours, so the own-pid pass is
    // not taken.
    const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 60000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      expect(child.pid).not.toBe(process.pid);
      writeFileSync(holderPidPath(PATH_C), String(child.pid));
      expect(() => assertNoLiveHolder(PATH_C)).toThrow(DbInUseError);
    } finally {
      child.kill();
    }
  });

  test("passes when the pidfile records OUR OWN pid (same-process re-init)", () => {
    claimHolder(PATH_C);
    expect(() => assertNoLiveHolder(PATH_C)).not.toThrow();
  });

  test("passes when there is no pidfile", () => {
    expect(() => assertNoLiveHolder(PATH_C)).not.toThrow();
  });

  test("passes when the recorded pid is dead (unclean prior shutdown)", () => {
    // A pid that cannot be alive: writeFileSync a very-high pid unlikely to exist.
    writeFileSync(holderPidPath(PATH_C), "2147483646");
    expect(() => assertNoLiveHolder(PATH_C)).not.toThrow();
  });
});
