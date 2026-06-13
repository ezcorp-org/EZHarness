/**
 * Phase A1 — capability-probe fail-closed branch coverage.
 *
 * The probes MUST never throw out to the caller — a throwing FFI call or a
 * spawn failure has to degrade to null/false so the tier resolves to
 * "advisory" rather than crashing boot. These tests force each probe's
 * catch branch by stubbing its dependency to throw, then assert the
 * fail-closed return.
 *
 * Isolation: each stub is installed with mock.module BEFORE the probe under
 * test is imported (per the bun mock.module materialization rule — the
 * export shape freezes at first materialization), and the registry is
 * restored in afterAll so sibling suites see the real modules.
 */
import { test, expect, describe, mock, afterAll } from "bun:test";

describe("probeLandlockAbi — FFI throws → null (fail-closed)", () => {
  test("returns null when landlockAbiVersion throws", async () => {
    mock.module("../extensions/sandbox/landlock-ffi", () => ({
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
    // Restore the real FFI module for any later-loaded suite.
    mock.module("../extensions/sandbox/landlock-ffi", () =>
      require("../extensions/sandbox/landlock-ffi"),
    );
  });
});

describe("probeUserns — spawnSync throws → false (fail-closed)", () => {
  test("returns false when spawnSync throws", async () => {
    mock.module("node:child_process", () => ({
      spawnSync: () => {
        throw new Error("spawn exploded");
      },
    }));
    const mod = await import("../extensions/sandbox/capability-probe");
    expect(mod.probeUserns()).toBe(false);
  });

  afterAll(() => {
    mock.module("node:child_process", () => require("node:child_process"));
  });
});
