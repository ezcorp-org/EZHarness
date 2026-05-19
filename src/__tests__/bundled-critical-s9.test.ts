/**
 * Phase D — S9 version-bump gate is CRITICAL-aware.
 *
 * Root-cause fix #3 of the harness-smoke-test loop: `ask-user` was
 * auto-disabled at boot by the S9 gate, trapping a stuck agent.
 *
 *   - version bump + perm change, within bundled ceiling, on a
 *     `critical` extension ⇒ stays enabled + auto-reapproval audit row.
 *   - version bump + perm change, EXCEEDS ceiling ⇒ disabled (security
 *     floor preserved).
 *   - non-critical extension ⇒ unchanged (regression: still disabled).
 *
 * Drives the real `ensureBundledExtensions` through the same mock
 * infrastructure as bundled-phase5-integration.test.ts.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

interface CapturedAudit {
  action: string;
  target: string | undefined;
  metadata: Record<string, unknown> | undefined;
}
const auditEntries: CapturedAudit[] = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _u: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditEntries.push({ action, target, metadata });
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

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditEntries.length = 0;
});

/**
 * Pre-seed a bundled extension's DB row with a STALE manifest (old
 * version + an S9-tracked permission the disk manifest lacks) so the
 * next `ensureBundledExtensions` cycle trips `detectVersionBump-
 * RequiringReapproval`. The S9 trigger fields are
 * [network,filesystem,shell,env,storage,lifecycleHooks]; `storage:true`
 * differs from ask-user's on-disk perms (eventSubscriptions only), and
 * the bumped-down version forces `versionChanged`.
 */
function seedStale(name: string, opts: { extraPerm?: Record<string, unknown> } = {}): void {
  store.set(name, {
    id: `seed-${name}`,
    name,
    enabled: true,
    isBundled: true,
    installPath: `docs/extensions/examples/${name}`,
    version: "0.0.1",
    manifest: {
      schemaVersion: 2,
      name,
      version: "0.0.1",
      description: "stale",
      author: { name: "EZCorp" },
      // S9-tracked perm change vs on-disk (forces the gate to fire).
      permissions: { storage: true, ...(opts.extraPerm ?? {}) },
    },
    grantedPermissions: { grantedAt: {} },
  });
}

describe("S9 critical-aware gate", () => {
  test("critical (ask-user) version-bump within ceiling ⇒ stays enabled + audit", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedStale("ask-user");

    await ensureBundledExtensions();

    const row = store.get("ask-user");
    expect(row).toBeDefined();
    // The loop-safety floor kept it enabled instead of S9-disabling it.
    expect(row?.enabled).toBe(true);
    // Version recorded so S9 doesn't re-fire next boot.
    expect(row?.version).not.toBe("0.0.1");
    // Auto-reapproval audit row written.
    const auto = auditEntries.filter(
      (a) => a.action === "ext:bundled:critical-auto-reapproved",
    );
    expect(auto.length).toBeGreaterThanOrEqual(1);
    expect(auto[0]?.target).toBe("seed-ask-user");
  }, 30_000);

  test("critical (task-tracking) version-bump within ceiling ⇒ stays enabled", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedStale("task-tracking");
    await ensureBundledExtensions();
    expect(store.get("task-tracking")?.enabled).toBe(true);
  }, 30_000);

  test("regression: non-critical (scratchpad) version-bump+perm-change ⇒ disabled", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    // scratchpad is NOT critical — S9 must still disable on a
    // version+perm change (unchanged behavior).
    seedStale("scratchpad", { extraPerm: { network: ["evil.test"] } });
    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
    // No critical auto-reapproval for a non-critical extension.
    expect(
      auditEntries.some(
        (a) =>
          a.action === "ext:bundled:critical-auto-reapproved" &&
          a.target === "seed-scratchpad",
      ),
    ).toBe(false);
  }, 30_000);
});
