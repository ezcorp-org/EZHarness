import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { insertAuditEntry, listAuditForExtension } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "../extensions/audit-actions";

const EXT_A = "ext-aaa-0001";
const EXT_B = "ext-bbb-0002";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("extension audit action constants", () => {
  test("EXT_AUDIT_ACTIONS values all use the 'ext:' prefix — consumed by listAuditForExtension's LIKE filter", () => {
    for (const value of Object.values(EXT_AUDIT_ACTIONS)) {
      expect(value.startsWith("ext:")).toBe(true);
    }
  });

  test("constant set is exhaustive for the thirteen audit paths (7 Phase 1 + 4 Phase 2a/b + 1 Phase 2c + 1 Phase 4)", () => {
    const keys = new Set(Object.keys(EXT_AUDIT_ACTIONS));
    expect(keys).toEqual(new Set([
      // Phase 1
      "PERMISSION_GRANTED",
      "PERMISSION_REVOKED",
      "PERMISSION_REJECTED",
      "BUNDLED_INSTALLED",
      "BUNDLED_REGRANTED",
      "MANIFEST_DRIFTED",
      "UPDATE_BLOCKED",
      // Phase 2a-lite / 2b (capability tier)
      "CAPABILITY_GRANTED",
      "CAPABILITY_REVOKED",
      "SPAWN_QUOTA_EXCEEDED",
      "EMIT_EVENT_REJECTED",
      // Phase 2c — server→extension subscription delivery
      "EVENT_SUBSCRIPTION_DENIED",
      // Phase 4 — ezcorp/cancel-run RPC
      "SPAWN_CANCELLED",
    ]));
  });

  test("capability-tier actions are distinguishable from permission-tier (different wire values)", () => {
    // The detail page must render CAPABILITY_* with a red badge vs
    // PERMISSION_* green. Wire strings must differ so the UI can
    // switch on action without re-inferring from the permission field.
    expect(EXT_AUDIT_ACTIONS.CAPABILITY_GRANTED).not.toBe(EXT_AUDIT_ACTIONS.PERMISSION_GRANTED);
    expect(EXT_AUDIT_ACTIONS.CAPABILITY_REVOKED).not.toBe(EXT_AUDIT_ACTIONS.PERMISSION_REVOKED);
  });
});

describe("listAuditForExtension", () => {
  test("returns only rows whose target matches the extension AND whose action starts with 'ext:'", async () => {
    const meta: ExtensionAuditMetadata = {
      permission: "storage",
      oldValue: false,
      newValue: true,
      actor: "system",
      reason: "bundled-install",
    };
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.BUNDLED_INSTALLED, EXT_A, meta);
    // A foreign-domain audit row with the same target id — must not leak into
    // the extension trail even though it shares the target column.
    await insertAuditEntry(null, "user:registered", EXT_A, { note: "unrelated" });
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.PERMISSION_GRANTED, EXT_B, meta);

    const rowsA = await listAuditForExtension(EXT_A);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]!.action).toBe(EXT_AUDIT_ACTIONS.BUNDLED_INSTALLED);
    expect(rowsA[0]!.target).toBe(EXT_A);

    const rowsB = await listAuditForExtension(EXT_B);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.target).toBe(EXT_B);
  });

  test("rows are ordered newest-first", async () => {
    const meta: ExtensionAuditMetadata = {
      permission: "storage",
      oldValue: true,
      newValue: false,
      actor: "admin-1",
    };
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.PERMISSION_REVOKED, EXT_A, meta);
    // Tiny delay so the second row has a strictly later createdAt timestamp.
    await new Promise((r) => setTimeout(r, 5));
    await insertAuditEntry(null, EXT_AUDIT_ACTIONS.PERMISSION_GRANTED, EXT_A, meta);

    const rows = await listAuditForExtension(EXT_A);
    // Three rows total (BUNDLED_INSTALLED from previous test + these two).
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // Newest first.
    expect(rows[0]!.action).toBe(EXT_AUDIT_ACTIONS.PERMISSION_GRANTED);
    expect(rows[1]!.action).toBe(EXT_AUDIT_ACTIONS.PERMISSION_REVOKED);
  });

  test("limit + offset paginate", async () => {
    const page1 = await listAuditForExtension(EXT_A, { limit: 1, offset: 0 });
    const page2 = await listAuditForExtension(EXT_A, { limit: 1, offset: 1 });
    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0]!.id).not.toBe(page2[0]!.id);
  });
});
