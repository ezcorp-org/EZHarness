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

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  extStore.reset();
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
function seedStale(
  name: string,
  opts: { extraPerm?: Record<string, unknown>; disabledByUser?: boolean } = {},
): void {
  store.set(name, {
    id: `seed-${name}`,
    name,
    // A user-disabled row arrives here already OFF; every other case is ON.
    enabled: opts.disabledByUser !== true,
    ...(opts.disabledByUser === true ? { disabledByUser: true } : {}),
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

  // A version bump is not consent to undo the user's choice. This branch is
  // the ONE place the auto-accept writes `enabled`, and it is reached on
  // essentially every boot for `extension-author` (its tool list churns), so
  // getting it wrong would hand a user back the extension they switched off
  // within one restart. Mutating `enabled: !existing.disabledByUser` to a
  // bare `enabled: true` used to leave the whole suite green.
  test("a user-disabled CRITICAL extension is NOT re-enabled by the auto-accept", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedStale("ask-user", { disabledByUser: true });

    await ensureBundledExtensions();

    const row = store.get("ask-user");
    expect(row?.enabled).toBe(false);
    expect(row?.disabledByUser).toBe(true);
  }, 30_000);

  test("...but its manifest and version still converge on disk", async () => {
    // The other half of the promise: the row is left OFF, not left STALE. If
    // the refresh were skipped, re-enabling later would resurrect the
    // pre-bump code, and S9 would re-fire on every subsequent boot.
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedStale("ask-user", { disabledByUser: true });

    await ensureBundledExtensions();

    expect(store.get("ask-user")?.version).not.toBe("0.0.1");
  }, 30_000);

  test("control: the SAME bump on a NOT-user-disabled row still auto-accepts", async () => {
    // Without this arm the two tests above would also pass if the auto-accept
    // stopped enabling anything at all.
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedStale("ask-user");

    await ensureBundledExtensions();

    expect(store.get("ask-user")?.enabled).toBe(true);
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
