/**
 * Phase 54 SEC-01 (Plan 02 swap) — post-cache override-lookup failure
 * is now strictly fail-CLOSED.
 *
 * Plan 01 added an in-memory cache primed by `addConversationExtensions`
 * that absorbs PGlite warm-up lag. Plan 02 swaps the post-cache catch
 * from null-fallback to throw + caller upgrades the decision to
 * `{decision: "deny", reason: "override-lookup-failed"}` with an audit
 * row tagged `AUDIT_PERM_DENIED`.
 *
 * RED test (fails before Task 2 implementation):
 *   - cache miss + DB throw → engine.authorize returns
 *     {decision: "deny", reason: "override-lookup-failed"}.
 *   - audit_log has a row with action=AUDIT_PERM_DENIED and
 *     metadata.reason="override-lookup-failed".
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
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

// ── DB-layer mock ───────────────────────────────────────────────────
//
// `getConversationExtensionEffectiveGrants` is the function the PDP calls
// when the override cache misses. We make it throw to simulate the
// post-cache DB failure path.

let getEffectiveGrantsImpl: (
  conversationId: string,
  extensionId: string,
) => Promise<unknown> = async () => {
  throw new Error("PGlite ECONNRESET (simulated)");
};

mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionEffectiveGrants: (
    conversationId: string,
    extensionId: string,
  ) => getEffectiveGrantsImpl(conversationId, extensionId),
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
import { auditLog } from "../db/schema";
import { eq } from "drizzle-orm";

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

const USER = "user-fail-closed";
const CONV = "conv-fail-closed";
const EXT = "ext-fail-closed";

beforeEach(async () => {
  await setupTestDb();
  // Seed the user so the audit-log FK accepts the deny insert.
  const { users } = await import("../db/schema");
  await getTestDb()
    .insert(users)
    .values({
      id: USER,
      email: "fail-closed@example.com",
      passwordHash: "x",
      name: "Fail Closed Tester",
      role: "member",
    })
    .onConflictDoNothing();
  _resetOverrideCacheForTests();
  // Default: DB layer throws on every call. Tests can re-point as needed.
  getEffectiveGrantsImpl = async () => {
    throw new Error("PGlite ECONNRESET (simulated)");
  };
});

// ── Test — post-cache DB throw → fail-CLOSED deny ──────────────────

describe("Phase 54 SEC-01 swap — post-cache DB throw → fail-CLOSED deny", () => {
  test("loadConversationOverride DB throw → engine.authorize returns deny with reason 'override-lookup-failed'", async () => {
    // Cache is empty (beforeEach reset). DB throws on the lookup.
    // Even though the registry GRANTS the cap (which would have been the
    // Plan 01 fallback), Plan 02's swap upgrades the decision to a deny.
    const registryGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    const engine = makeEngine(registryGrants);

    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toBe("override-lookup-failed");
    expect(decision.auditId).toBeTruthy();
  });

  test("audit_log carries a row with action=AUDIT_PERM_DENIED and metadata.reason='override-lookup-failed'", async () => {
    const engine = makeEngine(null);

    await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:denied"));
    // At least one row matches our deny — the override-lookup-failed reason.
    const denyRows = rows.filter((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return meta?.reason === "override-lookup-failed";
    });
    expect(denyRows.length).toBeGreaterThanOrEqual(1);
    expect(denyRows[0]!.target).toBe(EXT);
  });

  test("error message bubbles up via metadata.underlyingError for forensics", async () => {
    getEffectiveGrantsImpl = async () => {
      throw new Error("custom-db-failure-marker");
    };
    const engine = makeEngine(null);

    await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:denied"));
    const denyRow = rows.find((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return meta?.reason === "override-lookup-failed";
    });
    expect(denyRow).toBeDefined();
    const meta = denyRow!.metadata as Record<string, unknown>;
    expect(meta.underlyingError).toContain("custom-db-failure-marker");
  });
});
