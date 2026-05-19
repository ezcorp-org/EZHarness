/**
 * Phase D — startup invariant `assertCriticalExtensions`.
 *
 * Root-cause fix #3 backstop: after `ensureBundledExtensions()`, every
 * `critical` bundled extension MUST be enabled, else a stuck agent has
 * no escape hatch.
 *
 *   - all critical enabled ⇒ no-op (no remediation, no ERROR-level
 *     state change).
 *   - a critical extension disabled + on-disk perms within ceiling ⇒
 *     one-time re-enabled + audit row.
 *   - a critical extension disabled + perms exceed ceiling ⇒ stays
 *     disabled (security floor), flagged unremediated.
 *   - a critical extension MISSING ⇒ violation + unremediated.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface Row {
  id: string;
  name: string;
  enabled: boolean;
}
const auditEntries: Array<{ action: string; target?: string }> = [];
let rows: Map<string, Row>;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => rows.get(name) ?? null,
  updateExtension: async (id: string, patch: Record<string, unknown>) => {
    updateCalls.push({ id, patch });
    for (const r of rows.values()) {
      if (r.id === id) {
        Object.assign(r, patch);
        return r;
      }
    }
    return null;
  },
}));

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _u: string | null,
    action: string,
    target?: string,
  ) => {
    auditEntries.push({ action, target });
    return "a";
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

const { assertCriticalExtensions } = await import(
  "../startup/assert-critical-extensions"
);
const { getCriticalBundledExtensions } = await import("../extensions/bundled");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  rows = new Map();
  auditEntries.length = 0;
  updateCalls.length = 0;
});

const CRITICAL = getCriticalBundledExtensions().map((c) => c.name);

function seedAll(enabled: boolean): void {
  for (const name of CRITICAL) {
    rows.set(name, { id: `id-${name}`, name, enabled });
  }
}

describe("getCriticalBundledExtensions", () => {
  test("returns ask-user + task-tracking", () => {
    expect(CRITICAL).toContain("ask-user");
    expect(CRITICAL).toContain("task-tracking");
  });
});

describe("assertCriticalExtensions", () => {
  test("all critical enabled ⇒ no-op (no violations, no remediation)", async () => {
    seedAll(true);
    const r = await assertCriticalExtensions();
    expect(r.violations).toEqual([]);
    expect(r.remediated).toEqual([]);
    expect(updateCalls.length).toBe(0);
    expect(r.checked.sort()).toEqual([...CRITICAL].sort());
  }, 20_000);

  test("disabled critical + within-ceiling perms ⇒ one-time re-enabled + audit", async () => {
    seedAll(true);
    // Disable ask-user (its real on-disk perms are within ceiling).
    rows.get("ask-user")!.enabled = false;

    const r = await assertCriticalExtensions();

    expect(r.violations).toContain("ask-user");
    expect(r.remediated).toContain("ask-user");
    expect(rows.get("ask-user")!.enabled).toBe(true);
    expect(
      updateCalls.some(
        (c) => c.id === "id-ask-user" && c.patch.enabled === true,
      ),
    ).toBe(true);
    expect(
      auditEntries.some(
        (a) =>
          a.action === "ext:bundled:critical-auto-reapproved" &&
          a.target === "id-ask-user",
      ),
    ).toBe(true);
  }, 20_000);

  test("missing critical extension ⇒ violation + unremediated, no crash", async () => {
    seedAll(true);
    rows.delete("task-tracking");
    const r = await assertCriticalExtensions();
    expect(r.violations).toContain("task-tracking");
    expect(r.unremediated).toContain("task-tracking");
    // ask-user untouched (was enabled).
    expect(rows.get("ask-user")!.enabled).toBe(true);
  }, 20_000);

  // The ceiling-EXCEEDS branch is covered in the isolated file
  // `assert-critical-extensions-ceiling-exceeds.test.ts` (it must
  // `mock.module` bundled-ceiling, which can't be safely scoped within
  // this multi-test file).
});
