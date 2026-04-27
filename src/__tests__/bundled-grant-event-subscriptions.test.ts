/**
 * Bundled-grant ↔ on-disk-manifest reconciliation for the
 * `eventSubscriptions` permission field.
 *
 * Reproduces the production bug: an extension was installed BEFORE
 * `eventSubscriptions: ["claude-design:knob-change"]` was added to its
 * `bundled.ts` entry. Subsequent boots ran `ensureBundledExtensions`
 * and called `detectAndLogManifestDrift`, but the legacy drift check
 * only inspected `network/filesystem/shell/env/storage/lifecycleHooks`
 * — `eventSubscriptions` divergence was invisible. The runtime
 * `granted_permissions` row therefore stayed empty for the field, the
 * dispatcher skipped registration, and `POST /api/extensions/claude-design/
 * events/knob-change` returned 404 from the SSE-filter gate.
 *
 * Closes link #2 (bundled grant) and #3 (drift detection) of the
 * canvas knob-change flow.
 *
 * Policy locked in by these tests (see `detectAndLogManifestDrift`'s
 * doc comment for the rationale):
 *   - eventSubscriptions: AUTO-HEAL via union-merge. Disk additions
 *     are propagated into both `granted_permissions.eventSubscriptions`
 *     AND `manifest.permissions.eventSubscriptions`, then audited as
 *     `BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED`.
 *   - network/filesystem/shell/env/storage: WARN-AND-FAIL-CLOSED
 *     (legacy MANIFEST_DRIFTED behavior, untouched here).
 *
 * The test names spell out the chosen policy so a reviewer who's
 * looking for "do we auto-heal X here?" can grep this file.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mock the DB-queries module so ensureBundledExtensions sees a
// pre-seeded "claude-design" row whose grant lacks eventSubscriptions.
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
    env?: string[];
    filesystem?: string[];
    shell?: boolean;
    storage?: boolean;
    eventSubscriptions?: string[];
    grantedAt: Record<string, number>;
  };
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
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// Capture every audit_log write — drift, regrant, backfill — so each
// test can assert on the exact action that fired.
interface AuditCall {
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}
const auditCalls: AuditCall[] = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditCalls.push({
      action,
      ...(target !== undefined ? { target } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

afterAll(() => restoreModuleMocks());

import { ensureBundledExtensions } from "../extensions/bundled";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditCalls.length = 0;
});

// ── Helpers ──────────────────────────────────────────────────────────

/** Seed the store with a "stale" claude-design row that mimics a
 *  pre-eventSubscriptions install. The on-disk manifest (loaded by
 *  ensureBundledExtensions via loadManifestFresh) declares the new
 *  subscription; this row's grant + manifest do not. */
