/**
 * Phase D — startup invariant, ceiling-EXCEEDS branch (isolated).
 *
 * `mock.module`s `../extensions/bundled-ceiling` to force ask-user's
 * on-disk perms to exceed the ceiling; that mock must be file-scoped
 * (restored only in afterAll) so it can't leak into the within-ceiling
 * / no-op tests in assert-critical-extensions.test.ts.
 *
 * Contract: a disabled `critical` extension whose on-disk perms EXCEED
 * the bundled ceiling is NOT auto-re-enabled — the disable stands
 * (security floor); the violation is recorded as unremediated.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

interface Row {
  id: string;
  name: string;
  enabled: boolean;
}
let rows: Map<string, Row>;
const auditEntries: Array<{ action: string }> = [];

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => rows.get(name) ?? null,
  updateExtension: async (id: string, patch: Record<string, unknown>) => {
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
  insertAuditEntry: async (_u: string | null, action: string) => {
    auditEntries.push({ action });
    return "a";
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

mock.module("../extensions/bundled-ceiling", () => ({
  clampToBundledCeiling: (n: string, req: ExtensionPermissions) =>
    n === "ask-user"
      ? { effective: { grantedAt: {} }, clamped: true }
      : { effective: req, clamped: false },
  getCeiling: () => null,
}));

const { assertCriticalExtensions } = await import(
  "../startup/assert-critical-extensions"
);
const { getCriticalBundledExtensions } = await import("../extensions/bundled");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  rows = new Map();
  auditEntries.length = 0;
});

describe("assertCriticalExtensions — ceiling EXCEEDS (security floor)", () => {
  test("disabled critical exceeding ceiling ⇒ stays disabled, unremediated", async () => {
    for (const { name } of getCriticalBundledExtensions()) {
      rows.set(name, { id: `id-${name}`, name, enabled: true });
    }
    rows.get("ask-user")!.enabled = false;

    const r = await assertCriticalExtensions();

    expect(r.violations).toContain("ask-user");
    expect(r.remediated).not.toContain("ask-user");
    expect(r.unremediated).toContain("ask-user");
    expect(rows.get("ask-user")!.enabled).toBe(false);
    expect(
      auditEntries.some(
        (a) => a.action === "ext:bundled:critical-auto-reapproved",
      ),
    ).toBe(false);
  }, 20_000);
});
