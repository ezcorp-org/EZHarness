/**
 * Phase A1 — capability-probe fail-closed branch coverage.
 *
 * The probes MUST never throw out to the caller — a throwing FFI call or a
 * spawn failure has to degrade to null/false so the tier resolves to
 * "advisory" rather than crashing boot. These tests force each probe's
 * catch branch by stubbing its dependency to throw, then assert the
 * fail-closed return.
 *
 * Isolation (the bun mock.module materialization-freeze gotcha): we SNAPSHOT
 * each real module's live exports BEFORE installing the throwing stub, and in
 * afterAll re-register those LITERAL exports (spread into a fresh object) so a
 * later-loaded sibling suite (e.g. sandbox-landlock-ffi.test.ts) imports the
 * real module, never the frozen throwing stub. A lazy `require()` inside the
 * restore factory is NOT enough — it can resolve to the already-stubbed
 * module record — so the snapshot is captured at top level, before any stub.
 */
import { test, expect, describe, mock, afterAll } from "bun:test";
import * as realFfi from "../extensions/sandbox/landlock-ffi";
import * as realChildProcess from "node:child_process";
import * as realPath from "node:path";
import * as realFs from "node:fs";

// Top-level snapshots taken BEFORE any mock.module install — these are the
// genuine exports, captured once at module load.
const FFI_SNAPSHOT = { ...realFfi };
const CHILD_PROCESS_SNAPSHOT = { ...realChildProcess };
const PATH_SNAPSHOT = { ...realPath };
const FS_SNAPSHOT = { ...realFs };

describe("probeLandlockAbi — FFI throws → null (fail-closed)", () => {
  test("returns null when landlockAbiVersion throws", async () => {
    mock.module("../extensions/sandbox/landlock-ffi", () => ({
      ...FFI_SNAPSHOT,
      landlockAbiVersion: () => {
        throw new Error("ffi exploded");
      },
    }));
    const { probeLandlockAbi } = await import(
      "../extensions/sandbox/capability-probe"
    );
    expect(probeLandlockAbi()).toBeNull();
  });

  afterAll(() => {
    // Re-register the LITERAL real exports (not a lazy require) so siblings
    // see the genuine module.
    mock.module("../extensions/sandbox/landlock-ffi", () => ({ ...FFI_SNAPSHOT }));
  });
});

describe("probeUserns — spawnSync throws → false (fail-closed)", () => {
  test("returns false when spawnSync throws", async () => {
    mock.module("node:child_process", () => ({
      ...CHILD_PROCESS_SNAPSHOT,
      spawnSync: () => {
        throw new Error("spawn exploded");
      },
    }));
    const mod = await import("../extensions/sandbox/capability-probe");
    expect(mod.probeUserns()).toBe(false);
  });

  afterAll(() => {
    mock.module("node:child_process", () => ({ ...CHILD_PROCESS_SNAPSHOT }));
  });
});

describe("bwrapIsSetuid — OUTER catch (PATH walk throws) → false", () => {
  test("returns false when join() throws while walking PATH", async () => {
    // The outer try wraps the PATH split + per-entry join(dir,'bwrap'). Force
    // join() to throw so the OUTER catch (not the inner stat catch) runs and
    // fail-closes to false.
    mock.module("node:path", () => ({
      ...PATH_SNAPSHOT,
      join: () => {
        throw new Error("join exploded");
      },
    }));
    const mod = await import("../extensions/sandbox/capability-probe");
    expect(mod.bwrapIsSetuid()).toBe(false);
  });

  afterAll(() => {
    mock.module("node:path", () => ({ ...PATH_SNAPSHOT }));
  });
});

describe("probeKvm — existsSync throws → false (fail-closed)", () => {
  test("returns false when existsSync('/dev/kvm') throws", async () => {
    mock.module("node:fs", () => ({
      ...FS_SNAPSHOT,
      existsSync: () => {
        throw new Error("existsSync exploded");
      },
    }));
    const mod = await import("../extensions/sandbox/capability-probe");
    expect(mod.probeKvm()).toBe(false);
  });

  afterAll(() => {
    mock.module("node:fs", () => ({ ...FS_SNAPSHOT }));
  });
});
