/**
 * Non-Linux fallback tests — runs on every platform.
 *
 * Simulates the "netns unavailable" path by:
 *   1. Forcing `probeNetnsAvailability()` to fail via mocked
 *      `process.platform` (mocking only the property surface the
 *      probe reads, so the test process itself keeps working).
 *   2. Asserting `buildNetnsSpawnArgs` returns the original command
 *      unchanged — no `unshare` prefix.
 *
 * Why a separate file from `mcp-netns-integration.test.ts`: that file's
 * gate is "Linux + userns enabled". This file's gate is the inverse —
 * always run, regardless of platform — so the fallback path never
 * stops being exercised by CI.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

import {
  _resetProbeCacheForTests,
  _resetBwrapProbeCacheForTests,
  _setBwrapProbeOverridesForTests,
  buildNetnsSpawnArgs,
  probeBwrapAvailability,
  probeNetnsAvailability,
} from "../extensions/mcp-netns";
// Keep the original `process.platform` so we can flip it per-test.
const REAL_PLATFORM = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, "platform", {
    value: p,
    configurable: true,
    writable: false,
  });
}

beforeEach(() => {
  _resetProbeCacheForTests();
});

afterAll(() => {
  setPlatform(REAL_PLATFORM);
  restoreModuleMocks();
});

describe("probeNetnsAvailability — fallback paths", () => {
  test("non-Linux platform → available=false, reason='not linux'", () => {
    setPlatform("darwin" as NodeJS.Platform);
    _resetProbeCacheForTests();
    try {
      const r = probeNetnsAvailability();
      expect(r.available).toBe(false);
      expect(r.reason).toBe("not linux");
    } finally {
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
    }
  });

  test("'win32' platform → available=false", () => {
    setPlatform("win32" as NodeJS.Platform);
    _resetProbeCacheForTests();
    try {
      const r = probeNetnsAvailability();
      expect(r.available).toBe(false);
    } finally {
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
    }
  });

  test("probe result is cached — second call doesn't re-shell-out", () => {
    _resetProbeCacheForTests();
    const first = probeNetnsAvailability();
    const second = probeNetnsAvailability();
    // Identity: cached calls return the SAME object reference.
    expect(second).toBe(first);
  });
});

describe("buildNetnsSpawnArgs — fallback shape", () => {
  test("non-Linux → returns original command + args, wrapped=false", () => {
    setPlatform("darwin" as NodeJS.Platform);
    _resetProbeCacheForTests();
    try {
      const r = buildNetnsSpawnArgs({
        origCommand: "prlimit",
        origArgs: ["--rss=512", "/usr/bin/python3", "-m", "x"],
        launcherPath: "/path/to/launcher.sh",
      });
      expect(r.wrapped).toBe(false);
      expect(r.command).toBe("prlimit");
      expect(r.args).toEqual(["--rss=512", "/usr/bin/python3", "-m", "x"]);
    } finally {
      setPlatform(REAL_PLATFORM);
      _resetProbeCacheForTests();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Plan 55-02 — probeBwrapAvailability (MCP-02 tmpfs)
//
// Mirrors the probeNetnsAvailability fallback test layout 1:1. The probe
// shape is: platform check → Bun.which("bwrap") → live spawn probe →
// cache. The "missing binary" and "probe-fails" branches use a test-only
// injection seam (`_setBwrapProbeOverridesForTests`) because Bun.which
// is a global and not module-mockable; this mirrors the seam approach
// used elsewhere in the codebase for kernel/binary probes.
// ─────────────────────────────────────────────────────────────────────

describe("probeBwrapAvailability", () => {
  test("non-Linux platform → { available: false, reason: 'not linux' }", () => {
    setPlatform("darwin" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    try {
      const r = probeBwrapAvailability();
      expect(r.available).toBe(false);
      expect(r.reason).toBe("not linux");
    } finally {
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });

  test("Linux + Bun.which('bwrap') returns null → { available: false, reason: 'missing binary: bwrap' }", () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => null,
      // Probe runner shouldn't be called when binary is missing.
      probeRunner: () => {
        throw new Error("probe runner should not be called when bwrap is missing");
      },
    });
    try {
      const r = probeBwrapAvailability();
      expect(r.available).toBe(false);
      expect(r.reason).toBe("missing binary: bwrap");
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });

  test("Linux + bwrap present + probe spawn succeeds → { available: true }", () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    try {
      const r = probeBwrapAvailability();
      expect(r.available).toBe(true);
      expect(r.reason).toBeUndefined();
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });

  test("Linux + bwrap present + probe spawn fails → { available: false, reason: 'bwrap probe exited <code>' }", () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => "/usr/bin/bwrap",
      probeRunner: () => ({ success: false, exitCode: 42 }),
    });
    try {
      const r = probeBwrapAvailability();
      expect(r.available).toBe(false);
      expect(r.reason).toBe("bwrap probe exited 42");
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });

  test("result is cached across calls — second call doesn't re-shell-out", () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    let whichCalls = 0;
    let probeCalls = 0;
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => {
        whichCalls += 1;
        return "/usr/bin/bwrap";
      },
      probeRunner: () => {
        probeCalls += 1;
        return { success: true, exitCode: 0 };
      },
    });
    try {
      const first = probeBwrapAvailability();
      const second = probeBwrapAvailability();
      // Identity: cached calls return the SAME object reference.
      expect(second).toBe(first);
      expect(whichCalls).toBe(1);
      expect(probeCalls).toBe(1);
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });

  test("_resetBwrapProbeCacheForTests() clears the cache", () => {
    setPlatform("linux" as NodeJS.Platform);
    _resetBwrapProbeCacheForTests();
    let whichCalls = 0;
    _setBwrapProbeOverridesForTests({
      whichBwrap: () => {
        whichCalls += 1;
        return "/usr/bin/bwrap";
      },
      probeRunner: () => ({ success: true, exitCode: 0 }),
    });
    try {
      probeBwrapAvailability();
      expect(whichCalls).toBe(1);
      _resetBwrapProbeCacheForTests();
      probeBwrapAvailability();
      expect(whichCalls).toBe(2);
    } finally {
      _setBwrapProbeOverridesForTests(null);
      setPlatform(REAL_PLATFORM);
      _resetBwrapProbeCacheForTests();
    }
  });
});
