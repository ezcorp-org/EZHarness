/**
 * Pure-function tests for src/extensions/bundled.ts — opt-out gating
 * and bundled-name membership. No DB, no filesystem: these cover
 * `resolveBundledExtensions` (DISABLE_FLAGS env filtering) and
 * `isBundledExtensionName` (ReadonlySet lookup). The DB-heavy parts of
 * the module (ensureBundledExtensions, drift/version gates, audit
 * writes) are exercised by extension-security-lifecycle.test.ts and
 * friends.
 */
import { test, expect, describe } from "bun:test";
import {
  resolveBundledExtensions,
  isBundledExtensionName,
} from "../extensions/bundled";

describe("resolveBundledExtensions", () => {
  test("returns the full list when no opt-out flags are set", () => {
    const result = resolveBundledExtensions({});
    expect(result.length).toBeGreaterThan(0);
    // Well-known bundled extensions must appear.
    const names = result.map((e) => e.name);
    expect(names).toContain("scratchpad");
    expect(names).toContain("task-tracking");
    expect(names).toContain("orchestration");
    expect(names).toContain("ai-kit");
  });

  test("EZCORP_DISABLE_AI_KIT=1 removes ai-kit only", () => {
    const result = resolveBundledExtensions({ EZCORP_DISABLE_AI_KIT: "1" });
    const names = result.map((e) => e.name);
    expect(names).not.toContain("ai-kit");
    // All other bundled entries must survive the opt-out.
    expect(names).toContain("scratchpad");
    expect(names).toContain("task-tracking");
  });

  test("flag value other than '1' does not trigger opt-out", () => {
    // Explicit "0" / "true" / empty string — only the literal "1" disables.
    for (const v of ["0", "true", "", "yes"]) {
      const result = resolveBundledExtensions({ EZCORP_DISABLE_AI_KIT: v });
      const names = result.map((e) => e.name);
      expect(names).toContain("ai-kit");
    }
  });

  test("every returned entry has a permissions.grantedAt object (typed-invariant)", () => {
    const result = resolveBundledExtensions({});
    for (const entry of result) {
      expect(entry.permissions).toBeDefined();
      expect(entry.permissions.grantedAt).toBeDefined();
      expect(typeof entry.permissions.grantedAt).toBe("object");
    }
  });

  test("unknown env vars do not disturb the list", () => {
    const before = resolveBundledExtensions({}).map((e) => e.name);
    const after = resolveBundledExtensions({
      NOT_A_REAL_DISABLE_FLAG: "1",
      EZCORP_SOMETHING_ELSE: "1",
    }).map((e) => e.name);
    expect(after).toEqual(before);
  });
});

describe("isBundledExtensionName", () => {
  test("returns true for every bundled extension name", () => {
    // Use resolveBundledExtensions with no flags to get every declared entry —
    // this is the same source the ReadonlySet is derived from.
    const names = resolveBundledExtensions({}).map((e) => e.name);
    for (const name of names) {
      expect(isBundledExtensionName(name)).toBe(true);
    }
  });

  test("returns false for names that are not bundled", () => {
    expect(isBundledExtensionName("definitely-not-bundled")).toBe(false);
    expect(isBundledExtensionName("")).toBe(false);
    expect(isBundledExtensionName("scratchpad-imposter")).toBe(false);
  });

  test("opt-out flag does NOT remove a name from bundled-membership", () => {
    // Even with ai-kit opted OUT of installs, the name itself must still be
    // recognized as bundled — the comment in bundled.ts explicitly documents
    // this: "Opt-out flags intentionally do NOT remove a name here".
    expect(isBundledExtensionName("ai-kit")).toBe(true);
  });

  test("is case-sensitive (ReadonlySet uses strict equality)", () => {
    expect(isBundledExtensionName("Scratchpad")).toBe(false);
    expect(isBundledExtensionName("SCRATCHPAD")).toBe(false);
    expect(isBundledExtensionName("scratchpad")).toBe(true);
  });
});
