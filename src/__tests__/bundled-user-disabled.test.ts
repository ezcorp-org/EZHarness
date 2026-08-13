/**
 * A user's disable of a BUILT-IN survives a restart.
 *
 * Before `extensions.disabled_by_user` existed, the Extensions page's
 * toggle looked like it worked and quietly reverted: the normal exit of
 * `ensureBundledExtensions`'s existing-row branch re-enables ANY disabled
 * bundled row on every boot ("Re-enabled bundled extension"), because that
 * branch cannot tell an operator's choice apart from the damage it is
 * there to repair (a gate disable, the old integrity check). The only real
 * off switch was an env var.
 *
 * The column is that distinction, so these tests pin BOTH directions —
 * a flagged row stays off, an unflagged one is still repaired. Testing
 * only the first would let a fix that stops repairing anything pass.
 *
 * Drives the real `ensureBundledExtensions` through the same mock
 * infrastructure as `bundled-critical-s9.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface CapturedAudit {
  action: string;
  target: string | undefined;
}
const auditEntries: CapturedAudit[] = [];

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (_u: string | null, action: string, target?: string) => {
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

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  extStore.reset();
  auditEntries.length = 0;
});

/**
 * Seed a bundled row that is DISABLED and otherwise HEALTHY.
 *
 * "Healthy" is load-bearing and is why this reads the real on-disk
 * manifest instead of inventing one: a hand-written stale manifest trips
 * the S6 drift check or the S9 version gate, and both of those `continue`
 * BEFORE the re-enable branch under test. Seeded that way, every case here
 * would pass for the wrong reason — the row would stay disabled because a
 * gate disabled it, not because the user's opt-out was honoured. The
 * control case ("still repaired") is what catches that, and it is why the
 * control is in this file at all.
 *
 * `scratchpad` is deliberately a NON-critical built-in; the critical pair
 * is exercised separately below.
 */
async function seedDisabled(name: string, disabledByUser: boolean): Promise<void> {
  const { getBundledExtensionPath, getProjectRoot } = await import("../extensions/bundled");
  const { loadManifestFresh } = await import("../extensions/loader");
  const relPath = getBundledExtensionPath(name);
  if (!relPath) throw new Error(`${name} is not a bundled extension`);
  const manifest = await loadManifestFresh(join(getProjectRoot(), relPath));

  store.set(name, {
    id: `seed-${name}`,
    name,
    enabled: false,
    disabledByUser,
    isBundled: true,
    installPath: relPath,
    version: manifest.version,
    manifest,
    grantedPermissions: { grantedAt: {} },
  });
}

describe("ensureBundledExtensions — user opt-out", () => {
  test("a user-disabled built-in stays disabled across a boot", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedDisabled("scratchpad", true);

    await ensureBundledExtensions();

    expect(store.get("scratchpad")?.enabled).toBe(false);
    // The flag itself must survive too — clearing it would let the NEXT
    // boot re-enable, turning the fix into a one-restart reprieve.
    expect(store.get("scratchpad")?.disabledByUser).toBe(true);
  }, 30_000);

  test("no regrant audit is written for a row that was left alone", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedDisabled("scratchpad", true);

    await ensureBundledExtensions();

    expect(
      auditEntries.some(
        (a) => a.action === "ext:bundled:regranted" && a.target === "seed-scratchpad",
      ),
    ).toBe(false);
  }, 30_000);

  test("a built-in disabled by anything ELSE is still repaired", async () => {
    // The behaviour the column must not break: a gate disable, an old
    // integrity check, or a hand-edited row has no user intent behind it,
    // and "bundled default on" still owns that case.
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedDisabled("scratchpad", false);

    await ensureBundledExtensions();

    expect(store.get("scratchpad")?.enabled).toBe(true);
  }, 30_000);

  test("a user-disabled CRITICAL built-in stays disabled too", async () => {
    // The user's stated reason for wanting this: they may run their own
    // replacement for `ask-user`. The loop-safety floor still governs every
    // OTHER route to a disabled critical extension.
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedDisabled("ask-user", true);

    await ensureBundledExtensions();

    expect(store.get("ask-user")?.enabled).toBe(false);
  }, 30_000);

  test("control: a critical built-in disabled by anything ELSE is repaired", async () => {
    // The critical arm needs its own control for the same reason the
    // non-critical one does (see the helper's note): without it, "stays
    // disabled" cannot be told apart from "an earlier gate `continue`d
    // before the branch under test ever ran".
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedDisabled("ask-user", false);

    await ensureBundledExtensions();

    expect(store.get("ask-user")?.enabled).toBe(true);
  }, 30_000);
});
