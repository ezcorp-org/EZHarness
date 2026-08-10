/**
 * Phase D — S9 critical gate, ceiling-EXCEEDS branch.
 *
 * Isolated in its own file because it `mock.module`s
 * `../extensions/bundled-ceiling` to force the on-disk perms to exceed
 * the ceiling — that mock must be file-scoped (restored only in
 * afterAll) so it cannot pollute the within-ceiling / regression tests
 * in bundled-critical-s9.test.ts.
 *
 * Contract: a `critical` extension whose version-bumped permissions
 * EXCEED the bundled ceiling is NOT auto-reapproved — the disable
 * stands (security floor) and no auto-reapproval audit row is written.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

interface CapturedAudit {
  action: string;
  target: string | undefined;
}
const auditEntries: CapturedAudit[] = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _u: string | null,
    action: string,
    target?: string,
  ) => {
    auditEntries.push({ action, target });
    return `audit-${auditEntries.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });
const store = extStore.store;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// Force ask-user's on-disk perms to EXCEED the ceiling.
mock.module("../extensions/bundled-ceiling", () => ({
  getCeiling: (n: string) => (n === "ask-user" ? { grantedAt: {} } : null),
  clampToBundledCeiling: (n: string, requested: ExtensionPermissions) => {
    if (n === "ask-user") {
      return { effective: { grantedAt: {} }, clamped: true };
    }
    return { effective: requested, clamped: false };
  },
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  extStore.reset();
  auditEntries.length = 0;
});

describe("S9 critical gate — ceiling EXCEEDS (security floor)", () => {
  test("critical version-bump exceeding ceiling ⇒ disabled, no auto-reapproval", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    store.set("ask-user", {
      id: "seed-ask-user",
      name: "ask-user",
      enabled: true,
      isBundled: true,
      installPath: "docs/extensions/examples/ask-user",
      version: "0.0.1",
      manifest: {
        schemaVersion: 2,
        name: "ask-user",
        version: "0.0.1",
        description: "stale",
        author: { name: "EZCorp" },
        permissions: { storage: true },
      },
      grantedPermissions: { grantedAt: {} },
    });

    await ensureBundledExtensions();

    const row = store.get("ask-user");
    // Security floor preserved even though ask-user is critical.
    expect(row?.enabled).toBe(false);
    expect(
      auditEntries.some(
        (a) => a.action === "ext:bundled:critical-auto-reapproved",
      ),
    ).toBe(false);
  }, 30_000);
});
