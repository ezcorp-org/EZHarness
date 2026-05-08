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

  test("constant set is exhaustive — covers every audit-emit site through Phase 7 + SDK Phase 50/51", () => {
    const keys = new Set(Object.keys(EXT_AUDIT_ACTIONS));
    expect(keys).toEqual(new Set([
      // Original Phase 1 (admin-driven grant/revoke + bundled lifecycle)
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
      // Phase 4 — ezcorp/cancel-run RPC + spawn-assignment chain
      "SPAWN_CANCELLED",
      "SPAWN_AUTHORIZED",
      // Bundled-grant backfill for eventSubscriptions (auto-heal policy)
      "BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED",
      // Per-extension settings (lazy-foraging-hammock)
      "SETTINGS_USER_UPDATED",
      "SETTINGS_USER_RESET",
      // Phase 1 PDP — every authorize() decision lands here
      "PERM_ALLOWED",
      "PERM_DENIED",
      "PERM_PROMPTED",
      // Phase 5 — bundled cap-ceiling clamp + manifest tamper detection
      "BUNDLED_CEILING_CLAMP",
      "BUNDLED_MANIFEST_TAMPER",
      // Phase 7 — MCP isolation (forward proxy + Linux netns)
      "MCP_NETNS_CREATED",
      "MCP_NETNS_FALLBACK",
      "MCP_HOST_BLOCKED",
      // Phase 50 — SDK capability tier (audit-actions for Phase 51 handlers)
      "SDK_LLM_CALL",
      "SDK_LLM_REJECTED",
      "SDK_MEMORY_READ",
      "SDK_MEMORY_WRITE",
      "SDK_MEMORY_REJECTED",
      "SDK_LESSONS_READ",
      "SDK_LESSONS_WRITE",
      "SDK_LESSONS_REJECTED",
      "SDK_SCHEDULE_REGISTERED",
      "SDK_SCHEDULE_FIRE",
      "SDK_SCHEDULE_REJECTED",
      "SDK_EVENT_SUBSCRIBED",
      "SDK_EVENT_DELIVERY_REJECTED",
      // Phase 51 — sampled delivery, daemon self-heal, env-key migration
      "SDK_EVENT_DELIVERED",
      "SDK_SCHEDULE_DISABLED",
      "ENV_KEY_LEAK_WARNING",
      "SDK_LLM_DENIED_AND_DISABLED",
      "SDK_LESSONS_VISIBILITY_CLAMPED",
      "SDK_SCHEDULE_FIRE_NOW",
      "SDK_SCHEDULE_QUOTA_EXCEEDED",
      "SDK_SCHEDULE_REAPED",
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
