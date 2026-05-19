/**
 * Cap-expiry Phase 1 — always-allow value-shape migration coverage.
 *
 * Locks in the `setSensitiveAlwaysAllow` / `checkSensitiveConfirmation`
 * widening from `boolean` → `{allowed, grantedAt}` documented on
 * `src/extensions/permissions.ts`:
 *
 *   • WRITE: every new write produces `{allowed: <bool>, grantedAt: <ms>}`.
 *     Legacy boolean is never written by new code.
 *   • READ: accepts BOTH the legacy boolean shape AND the new shape.
 *     Legacy `true` → "allowed" (treated as never-expires; sweep skips).
 *     Legacy `false` → "needs_confirmation".
 *     New `{allowed: true,  grantedAt}` → "allowed".
 *     New `{allowed: false, grantedAt}` → "needs_confirmation".
 *     Malformed (e.g. `{allowed: "yes"}`) → "needs_confirmation"
 *     (fail-closed).
 *
 * Test infrastructure mirrors `extension-permissions.test.ts`: an
 * in-memory `mockSettings: Map<string, unknown>` stub for `getSetting`
 * / `upsertSetting`. No real DB.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock the settings store ─────────────────────────────────────────
// Same shape as `extension-permissions.test.ts` so the two suites stay
// pattern-compatible.
const mockSettings = new Map<string, unknown>();
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings.get(key),
  upsertSetting: async (key: string, value: unknown) => {
    mockSettings.set(key, value);
  },
  getAllSettings: async () => Object.fromEntries(mockSettings),
  deleteSetting: async (key: string) => mockSettings.delete(key),
  isListingInstalled: async () => false,
}));

afterAll(() => restoreModuleMocks());

import {
  alwaysAllowSettingKey,
  buildAlwaysAllowValue,
  checkSensitiveConfirmation,
  parseAlwaysAllowValue,
  readTtlOverrideMs,
  setSensitiveAlwaysAllow,
} from "../extensions/permissions";

beforeEach(() => {
  mockSettings.clear();
});

// ── parseAlwaysAllowValue (pure helper) ─────────────────────────────

describe("parseAlwaysAllowValue", () => {
  test('legacy `true` → "allowed"', () => {
    expect(parseAlwaysAllowValue(true)).toBe("allowed");
  });

  test('legacy `false` → "needs_confirmation"', () => {
    expect(parseAlwaysAllowValue(false)).toBe("needs_confirmation");
  });

  test('new {allowed: true, grantedAt} → "allowed"', () => {
    expect(parseAlwaysAllowValue({ allowed: true, grantedAt: 1_700_000_000_000 })).toBe(
      "allowed",
    );
  });

  test('new {allowed: false, grantedAt} → "needs_confirmation"', () => {
    expect(
      parseAlwaysAllowValue({ allowed: false, grantedAt: 1_700_000_000_000 }),
    ).toBe("needs_confirmation");
  });

  test('malformed {allowed: "yes"} → "needs_confirmation" (fail-closed)', () => {
    expect(parseAlwaysAllowValue({ allowed: "yes", grantedAt: 1 })).toBe(
      "needs_confirmation",
    );
  });

  test('missing grantedAt → "needs_confirmation"', () => {
    expect(parseAlwaysAllowValue({ allowed: true })).toBe("needs_confirmation");
  });

  test('grantedAt as string → "needs_confirmation"', () => {
    expect(
      parseAlwaysAllowValue({ allowed: true, grantedAt: "2024-01-01" }),
    ).toBe("needs_confirmation");
  });

  test('undefined → "needs_confirmation"', () => {
    expect(parseAlwaysAllowValue(undefined)).toBe("needs_confirmation");
  });

  test('null → "needs_confirmation"', () => {
    expect(parseAlwaysAllowValue(null)).toBe("needs_confirmation");
  });

  test('array → "needs_confirmation"', () => {
    expect(parseAlwaysAllowValue([true, 1])).toBe("needs_confirmation");
  });

  test('numeric `1` → "needs_confirmation" (only literal `true` counts as legacy allow)', () => {
    expect(parseAlwaysAllowValue(1)).toBe("needs_confirmation");
  });

  test('direct string `"yes"` → "needs_confirmation" (typeof !== "object" branch)', () => {
    // A bare string is neither `true`/`false` (legacy) nor an object
    // (new shape). It must fall through to the final fail-closed
    // return — locking the `typeof value === "object"` guard against
    // a future refactor that loosens to e.g. `value && typeof v.allowed`.
    expect(parseAlwaysAllowValue("yes")).toBe("needs_confirmation");
  });
});

// ── buildAlwaysAllowValue ───────────────────────────────────────────

describe("buildAlwaysAllowValue", () => {
  test("emits {allowed, grantedAt} with current time by default", () => {
    const before = Date.now();
    const v = buildAlwaysAllowValue(true);
    const after = Date.now();
    expect(v.allowed).toBe(true);
    expect(typeof v.grantedAt).toBe("number");
    expect(v.grantedAt).toBeGreaterThanOrEqual(before);
    expect(v.grantedAt).toBeLessThanOrEqual(after);
  });

  test("respects an explicit `now` parameter", () => {
    const v = buildAlwaysAllowValue(false, 42);
    expect(v).toEqual({ allowed: false, grantedAt: 42 });
  });
});

// ── setSensitiveAlwaysAllow WRITE path ──────────────────────────────

describe("setSensitiveAlwaysAllow — write path emits new shape", () => {
  const SCOPE = {
    userId: "user-1",
    scope: "forever" as const,
    scopeId: "*",
  };

  test("writes {allowed: true, grantedAt} for shell + scoped key", async () => {
    const before = Date.now();
    await setSensitiveAlwaysAllow("ext-1", "shell", true, SCOPE);
    const after = Date.now();

    const key = alwaysAllowSettingKey({
      extensionId: "ext-1",
      userId: SCOPE.userId,
      scope: SCOPE.scope,
      scopeId: SCOPE.scopeId,
      capability: "shell",
    });
    const stored = mockSettings.get(key) as { allowed: boolean; grantedAt: number };
    expect(stored).toBeDefined();
    expect(stored.allowed).toBe(true);
    expect(typeof stored.grantedAt).toBe("number");
    expect(stored.grantedAt).toBeGreaterThanOrEqual(before);
    expect(stored.grantedAt).toBeLessThanOrEqual(after);
  });

  test("writes {allowed: false, grantedAt} for filesystem + scoped key", async () => {
    await setSensitiveAlwaysAllow("ext-2", "filesystem", false, SCOPE);
    const key = alwaysAllowSettingKey({
      extensionId: "ext-2",
      userId: SCOPE.userId,
      scope: SCOPE.scope,
      scopeId: SCOPE.scopeId,
      capability: "fs.write",
    });
    const stored = mockSettings.get(key) as { allowed: boolean; grantedAt: number };
    expect(stored).toEqual({ allowed: false, grantedAt: stored.grantedAt });
    expect(typeof stored.grantedAt).toBe("number");
  });

  test("writes new shape on the LEGACY (unscoped) key path too", async () => {
    // Some pre-Phase-1 callers still hit `setSensitiveAlwaysAllow` with
    // no `scopeArgs` — the deprecated path. Even those get the new
    // value shape so the read side stays homogeneous.
    await setSensitiveAlwaysAllow("ext-3", "shell", true);
    const stored = mockSettings.get("ext:ext-3:always_allow:shell") as {
      allowed: boolean;
      grantedAt: number;
    };
    expect(stored).toBeDefined();
    expect(stored.allowed).toBe(true);
    expect(typeof stored.grantedAt).toBe("number");
  });

  test("never writes a bare boolean", async () => {
    await setSensitiveAlwaysAllow("ext-4", "shell", true, SCOPE);
    const key = alwaysAllowSettingKey({
      extensionId: "ext-4",
      userId: SCOPE.userId,
      scope: SCOPE.scope,
      scopeId: SCOPE.scopeId,
      capability: "shell",
    });
    expect(mockSettings.get(key)).not.toBe(true);
    expect(mockSettings.get(key)).not.toBe(false);
    expect(typeof mockSettings.get(key)).toBe("object");
  });
});

// ── checkSensitiveConfirmation READ path ────────────────────────────

describe("checkSensitiveConfirmation — read path accepts both shapes", () => {
  test('legacy `true` value → "allowed" (treated as never-expires)', async () => {
    // Simulate a pre-Phase-1 row that hasn't been rewritten yet.
    mockSettings.set("ext:ext-legacy-true:always_allow:shell", true);
    expect(await checkSensitiveConfirmation("ext-legacy-true", "shell")).toBe(
      "allowed",
    );
  });

  test('legacy `false` value → "needs_confirmation"', async () => {
    mockSettings.set("ext:ext-legacy-false:always_allow:filesystem", false);
    expect(
      await checkSensitiveConfirmation("ext-legacy-false", "filesystem"),
    ).toBe("needs_confirmation");
  });

  test('new {allowed: true, grantedAt} → "allowed"', async () => {
    mockSettings.set("ext:ext-new-true:always_allow:shell", {
      allowed: true,
      grantedAt: Date.now(),
    });
    expect(await checkSensitiveConfirmation("ext-new-true", "shell")).toBe(
      "allowed",
    );
  });

  test('new {allowed: false, grantedAt} → "needs_confirmation"', async () => {
    mockSettings.set("ext:ext-new-false:always_allow:filesystem", {
      allowed: false,
      grantedAt: Date.now(),
    });
    expect(
      await checkSensitiveConfirmation("ext-new-false", "filesystem"),
    ).toBe("needs_confirmation");
  });

  test('malformed {allowed: "yes"} → "needs_confirmation" (fail-closed)', async () => {
    mockSettings.set("ext:ext-bad:always_allow:shell", { allowed: "yes" });
    expect(await checkSensitiveConfirmation("ext-bad", "shell")).toBe(
      "needs_confirmation",
    );
  });

  test('missing key → "needs_confirmation"', async () => {
    expect(await checkSensitiveConfirmation("ext-absent", "shell")).toBe(
      "needs_confirmation",
    );
  });

  test("scoped read path also accepts both shapes (legacy true)", async () => {
    const SCOPE = {
      userId: "user-x",
      scope: "conversation" as const,
      scopeId: "conv-x",
    };
    const key = alwaysAllowSettingKey({
      extensionId: "ext-scoped-legacy",
      userId: SCOPE.userId,
      scope: SCOPE.scope,
      scopeId: SCOPE.scopeId,
      capability: "shell",
    });
    mockSettings.set(key, true);
    expect(
      await checkSensitiveConfirmation("ext-scoped-legacy", "shell", SCOPE),
    ).toBe("allowed");
  });

  test("scoped read path accepts new shape", async () => {
    const SCOPE = {
      userId: "user-y",
      scope: "forever" as const,
      scopeId: "*",
    };
    const key = alwaysAllowSettingKey({
      extensionId: "ext-scoped-new",
      userId: SCOPE.userId,
      scope: SCOPE.scope,
      scopeId: SCOPE.scopeId,
      capability: "fs.write",
    });
    mockSettings.set(key, { allowed: true, grantedAt: Date.now() });
    expect(
      await checkSensitiveConfirmation("ext-scoped-new", "filesystem", SCOPE),
    ).toBe("allowed");
  });
});

// ── End-to-end: write then read ─────────────────────────────────────

describe("write-then-read round trip", () => {
  test("setSensitiveAlwaysAllow(true) then checkSensitiveConfirmation → 'allowed'", async () => {
    await setSensitiveAlwaysAllow("ext-rt-1", "shell", true);
    expect(await checkSensitiveConfirmation("ext-rt-1", "shell")).toBe(
      "allowed",
    );
  });

  test("setSensitiveAlwaysAllow(false) then checkSensitiveConfirmation → 'needs_confirmation'", async () => {
    await setSensitiveAlwaysAllow("ext-rt-2", "filesystem", false);
    expect(await checkSensitiveConfirmation("ext-rt-2", "filesystem")).toBe(
      "needs_confirmation",
    );
  });

  test("set true → set false: second write overwrites and reads as 'needs_confirmation'", async () => {
    await setSensitiveAlwaysAllow("ext-rt-3", "shell", true);
    await setSensitiveAlwaysAllow("ext-rt-3", "shell", false);
    expect(await checkSensitiveConfirmation("ext-rt-3", "shell")).toBe(
      "needs_confirmation",
    );
  });
});

// ── Phase 56 — per-grant ttlOverrideMs additive shape ───────────────
//
// Locks in the Phase 56 widening of `AlwaysAllowRecord` with optional
// `ttlOverrideMs` / `expiresAt` fields, plus the `readTtlOverrideMs`
// branch helper that the sweep evaluator consults BEFORE the
// `TTL_CONFIG[kind]` / `foreverTtlMs` fallback (see
// `perm-expiry-sweep.ts` lines 485-516, wired in Plan 56-01).
//
// Contract surface:
//   • `parseAlwaysAllowValue` MUST stay tolerant of the new fields —
//     legacy `{allowed, grantedAt}` rows parse unchanged, and rows
//     carrying `ttlOverrideMs` / `expiresAt` (positive number, null,
//     or absent) all reduce to the same allow/deny decision. NO
//     `Object.keys` length checks (Pitfall 1 — would break legacy
//     rows).
//   • `readTtlOverrideMs(value)` distinguishes three branches:
//        null        → "Never" — sweep MUST skip the row entirely.
//        number > 0  → use this override (wins over TTL_CONFIG +
//                      foreverTtlMs).
//        undefined   → legacy/absent/malformed — sweep falls back to
//                      existing TTL_CONFIG[kind] / foreverTtlMs logic.
//     0, negative, NaN, Infinity all collapse to undefined (Pitfall 2
//     — 0 is malformed, NOT Never; only `null` signals Never).
//   • `buildAlwaysAllowValue` accepts an optional third `options` arg
//     `{ ttlOverrideMs?: number | null; expiresAt?: number | null }`.
//     Two-arg legacy callers see no shape change — extra fields stay
//     ABSENT (not `undefined`) so the row is byte-identical to pre-
//     Phase-56 output. Explicit `null` is the Never sentinel and IS
//     written.

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("Phase 56 — ttlOverrideMs additive shape", () => {
  describe("parseAlwaysAllowValue tolerance (Pitfall 1)", () => {
    test('row with ttlOverrideMs + expiresAt positive numbers → "allowed" (extra fields tolerated)', () => {
      expect(
        parseAlwaysAllowValue({
          allowed: true,
          grantedAt: 1,
          ttlOverrideMs: SEVEN_DAYS_MS,
          expiresAt: 1 + SEVEN_DAYS_MS,
        }),
      ).toBe("allowed");
    });

    test('row with ttlOverrideMs=null + expiresAt=null → "allowed" (Never shape tolerated)', () => {
      expect(
        parseAlwaysAllowValue({
          allowed: true,
          grantedAt: 1,
          ttlOverrideMs: null,
          expiresAt: null,
        }),
      ).toBe("allowed");
    });

    test('deny-shape row with ttlOverrideMs → "needs_confirmation" (deny path unchanged)', () => {
      expect(
        parseAlwaysAllowValue({
          allowed: false,
          grantedAt: 1,
          ttlOverrideMs: SEVEN_DAYS_MS,
        }),
      ).toBe("needs_confirmation");
    });

    test('legacy row {allowed, grantedAt} (no Phase 56 fields) → "allowed" (REGRESSION)', () => {
      expect(parseAlwaysAllowValue({ allowed: true, grantedAt: 1 })).toBe(
        "allowed",
      );
    });
  });

  describe("readTtlOverrideMs branches", () => {
    test("ttlOverrideMs: null → null (Never sentinel)", () => {
      expect(
        readTtlOverrideMs({ allowed: true, grantedAt: 1, ttlOverrideMs: null }),
      ).toBeNull();
    });

    test("ttlOverrideMs: positive number → that number", () => {
      expect(
        readTtlOverrideMs({
          allowed: true,
          grantedAt: 1,
          ttlOverrideMs: SEVEN_DAYS_MS,
        }),
      ).toBe(SEVEN_DAYS_MS);
    });

    test("legacy row (no ttlOverrideMs field) → undefined (fallback)", () => {
      expect(readTtlOverrideMs({ allowed: true, grantedAt: 1 })).toBeUndefined();
    });

    test("ttlOverrideMs: 0 → undefined (Pitfall 2 — 0 is malformed, NOT Never)", () => {
      expect(
        readTtlOverrideMs({ allowed: true, grantedAt: 1, ttlOverrideMs: 0 }),
      ).toBeUndefined();
    });

    test("ttlOverrideMs: negative → undefined (malformed)", () => {
      expect(
        readTtlOverrideMs({ allowed: true, grantedAt: 1, ttlOverrideMs: -5 }),
      ).toBeUndefined();
    });

    test("ttlOverrideMs: NaN → undefined", () => {
      expect(
        readTtlOverrideMs({
          allowed: true,
          grantedAt: 1,
          ttlOverrideMs: Number.NaN,
        }),
      ).toBeUndefined();
    });

    test("ttlOverrideMs: Infinity → undefined", () => {
      expect(
        readTtlOverrideMs({
          allowed: true,
          grantedAt: 1,
          ttlOverrideMs: Number.POSITIVE_INFINITY,
        }),
      ).toBeUndefined();
    });

    test("legacy boolean true row → undefined", () => {
      expect(readTtlOverrideMs(true)).toBeUndefined();
    });

    test("null value → undefined (typeof object guard)", () => {
      expect(readTtlOverrideMs(null)).toBeUndefined();
    });

    test("non-object value (string) → undefined", () => {
      expect(readTtlOverrideMs("not-an-object")).toBeUndefined();
    });

    test("array value → undefined (Array.isArray guard)", () => {
      expect(readTtlOverrideMs([true, 1])).toBeUndefined();
    });
  });

  describe("buildAlwaysAllowValue options arg", () => {
    test("no options arg → REGRESSION: shape is {allowed, grantedAt} only (no extra fields)", () => {
      const v = buildAlwaysAllowValue(true, 1000);
      expect(v).toEqual({ allowed: true, grantedAt: 1000 });
      // Belt-and-suspenders: lock that the extra fields are ABSENT,
      // not `undefined`. JSON serialization drops `undefined` keys but
      // some equality matchers tolerate the difference — we don't.
      expect("ttlOverrideMs" in v).toBe(false);
      expect("expiresAt" in v).toBe(false);
    });

    test("positive ttlOverrideMs + matching expiresAt → both fields written", () => {
      const v = buildAlwaysAllowValue(true, 1000, {
        ttlOverrideMs: SEVEN_DAYS_MS,
        expiresAt: 1000 + SEVEN_DAYS_MS,
      });
      expect(v).toEqual({
        allowed: true,
        grantedAt: 1000,
        ttlOverrideMs: SEVEN_DAYS_MS,
        expiresAt: 1000 + SEVEN_DAYS_MS,
      });
    });

    test("ttlOverrideMs: null + expiresAt: null → Never row (both fields written as null)", () => {
      const v = buildAlwaysAllowValue(true, 1000, {
        ttlOverrideMs: null,
        expiresAt: null,
      });
      expect(v).toEqual({
        allowed: true,
        grantedAt: 1000,
        ttlOverrideMs: null,
        expiresAt: null,
      });
    });

    test("empty options object → fields stay ABSENT (empty options ≠ explicit null)", () => {
      const v = buildAlwaysAllowValue(true, 1000, {});
      expect(v).toEqual({ allowed: true, grantedAt: 1000 });
      expect("ttlOverrideMs" in v).toBe(false);
      expect("expiresAt" in v).toBe(false);
    });
  });
});