function seedStaleClaudeDesign(): StoredExtension {
  const row: StoredExtension = {
    id: "ext-stale-claude-design",
    name: "claude-design",
    installPath: "docs/extensions/examples/claude-design",
    enabled: true,
    isBundled: true,
    manifest: {
      schemaVersion: 2,
      name: "claude-design",
      // Match disk version exactly so the S9 version-bump gate doesn't
      // engage — this test isolates the drift-vs-grant divergence.
      version: "0.1.0",
      permissions: {
        filesystem: ["$CWD"],
        shell: false,
        storage: true,
        network: ["cdn.jsdelivr.net"],
        // eventSubscriptions intentionally missing — that's the bug.
      },
    },
    grantedPermissions: {
      filesystem: ["$CWD"],
      storage: true,
      network: ["cdn.jsdelivr.net"],
      // eventSubscriptions intentionally missing — runtime would skip
      // dispatcher registration → POST returns 404.
      grantedAt: {
        filesystem: 1,
        storage: 1,
        network: 1,
      },
    },
  };
  store.set(row.name, row);
  return row;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ensureBundledExtensions — eventSubscriptions auto-heal (drift policy)", () => {
  test("preexisting row with NO eventSubscriptions in grant → backfilled with disk additions", async () => {
    seedStaleClaudeDesign();
    await ensureBundledExtensions();
    const row = store.get("claude-design")!;
    // Disk declares ["claude-design:knob-change"]; auto-heal must
    // surface it on the runtime grant so the dispatcher picks it up.
    expect(row.grantedPermissions.eventSubscriptions).toEqual([
      "claude-design:knob-change",
    ]);
    // The DB-stored manifest's permissions block is also backfilled so
    // future drift checks don't see a fake mismatch.
    expect(
      (row.manifest.permissions as { eventSubscriptions?: string[] }).eventSubscriptions,
    ).toEqual(["claude-design:knob-change"]);
    // grantedAt timestamp tracks the heal.
    expect(typeof row.grantedPermissions.grantedAt.eventSubscriptions).toBe("number");
  });

  test("backfill emits exactly one BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED audit row", async () => {
    seedStaleClaudeDesign();
    await ensureBundledExtensions();
    const backfillAudits = auditCalls.filter(
      (c) => c.action === EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
    );
    expect(backfillAudits).toHaveLength(1);
    expect(backfillAudits[0]!.target).toBe("ext-stale-claude-design");
    const meta = backfillAudits[0]!.metadata as {
      permission: string;
      oldValue: string[];
      newValue: string[];
      actor: string;
    };
    expect(meta.permission).toBe("eventSubscriptions");
    expect(meta.oldValue).toEqual([]);
    expect(meta.newValue).toEqual(["claude-design:knob-change"]);
    expect(meta.actor).toBe("system");
  });

  test("backfill is idempotent — second boot does not re-fire the audit", async () => {
    seedStaleClaudeDesign();
    await ensureBundledExtensions();
    auditCalls.length = 0; // discard first-boot audits
    await ensureBundledExtensions();
    expect(
      auditCalls.filter(
        (c) => c.action === EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
      ),
    ).toHaveLength(0);
    // Grant remains the union — no duplication.
    const row = store.get("claude-design")!;
    expect(row.grantedPermissions.eventSubscriptions).toEqual([
      "claude-design:knob-change",
    ]);
  });

  test("when grant ALREADY contains the disk subscription → no backfill, no audit", async () => {
    const row = seedStaleClaudeDesign();
    row.grantedPermissions.eventSubscriptions = ["claude-design:knob-change"];
    row.grantedPermissions.grantedAt.eventSubscriptions = 100;
    (row.manifest.permissions as Record<string, unknown>).eventSubscriptions = [
      "claude-design:knob-change",
    ];
    await ensureBundledExtensions();
    expect(
      auditCalls.filter(
        (c) => c.action === EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
      ),
    ).toHaveLength(0);
  });

  test("union-merge preserves grant entries the disk does NOT declare (no removal)", async () => {
    // Operator (or prior bundled.ts) granted a stray subscription that
    // the current disk manifest no longer declares. Auto-heal MUST
    // only ADD; it must not silently revoke. Removal is the operator's
    // job at re-install time — same fail-closed policy as
    // network/filesystem.
    const row = seedStaleClaudeDesign();
    row.grantedPermissions.eventSubscriptions = ["legacy:event"];
    row.grantedPermissions.grantedAt.eventSubscriptions = 100;
    await ensureBundledExtensions();
    const updated = store.get("claude-design")!;
    expect(updated.grantedPermissions.eventSubscriptions).toEqual([
      "legacy:event",
      "claude-design:knob-change",
    ]);
  });

  test("network drift on the SAME row → MANIFEST_DRIFTED warns-and-fails-closed (legacy policy unchanged)", async () => {
    // Co-locate the auto-heal path with the legacy fail-closed path
    // to prove they coexist on a single row. The grant for `network`
    // must NOT be auto-healed — only the drift-warn audit fires.
    const row = seedStaleClaudeDesign();
    // DB grant lists fewer hosts than disk — drift on the safety
    // boundary; must NOT auto-heal.
    row.grantedPermissions.network = ["cdn.jsdelivr.net"];
    row.manifest.permissions = {
      ...(row.manifest.permissions as Record<string, unknown>),
      network: ["only-the-old-cdn.example.com"],
    };
    await ensureBundledExtensions();
    const updated = store.get("claude-design")!;
    // network grant unchanged — fail-closed.
    expect(updated.grantedPermissions.network).toEqual(["cdn.jsdelivr.net"]);
    // BUT the drift audit fires for `network`.
    const driftAudits = auditCalls.filter(
      (c) =>
        c.action === EXT_AUDIT_ACTIONS.MANIFEST_DRIFTED &&
        (c.metadata as { permission?: string })?.permission === "network",
    );
    expect(driftAudits.length).toBeGreaterThanOrEqual(1);
    // AND the eventSubscriptions backfill audit fires (independent path).
    const backfillAudits = auditCalls.filter(
      (c) => c.action === EXT_AUDIT_ACTIONS.BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED,
    );
    expect(backfillAudits).toHaveLength(1);
  });
});
