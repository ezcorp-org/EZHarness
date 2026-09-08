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
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";
import { getProjectRoot } from "../extensions/bundled";
import { join } from "node:path";

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


describe("scratchpad source registration", () => {
  async function manifest() {
    return discoverFirstPartyManifest(join(getProjectRoot(), "docs/extensions/examples/scratchpad"));
  }

  test("discovers a v4 scratchpad source through the isolated runner", async () => {
    const discovered = await manifest();
    expect(discovered.schemaVersion).toBe(4);
    expect(discovered.name).toBe("scratchpad");
    expect(discovered.entrypoint).toBe("./extension.ts");
  });

  test("declares write and read tools as separate current operations", async () => {
    const names = (await manifest()).tools?.map((tool) => tool.name).sort();
    expect(names).toEqual(["scratchpad_read", "scratchpad_write"]);
    expect(names).not.toContain("scratchpad_delete");
    expect(names).not.toContain("shell");
  });

  test("requires a key and value for writes in the discovered source", async () => {
    const write = (await manifest()).tools?.find((tool) => tool.name === "scratchpad_write");
    expect(write).toBeDefined();
    expect(JSON.stringify(write?.inputSchema)).toContain('"key"');
    expect(JSON.stringify(write?.inputSchema)).toContain('"value"');
  });

  test("requires a key for reads in the discovered source", async () => {
    const read = (await manifest()).tools?.find((tool) => tool.name === "scratchpad_read");
    expect(read).toBeDefined();
    expect(JSON.stringify(read?.inputSchema)).toContain('"key"');
    expect(JSON.stringify(read?.inputSchema)).not.toContain('"value"');
  });

  test("limits the source to conversation storage capability", async () => {
    const permissions = (await manifest()).permissions;
    expect(permissions.storage).toBe(true);
    expect(permissions.network).toBeUndefined();
    expect(permissions.filesystem).toBeUndefined();
  });

  test("does not make scratchpad a persistent boot worker", async () => {
    const discovered = await manifest();
    expect(discovered.persistent).toBe(false);
    expect(discovered.permissions.shell).toBeUndefined();
    expect(discovered.permissions.env).toBeUndefined();
  });
});
