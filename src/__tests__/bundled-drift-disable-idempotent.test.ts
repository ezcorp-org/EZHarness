/**
 * D4 — `ensureBundledExtensions` must not re-disable + re-warn rows that
 * are ALREADY disabled-pending-reapproval on every boot.
 *
 * The S6 drift check (`detectAndLogManifestDrift`) + the S9 version-bump
 * gate fire on every boot for a non-critical bundled extension whose
 * on-disk manifest drifted. Before this fix, the SECOND and subsequent
 * boots of an already-disabled row re-logged the fail-closed WARN +
 * "disabled pending re-approval" WARN and re-wrote `enabled:false` (the
 * live host re-spammed this for ~10 extensions every boot).
 *
 * Contract:
 *   - Transition boot (enabled + drifted): WARN + disable + audit.
 *   - Subsequent boot (already disabled + still drifted): NO enabled
 *     write, INFO-level logs (same diff payload), NO drift re-audit.
 *   - Drifted-but-ENABLED still takes the full WARN + disable path.
 *
 * Drives the real `ensureBundledExtensions` through the same in-memory
 * store mock pattern as bundled-critical-s9.test.ts.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions } from "../extensions/types";

// NOTE: we deliberately do NOT mock `../logger`. The log-LEVEL demotion
// (warn → info) is a code-review-visible detail; the BEHAVIORAL contract
// — no redundant `enabled:false` write + no drift re-audit on the
// subsequent boot — is fully observable via the updateExtension call
// tracker and the audit capture below. Mocking the logger here would
// also trip the bun mock.module materialization freeze for any parallel
// suite that imports `../logger` for real.

// ── Captured audit rows ─────────────────────────────────────────────
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

// ── In-memory extensions store + updateExtension call tracking ──────
interface StoredExtension {
  id: string;
  name: string;
  description?: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  version?: string;
}
let store: Map<string, StoredExtension>;
let nextId = 0;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

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
    updateCalls.push({ id, patch: patch as Record<string, unknown> });
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

// Task-tracking migration pulls the real PGlite driver — stub it.
mock.module("../extensions/migrations/task-tracking-storage", () => ({
  migrateBuiltinTaskStorage: async () => {},
}));

// Bundled-lock verifies the disk manifest's tool hash against
// manifest.lock.json. The D3 description-sync test seeds a row from the
// real disk manifest (no drift) and only the normal refresh path runs —
// stub the verifier to always-ok so a lockfile lag doesn't disable the
// row before the refresh. The D4 disable tests don't reach the lock
// check (S9 continues before it), so this stub is inert for them.
mock.module("../extensions/bundled-lock", () => ({
  verifyManifestAgainstLock: async () => ({ ok: true }),
  canonicalizeAndHash: () => "sha256-stub",
  loadManifestLock: async () => ({ schemaVersion: 1, generatedAt: "", extensions: {} }),
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditEntries.length = 0;
  updateCalls.length = 0;
});

/**
 * Seed a non-critical bundled extension (`scratchpad`) with a STALE
 * manifest: old version + an S9-tracked permission the on-disk manifest
 * lacks (`network`), so `detectVersionBumpRequiringReapproval` fires and
 * `detectAndLogManifestDrift` reports the `network` diff. `scratchpad`
 * is NOT critical, so S9 disables it.
 */
function seedDriftedScratchpad(enabled: boolean): void {
  store.set("scratchpad", {
    id: "seed-scratchpad",
    name: "scratchpad",
    description: "stale description",
    enabled,
    isBundled: true,
    installPath: "docs/extensions/examples/scratchpad",
    version: "0.0.1",
    manifest: {
      schemaVersion: 2,
      name: "scratchpad",
      version: "0.0.1",
      description: "stale description",
      author: { name: "EZCorp" },
      // network is an S9-tracked field absent from scratchpad's on-disk
      // perms → both the S6 drift diff and the S9 gate fire.
      permissions: { storage: true, network: ["evil.test"] },
    },
    grantedPermissions: { grantedAt: {} },
  });
}

function scratchpadEnabledWrites(): number {
  return updateCalls.filter(
    (c) => c.id === "seed-scratchpad" && c.patch.enabled === false,
  ).length;
}

describe("D4 — already-disabled drifted bundle is idempotent", () => {
  test("transition boot: enabled + drifted ⇒ WARN + disable + audit", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    seedDriftedScratchpad(true);

    await ensureBundledExtensions();

    // Disabled fail-closed.
    expect(store.get("scratchpad")?.enabled).toBe(false);
    // Audit rows written (drift + update-blocked) — the durable record
    // of the transition.
    expect(
      auditEntries.some((a) => a.action === "ext:manifest-drifted"),
    ).toBe(true);
    expect(
      auditEntries.some((a) => a.action === "ext:update-blocked"),
    ).toBe(true);
    // Exactly one enabled:false write.
    expect(scratchpadEnabledWrites()).toBe(1);
  }, 30_000);

  test("subsequent boot: already disabled + still drifted ⇒ INFO, no enabled write, no drift re-audit", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    // Row is ALREADY disabled (the transition already happened) and the
    // DB manifest is still stale (the S9 disable path continues before
    // the refresh, so the drift persists across boots).
    seedDriftedScratchpad(false);

    await ensureBundledExtensions();

    // Still disabled — unchanged.
    expect(store.get("scratchpad")?.enabled).toBe(false);
    // NO redundant enabled:false write — the core de-spam behavior.
    expect(scratchpadEnabledWrites()).toBe(0);
    // No drift re-audit on the subsequent boot (the transition already
    // recorded it; re-writing would be audit-log spam).
    expect(
      auditEntries.some((a) => a.action === "ext:manifest-drifted"),
    ).toBe(false);
  }, 30_000);

  test("drifted-but-ENABLED still takes the full WARN + disable path", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    // Simulate an operator who manually re-enabled a still-drifted row:
    // it must NOT be treated as "already disabled" — full path applies.
    seedDriftedScratchpad(true);

    await ensureBundledExtensions();

    // Full path: disabled with exactly one enabled:false write + drift
    // audit (proving the "already disabled" demotion keys on enabled,
    // not merely on drift presence).
    expect(store.get("scratchpad")?.enabled).toBe(false);
    expect(scratchpadEnabledWrites()).toBe(1);
    expect(
      auditEntries.some((a) => a.action === "ext:manifest-drifted"),
    ).toBe(true);
  }, 30_000);
});

describe("D3 — boot refresh syncs the denormalized description column", () => {
  test("a stale description column is re-synced from the disk manifest on the next boot", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");

    // Boot once to install every bundled extension fresh from disk.
    await ensureBundledExtensions();
    const md = store.get("markdown-utils");
    expect(md).toBeDefined();
    const diskDescription = md!.description;
    expect(typeof diskDescription).toBe("string");
    expect(diskDescription!.length).toBeGreaterThan(0);

    // Corrupt ONLY the denormalized column (the manifest jsonb stays in
    // sync — this is the exact live repro shape: the jsonb refreshed but
    // the column lagged). Clear the update tracker so we measure only the
    // second boot's writes.
    md!.description = "Keyless by default (Jina AI)";
    updateCalls.length = 0;

    // Second boot: the refresh path detects the column drift and re-syncs.
    await ensureBundledExtensions();
    expect(store.get("markdown-utils")!.description).toBe(diskDescription);
    // The refresh write carried the description column.
    expect(
      updateCalls.some(
        (c) =>
          c.id === md!.id &&
          c.patch.description === diskDescription,
      ),
    ).toBe(true);
  }, 30_000);
});
