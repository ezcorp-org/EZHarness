/**
 * Phase 54 SEC-02 — dropped audit rows are observable.
 *
 * Pre-fix: `permission-engine.ts:writeAuditRow` had an EMPTY catch
 * block. If `insertAuditEntry` threw (e.g. PGlite hiccup, FK violation,
 * audit_log table missing in a migration window), the failure was
 * swallowed silently — the PDP returned its decision, but the audit
 * trail was gone with no signal for SOC 2 / SIEM dashboards.
 *
 * Post-fix: the catch invokes
 *   `logger.error("PermissionEngine: audit-write failure", {action, extensionId, capabilityKind, error})`
 * which:
 *   - emits a JSON line on stderr (visible to fleet monitoring)
 *   - persists to the `error_logs` table (visible to admin UI) via
 *     the recursion-guarded fire-and-forget hook in `src/logger.ts:41-46`.
 *
 * RED test (fails before Task 2's fix):
 *   - mock `insertAuditEntry` to throw
 *   - call `engine.authorize` (any decision triggers an audit row)
 *   - assert `logger.error` was called with the exact message + payload shape
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  mockDbConnection,
  mockRealSettings,
  setupTestDb,
  closeTestDb,
  getTestDb,
} from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();
mockRealSettings();

// ── Force the audit-log insert to throw ─────────────────────────────
//
// `permission-engine.ts → writeAuditRow → insertAuditEntry`. We mock the
// audit-log query module so insertAuditEntry throws on every call; the
// catch in writeAuditRow MUST surface the failure via logger.error.
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {
    throw new Error("audit-table not found (simulated)");
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// `loadConversationOverride` shouldn't get in the way — return null.
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionEffectiveGrants: async () => null,
  addConversationExtensions: async () => {},
  getConversationExtensionIds: async () => [],
  getEffectiveGrantsForConversation: async () => ({ grantedAt: {} }),
  copyConversationExtensions: async () => {},
  getConversationExtensionMimes: async () => [],
}));

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

import {
  createPermissionEngine,
  _resetOverrideCacheForTests,
  _resetPermissionEngineForTests,
  type PermissionEngine,
} from "../extensions/permission-engine";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionPermissions } from "../extensions/types";
import { logger } from "../logger";

// ── Test helpers ────────────────────────────────────────────────────

function makeFakeRegistry(granted: ExtensionPermissions | null): ExtensionRegistry {
  return {
    getGrantedPermissions: (_id: string) => granted,
  } as unknown as ExtensionRegistry;
}

function makeFakeBus() {
  return {
    emit: () => {},
    on: () => () => {},
  } as unknown as Parameters<typeof createPermissionEngine>[0]["bus"];
}

function makeEngine(registryGranted: ExtensionPermissions | null = null): PermissionEngine {
  _resetPermissionEngineForTests();
  return createPermissionEngine({
    registry: makeFakeRegistry(registryGranted),
    bus: makeFakeBus(),
    db: { _token: "test" },
  });
}

const USER = "user-audit-obs";
const CONV = "conv-audit-obs";
const EXT = "ext-audit-obs";

beforeEach(async () => {
  await setupTestDb();
  // Seed the user — though the audit insert mock throws, the engine still
  // does a `users` reference for the FK. We seed for parity with sibling
  // tests (the throw is upstream of any FK).
  const { users } = await import("../db/schema");
  await getTestDb()
    .insert(users)
    .values({
      id: USER,
      email: "audit-obs@example.com",
      passwordHash: "x",
      name: "Audit Observability Tester",
      role: "member",
    })
    .onConflictDoNothing();
  _resetOverrideCacheForTests();
});

// ── Test ────────────────────────────────────────────────────────────

describe("Phase 54 SEC-02 — writeAuditRow audit-write failure invokes logger.error", () => {
  test("logger.error is called with structured payload when insertAuditEntry throws", async () => {
    const errorSpy = spyOn(logger, "error");
    try {
      // Allow path: registry GRANTS storage. The decision is allow → an
      // audit row gets written → insertAuditEntry throws → the catch
      // SHOULD invoke logger.error.
      const engine = makeEngine({
        grantedAt: {},
        storage: true,
      });
      await engine.authorize(
        { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "writer" },
        [{ kind: "storage" }],
      );

      // Assert: logger.error called at least once with the exact message.
      const matchingCalls = errorSpy.mock.calls.filter(
        (call) => call[0] === "PermissionEngine: audit-write failure",
      );
      expect(matchingCalls.length).toBeGreaterThanOrEqual(1);

      // Assert payload shape: { action, extensionId, capabilityKind, error }
      const payload = matchingCalls[0]![1] as Record<string, unknown> | undefined;
      expect(payload).toBeDefined();
      expect(payload).toHaveProperty("action");
      expect(payload).toHaveProperty("extensionId", EXT);
      expect(payload).toHaveProperty("capabilityKind");
      expect(payload).toHaveProperty("error");
      // The error field carries the underlying message for forensics.
      expect(String(payload!.error)).toContain("audit-table not found");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("PDP decision is preserved even when audit-write fails (allow path)", async () => {
    const errorSpy = spyOn(logger, "error");
    try {
      const engine = makeEngine({ grantedAt: {}, storage: true });
      const decision = await engine.authorize(
        { extensionId: EXT, userId: USER, conversationId: CONV },
        [{ kind: "storage" }],
      );
      // Decision still returns; audit failure is observability only.
      expect(decision.decision).toBe("allow");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
