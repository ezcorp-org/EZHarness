/**
 * Phase A2 — in-process coverage for the code paths that otherwise only run
 * inside the spawned shim CHILD (whose coverage the parent runner can't see):
 *   - applyLandlockJailSpec: ABI-gate throw + the apply path (FFI stubbed so
 *     it does NOT actually jail this test process),
 *   - runShim: the apply→spawn→exit-code path (apply stubbed; spawns `true`),
 *   - buildSandboxArgv: the exhaustiveness `default` guard (forced via cast).
 *
 * FFI/apply are stubbed with mock.module installed BEFORE the module under
 * test is imported (bun materialization rule) and RESTORED in afterAll so
 * sibling suites see the real modules.
 */
import { test, expect, describe, mock, afterAll } from "bun:test";
import { buildSandboxArgv } from "../extensions/sandbox/build-sandbox-argv";

describe("buildSandboxArgv — exhaustiveness guard", () => {
  test("throws on an unknown tier (defensive default branch)", () => {
    expect(() =>
      buildSandboxArgv({
        // force an invalid tier past the type system
        tier: "bogus" as unknown as "advisory",
        workspaceDir: "/tmp/x",
        projectRoot: "/tmp",
        command: "echo",
      }),
    ).toThrow(/unhandled tier/);
  });
});

describe("applyLandlockJailSpec — FFI stubbed (no real jail)", () => {
  test("throws when ABI < 1 (unsupported)", async () => {
    mock.module("../extensions/sandbox/landlock-ffi", () => ({
      landlockAbiVersion: () => 0,
      applyReadWriteJail: () => {
        throw new Error("should not be called when ABI<1");
      },
    }));
    const { applyLandlockJailSpec } = await import(
      "../extensions/sandbox/landlock"
    );
    expect(() => applyLandlockJailSpec({ ro: ["/usr"], rw: ["/w"] })).toThrow(
      /not supported/,
    );
  });

  test("calls applyReadWriteJail with rw + ro split when supported", async () => {
    let rwReceived: string[] | null = null;
    let roReceived: string[] | null = null;
    mock.module("../extensions/sandbox/landlock-ffi", () => ({
      landlockAbiVersion: () => 5,
      applyReadWriteJail: (rw: string[], ro: string[]) => {
        rwReceived = rw;
        roReceived = ro;
      },
    }));
    // fresh import so it binds the stubbed FFI
    const mod = await import("../extensions/sandbox/landlock");
    mod.applyLandlockJailSpec({ ro: ["/usr", "/lib"], rw: ["/w"] });
    // rw paths grant write; ro paths stay read-only — kept SEPARATE.
    expect(rwReceived as string[] | null).toEqual(["/w"]);
    expect(roReceived as string[] | null).toEqual(["/usr", "/lib"]);
  });

  afterAll(() => {
    // Restore the REAL FFI module by re-registering its live exports
    // (snapshot pattern) so sibling suites never see the throwing/stub
    // version — the documented bun mock.module materialization-freeze fix.
    const real = require("../extensions/sandbox/landlock-ffi");
    mock.module("../extensions/sandbox/landlock-ffi", () => ({ ...real }));
  });
});

describe("runShim — apply stubbed, spawns a trivial child", () => {
  test("applies the spec then runs the inner command and returns its code", async () => {
    let applied: unknown = null;
    mock.module("../extensions/sandbox/landlock", () => ({
      applyLandlockJailSpec: (spec: unknown) => {
        applied = spec;
      },
    }));
    const shim = await import("../extensions/sandbox/landlock-shim");
    const env = {
      ...process.env,
      [shim.LANDLOCK_SPEC_ENV]: JSON.stringify({ ro: ["/usr"], rw: ["/w"] }),
    };
    const code = await shim.runShim(["true"], env);
    expect(code).toBe(0);
    expect(applied).toEqual({ ro: ["/usr"], rw: ["/w"] });
  });

  test("propagates a non-zero exit from the inner command", async () => {
    mock.module("../extensions/sandbox/landlock", () => ({
      applyLandlockJailSpec: () => {},
    }));
    const shim = await import("../extensions/sandbox/landlock-shim");
    const env = {
      ...process.env,
      [shim.LANDLOCK_SPEC_ENV]: JSON.stringify({ ro: [], rw: [] }),
    };
    const code = await shim.runShim(["false"], env);
    expect(code).not.toBe(0);
  });

  afterAll(() => {
    // Snapshot-restore the real module (see the landlock-ffi afterAll above).
    const real = require("../extensions/sandbox/landlock");
    mock.module("../extensions/sandbox/landlock", () => ({ ...real }));
  });
});
