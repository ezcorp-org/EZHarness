/**
 * Phase D — S9 critical gate, disk-manifest-UNREADABLE branch
 * (isolated).
 *
 * Mirrors `bundled-critical-s9-ceiling-exceeds.test.ts` but instead of
 * forcing the ceiling check to clamp, it forces the critical block's
 * own `loadManifestFresh` call (bundled.ts ~line 895) to throw so
 * `diskManifest` stays `null`. Contract: even for a `critical`
 * extension, if the on-disk manifest can't be read on a version-bump
 * S9 trip, we CANNOT prove perms are within ceiling, so the security
 * floor applies — the disable stands and the
 * "perms exceed ceiling on version bump" ERROR is logged. The startup
 * invariant (`assert-critical-extensions`) is then the loud backstop.
 *
 * Why a call-counting `loadManifestFresh` mock (not a blanket throw):
 * `detectAndLogManifestDrift` (call #1) and
 * `detectVersionBumpRequiringReapproval` (call #2) ALSO call
 * `loadManifestFresh`. If #2 throws it returns `false` and the S9
 * block never executes — the branch under test is unreachable. So the
 * mock SUCCEEDS for calls #1/#2 (returning a manifest that trips S9:
 * version + perms differ from the seeded stale DB row) and THROWS on
 * call #3 (the critical block's own read), which is exactly the
 * `diskManifest === null` path.
 *
 * `../extensions/loader`, `../db/queries/extensions` and
 * `../db/queries/audit-log` are all in mock-cleanup's MODULE_PATHS;
 * `restoreModuleMocks()` re-registers the real modules in afterAll.
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

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  version?: string;
}
let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// Per-extension call counter: succeed for the drift (#1) and
// version-bump (#2) reads, THROW on the critical block's read (#3+)
// so `diskManifest === null` inside the S9 critical branch.
const loadCalls = new Map<string, number>();
const THROW_ON_CALL = 3;

mock.module("../extensions/loader", () => ({
  loadManifestFresh: async (dir: string) => {
    // dir = <projectRoot>/docs/extensions/examples/<name>
    const name = dir.split("/").filter(Boolean).pop() ?? dir;
    const n = (loadCalls.get(name) ?? 0) + 1;
    loadCalls.set(name, n);
    if (n >= THROW_ON_CALL) {
      throw new Error("ENOENT: on-disk manifest unreadable (simulated)");
    }
    // Trips S9 vs the seeded stale row (version "0.0.1" +
    // permissions {storage:true}): bump version AND drop storage.
    return {
      schemaVersion: 2,
      name,
      version: "9.9.9",
      description: "fresh disk manifest",
      author: { name: "EZCorp" },
      permissions: {},
    };
  },
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditEntries.length = 0;
  loadCalls.clear();
});

describe("S9 critical gate — disk manifest UNREADABLE (security floor)", () => {
  test("critical version-bump but on-disk manifest unreadable ⇒ disabled, no auto-reapproval", async () => {
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
        // S9-tracked perm that the disk manifest (call #1/#2) lacks.
        permissions: { storage: true },
      },
      grantedPermissions: { grantedAt: {} },
    });

    await ensureBundledExtensions();

    const row = store.get("ask-user");
    expect(row).toBeDefined();
    // The critical block read (call #3) threw ⇒ diskManifest === null
    // ⇒ cannot prove within-ceiling ⇒ security floor: disable stands.
    expect(row?.enabled).toBe(false);
    // NOT auto-reapproved (no within-ceiling proof).
    expect(
      auditEntries.some(
        (a) => a.action === "ext:bundled:critical-auto-reapproved",
      ),
    ).toBe(false);
    // Confirm the critical block actually ran a 3rd (throwing) read —
    // i.e. the branch under test was exercised, not short-circuited.
    expect((loadCalls.get("ask-user") ?? 0)).toBeGreaterThanOrEqual(
      THROW_ON_CALL,
    );
  }, 30_000);
});
