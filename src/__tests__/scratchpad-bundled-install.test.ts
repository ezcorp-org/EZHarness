import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// insertAuditEntry is mocked to a no-op because this file uses
// store-level mocks of `../db/queries/extensions` (no real DB), so the
// audit-write calls inside bundled.ts would otherwise hit an
// unavailable `getDb()`. The `afterAll(restoreModuleMocks)` below
// undoes the mock via the snapshotted real exports in preload.ts so
// subsequent test files (e.g. extension-audit-actions.test.ts) see the
// real module — the path is listed in MODULE_PATHS inside
// `./helpers/mock-cleanup.ts` for this restoration to work.
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

import {
  resolveBundledExtensions,
  isBundledExtensionName,
} from "../extensions/bundled";

beforeEach(() => {
  extStore.reset();
});

describe("resolveBundledExtensions — scratchpad entry", () => {
  test("includes scratchpad by default with no opt-out flag", () => {
    const list = resolveBundledExtensions({});
    expect(list.some((e) => e.name === "scratchpad")).toBe(true);
  });

  test("scratchpad cannot be disabled via any env flag (security by default)", () => {
    // Simulate common opt-out attempts that affect other bundled exts.
    const attempts: Record<string, string>[] = [
      { EZCORP_DISABLE_AI_KIT: "1" },
      { EZCORP_DISABLE_SCRATCHPAD: "1" },
      { EZCORP_NO_BUNDLED: "1" },
    ];
    for (const env of attempts) {
      const list = resolveBundledExtensions(env);
      expect(list.some((e) => e.name === "scratchpad")).toBe(true);
    }
  });

  test("scratchpad entry declares only the storage permission — no network/fs/shell/env", () => {
    const list = resolveBundledExtensions({});
    const entry = list.find((e) => e.name === "scratchpad")!;
    expect(entry.path).toBe("docs/extensions/examples/scratchpad");
    expect(entry.permissions.storage).toBe(true);
    // S1-S4: nothing else should be granted.
    expect(entry.permissions.network).toBeUndefined();
    expect(entry.permissions.filesystem).toBeUndefined();
    expect(entry.permissions.shell).toBeUndefined();
    expect(entry.permissions.env).toBeUndefined();
    // Must record a grant timestamp so the audit path can write oldValue/newValue.
    expect(entry.permissions.grantedAt["storage"]).toBeGreaterThan(0);
  });
});

describe("isBundledExtensionName — scratchpad is recognized", () => {
  test("returns true for 'scratchpad' so the integrity check is skipped on spawn", () => {
    // Dev edits to docs/extensions/examples/scratchpad/* must not brick the
    // subprocess — see bundled.ts:141-157 for the rationale.
    expect(isBundledExtensionName("scratchpad")).toBe(true);
  });

  test("returns false for unrelated names", () => {
    expect(isBundledExtensionName("user-installed-ext")).toBe(false);
  });
});
