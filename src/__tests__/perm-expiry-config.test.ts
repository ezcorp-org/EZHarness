/**
 * Cap-expiry Phase 1 — TTL config + env-var override.
 *
 * Locks in the contract documented in `src/extensions/perm-expiry-
 * config.ts`:
 *   • TTL_CONFIG carries the design-doc § 2.4 entries with the
 *     locked values (filesystem-write 30d, filesystem-read 90d, ...).
 *   • `getTtlMs` echoes the table.
 *   • `getForeverTtlMs` reads `EZCORP_PERM_FOREVER_TTL_DAYS` with the
 *     locked default of 90 days; falls back on missing / invalid env.
 *   • `isExpiringKind` distinguishes finite TTL from `"never"`.
 *
 * No DB / I/O — pure config module.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_FOREVER_TTL_DAYS,
  TTL_CONFIG,
  getForeverTtlMs,
  getTtlMs,
  isExpiringKind,
  type CapabilityExpiryKind,
} from "../extensions/perm-expiry-config";

const DAY_MS = 24 * 60 * 60 * 1000;

// Restore env var between tests so a leak from one case doesn't bleed
// into the next. Bun test runs each file in its own process, but
// within a file the env is shared.
const originalEnv = process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
  } else {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = originalEnv;
  }
});

// ── TTL_CONFIG table ────────────────────────────────────────────────

describe("TTL_CONFIG", () => {
  test("has every required CapabilityExpiryKind entry", () => {
    // Compile-time checked via the type, but assert at runtime so a
    // refactor that drops a key (Object.freeze masking it) fails loud.
    const required: CapabilityExpiryKind[] = [
      "filesystem-read",
      "filesystem-write",
      "shell",
      "network",
      "env",
      "storage",
      "taskEvents",
      "appendMessages",
      "llm",
      "memory",
      "lessons",
      "schedule",
    ];
    for (const k of required) {
      expect(Object.hasOwn(TTL_CONFIG, k)).toBe(true);
    }
  });

  test("filesystem-write TTL is 30 days", () => {
    expect(TTL_CONFIG["filesystem-write"]).toBe(30 * DAY_MS);
  });

  test("filesystem-read TTL is 90 days", () => {
    expect(TTL_CONFIG["filesystem-read"]).toBe(90 * DAY_MS);
  });

  test("shell TTL is 30 days", () => {
    expect(TTL_CONFIG.shell).toBe(30 * DAY_MS);
  });

  test("network TTL is 90 days", () => {
    expect(TTL_CONFIG.network).toBe(90 * DAY_MS);
  });

  test("env TTL is 90 days", () => {
    expect(TTL_CONFIG.env).toBe(90 * DAY_MS);
  });

  test("llm TTL is 90 days", () => {
    expect(TTL_CONFIG.llm).toBe(90 * DAY_MS);
  });

  test("memory TTL is 90 days", () => {
    expect(TTL_CONFIG.memory).toBe(90 * DAY_MS);
  });

  test("lessons TTL is 90 days", () => {
    expect(TTL_CONFIG.lessons).toBe(90 * DAY_MS);
  });

  test("storage TTL is 'never'", () => {
    expect(TTL_CONFIG.storage).toBe("never");
  });

  test("taskEvents TTL is 'never'", () => {
    expect(TTL_CONFIG.taskEvents).toBe("never");
  });

  test("appendMessages TTL is 'never'", () => {
    expect(TTL_CONFIG.appendMessages).toBe("never");
  });

  test("schedule TTL is 'never'", () => {
    expect(TTL_CONFIG.schedule).toBe("never");
  });

  test("table is frozen — runtime mutation throws in strict mode", () => {
    // `Object.freeze` makes `TTL_CONFIG[...]= ...` a silent no-op in
    // sloppy mode and a TypeError in strict mode. Bun test runs ESM in
    // strict mode, so a write attempt throws. Cast to a mutable shape
    // via `unknown` so biome's noExplicitAny stays happy.
    const writable = TTL_CONFIG as unknown as Record<string, number>;
    expect(() => {
      writable.shell = 999;
    }).toThrow();
    expect(TTL_CONFIG.shell).toBe(30 * DAY_MS);
  });
});

// ── getTtlMs ────────────────────────────────────────────────────────

describe("getTtlMs", () => {
  test("returns 30 days for filesystem-write", () => {
    expect(getTtlMs("filesystem-write")).toBe(30 * DAY_MS);
  });

  test("returns 90 days for filesystem-read", () => {
    expect(getTtlMs("filesystem-read")).toBe(90 * DAY_MS);
  });

  test("returns 'never' for storage", () => {
    expect(getTtlMs("storage")).toBe("never");
  });

  test("returns 'never' for schedule", () => {
    expect(getTtlMs("schedule")).toBe("never");
  });

  test("optional foreverDays parameter is currently inert (Phase 1)", () => {
    // The parameter is reserved for v1.5 per-capability override —
    // Phase 1's `getTtlMs` ignores it. Locking the contract so a
    // future change is a deliberate signature update.
    expect(getTtlMs("shell", 7)).toBe(30 * DAY_MS);
    expect(getTtlMs("shell", 365)).toBe(30 * DAY_MS);
  });
});

// ── getForeverTtlMs (env-var override) ──────────────────────────────

describe("getForeverTtlMs", () => {
  test("returns 90 days when env unset", () => {
    delete process.env.EZCORP_PERM_FOREVER_TTL_DAYS;
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
    expect(DEFAULT_FOREVER_TTL_DAYS).toBe(90); // sanity
  });

  test("returns 30 days when EZCORP_PERM_FOREVER_TTL_DAYS=30", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "30";
    expect(getForeverTtlMs()).toBe(30 * DAY_MS);
  });

  test("returns 7 days when EZCORP_PERM_FOREVER_TTL_DAYS=7", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "7";
    expect(getForeverTtlMs()).toBe(7 * DAY_MS);
  });

  test("falls back to 90 days on non-numeric env", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "thirty";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("falls back to 90 days on Infinity (Number.isFinite false)", () => {
    // `Number("Infinity") === Infinity`, which is non-finite — the
    // `!Number.isFinite(n)` branch must catch it. A naive `n > 0`
    // guard would let Infinity through and the sweep would never
    // expire any forever-scope grant. Lock the contract.
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "Infinity";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("falls back to 90 days on NaN literal (Number.isFinite false)", () => {
    // `Number("NaN") === NaN`. Same `!Number.isFinite(n)` branch as
    // Infinity — sister coverage so a future refactor that swaps the
    // guard for e.g. `n > 0` fails loudly.
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "NaN";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("falls back to 90 days on empty string", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("falls back to 90 days on zero", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "0";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("falls back to 90 days on negative", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "-5";
    expect(getForeverTtlMs()).toBe(90 * DAY_MS);
  });

  test("floors fractional days (truncates 30.7 -> 30)", () => {
    process.env.EZCORP_PERM_FOREVER_TTL_DAYS = "30.7";
    expect(getForeverTtlMs()).toBe(30 * DAY_MS);
  });
});

// ── isExpiringKind ──────────────────────────────────────────────────

describe("isExpiringKind", () => {
  test("returns true for finite-TTL kinds", () => {
    expect(isExpiringKind("filesystem-write")).toBe(true);
    expect(isExpiringKind("shell")).toBe(true);
    expect(isExpiringKind("network")).toBe(true);
    expect(isExpiringKind("llm")).toBe(true);
  });

  test("returns false for never-expires kinds", () => {
    expect(isExpiringKind("storage")).toBe(false);
    expect(isExpiringKind("taskEvents")).toBe(false);
    expect(isExpiringKind("appendMessages")).toBe(false);
    expect(isExpiringKind("schedule")).toBe(false);
  });
});
