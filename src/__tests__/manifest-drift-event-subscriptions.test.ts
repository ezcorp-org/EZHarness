/**
 * Unit-level coverage for `detectAndLogManifestDrift`'s eventSubscriptions
 * branch. Different angle from `bundled-grant-event-subscriptions.test.ts`:
 * that suite exercises end-to-end through `ensureBundledExtensions` with
 * the real `claude-design` on-disk manifest. This one isolates the
 * decision matrix — additions / removals / partial overlap / null-safety —
 * against tightly-controlled stub manifests.
 *
 * The drift function isn't exported, so we drive it via the same boot
 * loop but pre-mock `loadManifestFresh` so each test case can dictate
 * exactly what the on-disk manifest declares. This is the leanest way
 * to fence in the auto-heal logic without standing up the real
 * `docs/extensions/examples/...` tree.
 *
 * Closes link #3 (drift detection) at the unit-test scale.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── DB stub (same shape as bundled-grant-event-subscriptions.test.ts) ──

interface StoredExtension {
  id: string;
  name: string;
  manifest: { schemaVersion: 2; name: string; version: string; permissions?: Record<string, unknown> } & Record<string, unknown>;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  consecutiveFailures?: number;
  grantedPermissions: {
    network?: string[];
    eventSubscriptions?: string[];
    grantedAt: Record<string, number>;
    [k: string]: unknown;
  };
}

let store: Map<string, StoredExtension>;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async () => {
    throw new Error("createExtension should not be invoked — fixtures pre-seed");
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

// Capture audits — flag-shaped: name → count.
const auditCounts = new Map<string, number>();
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    _target?: string,
    _metadata?: Record<string, unknown>,
  ) => {
    auditCounts.set(action, (auditCounts.get(action) ?? 0) + 1);
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// Mock loadManifestFresh so tests can dictate the on-disk manifest.
// `mockDiskManifest` is used ONLY when the load path matches the
// target's installPath — for every other bundled entry the loader
// returns a benign permissions-empty manifest so unrelated entries
// don't accidentally trip the auto-heal branch on this fixture.
let mockDiskManifest: { permissions?: Record<string, unknown> } & Record<string, unknown> = {
  schemaVersion: 2,
  name: "stub-ext",
  version: "0.0.0",
  description: "stub",
  author: { name: "stub" },
  entrypoint: "./index.ts",
  tools: [],
};
const TARGET_INSTALL_DIR = "docs/extensions/examples/claude-design";
mock.module("../extensions/loader", () => ({
  loadManifestFresh: async (dir: string) => {
    if (dir.endsWith(TARGET_INSTALL_DIR)) return mockDiskManifest;
    return {
      schemaVersion: 2,
      name: "noop",
      version: "0.0.0",
      description: "noop",
      author: { name: "noop" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: {},
    };
  },
  loadManifest: async () => mockDiskManifest,
}));

// installer.installFromLocal must not fire for these tests — we always
// pre-seed the row.
mock.module("../extensions/installer", () => ({
  installFromLocal: async () => {
    throw new Error("installFromLocal must not run — every test pre-seeds the row");
  },
}));

// migrations subpath gets imported lazily inside ensureBundledExtensions —
// stub it so we don't touch the real DB.
mock.module("../extensions/migrations/task-tracking-storage", () => ({
  migrateBuiltinTaskStorage: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

// Import bundled.ts AFTER all mocks so its top-level `getExtensionByName`,
// `loadManifestFresh`, etc. references resolve to the stubs.
import { ensureBundledExtensions } from "../extensions/bundled";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

beforeEach(() => {
  store = new Map();
  auditCounts.clear();
});

/** Pre-seed every bundled-extension name with a row whose grant matches
 *  the bundled.ts entry's declared permissions. This lets us inspect a
 *  SINGLE target extension (`claude-design`) while every other bundled
 *  entry is a no-op (drift returns no diff). */
function seedAll(target: { name: string; row: StoredExtension }): void {
  // `bundled.ts` iterates BUNDLED_EXTENSIONS; we only need a row for
  // entries that would otherwise hit `installFromLocal` (which we
  // mock-throw on). Easier to seed our target and let the rest fall
  // through to `installFromLocal` — which throws — but the catch in
  // `ensureBundledExtensions` swallows install errors per-entry, so
  // the loop keeps going. The `await migrateBuiltinTaskStorage` call
  // afterwards reads `task-tracking` so we seed that one too as a
  // no-op row.
  store.set(target.name, target.row);
  store.set("task-tracking", {
    id: "ext-tt",
    name: "task-tracking",
    installPath: "docs/extensions/examples/task-tracking",
    enabled: true,
    isBundled: true,
    manifest: { schemaVersion: 2, name: "task-tracking", version: "0.0.0" },
    grantedPermissions: { grantedAt: {} },
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe("detectAndLogManifestDrift — eventSubscriptions decision matrix", () => {
  test("disk declares ≥1 subscription not on the grant → backfill audit fires", async () => {
    mockDiskManifest = {
      schemaVersion: 2,
      name: "claude-design",
      version: "0.1.0",
      description: "stub",
      author: { name: "stub" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: { eventSubscriptions: ["claude-design:knob-change"] },
    };
    seedAll({
      name: "claude-design",
      row: {
        id: "ext-1",
        name: "claude-design",
        installPath: "docs/extensions/examples/claude-design",
        enabled: true,
        isBundled: true,
        manifest: {
          schemaVersion: 2,
          name: "claude-design",
          version: "0.1.0",
          permissions: {},
        },
        grantedPermissions: { grantedAt: {} },
      },
    });
    await ensureBundledExtensions();
    expect(auditCounts.get(EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED) ?? 0)
      .toBe(1);
    expect(store.get("claude-design")!.grantedPermissions.eventSubscriptions).toEqual([
      "claude-design:knob-change",
    ]);
  });

  test("disk and grant match exactly → no backfill audit", async () => {
    mockDiskManifest = {
      schemaVersion: 2,
      name: "claude-design",
      version: "0.1.0",
      description: "stub",
      author: { name: "stub" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: { eventSubscriptions: ["claude-design:knob-change"] },
    };
    seedAll({
      name: "claude-design",
      row: {
        id: "ext-1",
        name: "claude-design",
        installPath: "docs/extensions/examples/claude-design",
        enabled: true,
        isBundled: true,
        manifest: {
          schemaVersion: 2,
          name: "claude-design",
          version: "0.1.0",
          permissions: { eventSubscriptions: ["claude-design:knob-change"] },
        },
        grantedPermissions: {
          eventSubscriptions: ["claude-design:knob-change"],
          grantedAt: { eventSubscriptions: 1 },
        },
      },
    });
    await ensureBundledExtensions();
    expect(auditCounts.get(EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED) ?? 0)
      .toBe(0);
  });

  test("disk omits an entry the grant has → grant entry is preserved (additions-only)", async () => {
    // Removal-only deltas must NOT be propagated. The grant retains
    // its legacy entry; no audit fires.
    mockDiskManifest = {
      schemaVersion: 2,
      name: "claude-design",
      version: "0.1.0",
      description: "stub",
      author: { name: "stub" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: { eventSubscriptions: [] },
    };
    seedAll({
      name: "claude-design",
      row: {
        id: "ext-1",
        name: "claude-design",
        installPath: "docs/extensions/examples/claude-design",
        enabled: true,
        isBundled: true,
        manifest: {
          schemaVersion: 2,
          name: "claude-design",
          version: "0.1.0",
          permissions: { eventSubscriptions: ["legacy:event"] },
        },
        grantedPermissions: {
          eventSubscriptions: ["legacy:event"],
          grantedAt: { eventSubscriptions: 1 },
        },
      },
    });
    await ensureBundledExtensions();
    expect(auditCounts.get(EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED) ?? 0)
      .toBe(0);
    expect(store.get("claude-design")!.grantedPermissions.eventSubscriptions).toEqual([
      "legacy:event",
    ]);
  });

  test("partial overlap (disk adds two, grant has one different) → union-merge", async () => {
    mockDiskManifest = {
      schemaVersion: 2,
      name: "claude-design",
      version: "0.1.0",
      description: "stub",
      author: { name: "stub" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: {
        eventSubscriptions: ["claude-design:knob-change", "claude-design:close"],
      },
    };
    seedAll({
      name: "claude-design",
      row: {
        id: "ext-1",
        name: "claude-design",
        installPath: "docs/extensions/examples/claude-design",
        enabled: true,
        isBundled: true,
        manifest: {
          schemaVersion: 2,
          name: "claude-design",
          version: "0.1.0",
          permissions: { eventSubscriptions: ["legacy:event"] },
        },
        grantedPermissions: {
          eventSubscriptions: ["legacy:event"],
          grantedAt: { eventSubscriptions: 1 },
        },
      },
    });
    await ensureBundledExtensions();
    expect(store.get("claude-design")!.grantedPermissions.eventSubscriptions).toEqual([
      "legacy:event",
      "claude-design:knob-change",
      "claude-design:close",
    ]);
    expect(auditCounts.get(EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED) ?? 0)
      .toBe(1);
  });

  test("disk has eventSubscriptions but grant.eventSubscriptions is undefined → backfilled to [diskValues]", async () => {
    // Real-world bug shape: the row was installed BEFORE the field
    // existed in `bundled.ts`, so `grantedPermissions.eventSubscriptions`
    // is `undefined`, not `[]`. Both must be treated identically.
    mockDiskManifest = {
      schemaVersion: 2,
      name: "claude-design",
      version: "0.1.0",
      description: "stub",
      author: { name: "stub" },
      entrypoint: "./index.ts",
      tools: [],
      permissions: { eventSubscriptions: ["claude-design:knob-change"] },
    };
    seedAll({
      name: "claude-design",
      row: {
        id: "ext-1",
        name: "claude-design",
        installPath: "docs/extensions/examples/claude-design",
        enabled: true,
        isBundled: true,
        manifest: {
          schemaVersion: 2,
          name: "claude-design",
          version: "0.1.0",
          permissions: {}, // legacy shape — no field at all
        },
        grantedPermissions: { grantedAt: {} },
      },
    });
    await ensureBundledExtensions();
    const row = store.get("claude-design")!;
    expect(row.grantedPermissions.eventSubscriptions).toEqual([
      "claude-design:knob-change",
    ]);
    expect(auditCounts.get(EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED) ?? 0)
      .toBe(1);
  });
});
