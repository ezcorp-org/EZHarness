/**
 * Phase 54 SEC-01 (Plan 01) — conversation-override cache integration.
 *
 * The PDP's `loadConversationOverride` reads a per-(conversation, extension)
 * override from `conversation_extensions`. Under PGlite warm-up lag at boot
 * the very first read can throw — the bundled lessons-distiller and
 * memory-extractor extensions then take their first event before the DB
 * is ready and silently lose the auto-trigger flow.
 *
 * Plan 01 lands a TTL-bounded in-memory cache primed by
 * `addConversationExtensions` whenever an `effectiveGrantedPermissions`
 * field is supplied (the spawn-assignment path). The PDP reads the cache
 * BEFORE the DB query so the warm-up window is absorbed.
 *
 * Plan 02 boundary (post-SEC-01 swap): the post-cache catch in
 * `loadConversationOverride` now THROWS on DB failure. The caller in
 * `authorize` catches the throw and upgrades the decision to
 * `{decision: "deny", reason: "override-lookup-failed"}`. Test 3 was
 * re-anchored from the Plan 01 fail-OPEN canary to assert the new
 * post-swap fail-CLOSED behavior. The cache-miss-then-DB-call code
 * path is still exercised — the assertion is just on the new deny
 * shape instead of the old null-fallback shape.
 *
 * Tests:
 *   1. Prime → hit → DB function NEVER called.
 *   2. Prime → advance time past TTL → DB function called again, fresh value used.
 *   3. Cache miss + DB throw → engine returns deny with reason
 *      'override-lookup-failed' (post-Plan-2 semantic).
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

// ── DB-layer mock — controllable per test ──────────────────────────
//
// `getConversationExtensionEffectiveGrants` is the function the PDP calls
// when the override cache misses. Each test re-points the impl to suit:
//   - Test 1: throw, prove the cache absorbed the lookup.
//   - Test 2: return `freshGrants`, prove TTL expiry triggers a re-read.
//   - Test 3: throw, prove fallback to registry (Plan 1 boundary).
//
// `addConversationExtensions` is also exported from this module — we leave
// it as a no-op since the tests call `primeConversationOverrideCache`
// directly instead of going through the DB-write path.

let getEffectiveGrantsImpl: (
  conversationId: string,
  extensionId: string,
) => Promise<unknown> = async () => null;

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
  primeConversationOverrideCache,
  _resetOverrideCacheForTests,
  _resetPermissionEngineForTests,
  type PermissionEngine,
} from "../extensions/permission-engine";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionPermissions } from "../extensions/types";

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

const USER = "user-cache";
const CONV = "conv-cache";
const EXT = "ext-cache";

beforeEach(async () => {
  await setupTestDb();
  // Seed the user so audit-log FK accepts the insert. The cache itself
  // doesn't touch users, but `engine.authorize` writes an audit row and
  // the FK is enforced.
  const { users } = await import("../db/schema");
  await getTestDb()
    .insert(users)
    .values({
      id: USER,
      email: "cache@example.com",
      passwordHash: "x",
      name: "Cache Tester",
      role: "member",
    })
    .onConflictDoNothing();
  _resetOverrideCacheForTests();
  // Default: DB layer returns null (no override). Tests override per-case.
  getEffectiveGrantsImpl = async () => null;
});

// ── Test 1 — prime + hit, DB layer untouched ────────────────────────

describe("conversation-override cache — prime then hit", () => {
  test("primeConversationOverrideCache populates the cache; loadConversationOverride hits without DB", async () => {
    // Make the DB layer throw — the cache must absorb the lookup so this
    // throw is never reached.
    let dbCalls = 0;
    getEffectiveGrantsImpl = async () => {
      dbCalls += 1;
      throw new Error("PGlite warm-up boom — cache MUST absorb this");
    };

    // Prime the cache with a grant set that allows ezcorp:chat:append.
    const fakeGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    primeConversationOverrideCache(CONV, EXT, fakeGrants);

    // Registry returns null (no install-time grants) — the only way to
    // allow ezcorp:chat:append is via the override.
    const engine = makeEngine(null);
    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    expect(decision.decision).toBe("allow");
    expect(dbCalls).toBe(0);
  });
});

// ── Test 2 — TTL expiry forces re-read ──────────────────────────────

describe("conversation-override cache — TTL expiry", () => {
  test("entry expires after OVERRIDE_CACHE_TTL_MS and re-reads from DB", async () => {
    // Real-time baseline; we'll spy `Date.now` to advance past the TTL.
    const baseline = Date.now();
    const dateSpy = spyOn(Date, "now").mockImplementation(() => baseline);

    // Prime with `staleGrants` — no appendMessages.
    const staleGrants: ExtensionPermissions = { grantedAt: {} };
    primeConversationOverrideCache(CONV, EXT, staleGrants);

    // Configure DB to return `freshGrants` (with appendMessages) — only
    // observable when the cache MISSES and falls through to the DB.
    const freshGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: baseline },
      appendMessages: { excludedDefault: false },
    };
    let dbCalls = 0;
    getEffectiveGrantsImpl = async () => {
      dbCalls += 1;
      return freshGrants;
    };

    const engine = makeEngine(null);

    // First call within TTL — uses staleGrants, DB untouched.
    const within = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );
    expect(within.decision).toBe("deny");
    expect(dbCalls).toBe(0);

    // Advance time past the 60s TTL.
    dateSpy.mockImplementation(() => baseline + 60_001);

    // Second call after expiry — cache miss, DB read returns freshGrants.
    const after = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );
    expect(after.decision).toBe("allow");
    expect(dbCalls).toBe(1);

    dateSpy.mockRestore();
  });
});

// ── Test 3 — Plan 02 fail-CLOSED semantic (re-anchored from Plan 01 canary) ─
//
// Pre-Plan-02 this test asserted the null-fallback semantic (cache
// miss + DB throw → fall back to registry grants → ALLOW if registry
// granted). Plan 02 SEC-01 swap inverted that semantic: the post-cache
// throw now bubbles up to `authorize`, which emits a deny decision with
// reason "override-lookup-failed". The cache-miss-then-DB-call code
// path is still exercised — the assertion is now on the new deny
// shape. The fuller deny+audit-row contract is locked in
// `permission-engine-override-fail-closed.test.ts`.

describe("conversation-override cache — Plan 02 fail-CLOSED on DB throw (re-anchored)", () => {
  test("cache miss + DB throw → engine returns deny with reason 'override-lookup-failed'", async () => {
    // No prime — cache is empty; the lookup must fall through to the DB.
    getEffectiveGrantsImpl = async () => {
      throw new Error("simulated DB failure");
    };

    // Registry GRANTS appendMessages. Pre-swap this would have caused
    // an ALLOW via registry fallback; post-swap the deny decision wins
    // because the override lookup itself failed.
    const registryGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    const engine = makeEngine(registryGrants);

    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: CONV, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    // Plan 02 contract: cache miss + DB throw → fail-CLOSED deny with
    // reason "override-lookup-failed". The registry grant is IGNORED —
    // the underlying DB is unhealthy and silent registry-grant
    // widening would be a security regression.
    expect(decision.decision).toBe("deny");
    if (decision.decision !== "deny") return;
    expect(decision.reason).toBe("override-lookup-failed");
    expect(decision.auditId).toBeTruthy();
  });
});

// ── Phase 54 gap-closure (2026-05-11) — legacy sentinel short-circuits ─
//
// `loadConversationOverride` at permission-engine.ts:458 short-circuits
// to `null` for the legacy sentinel strings `"unknown"` and
// `"cross-ext"` (and for null/empty conversationId) WITHOUT touching
// the override cache or the DB query. Independent Phase 54 verification
// flagged these branches as uncovered by the new SEC-01 tests. These
// regressions lock the behavior: a registry-grant fallback path that
// passes `conversationId: "unknown"` must NOT trigger a DB query
// (which would defeat the boot-spawn warm-up absorption that SEC-01
// added), AND it must NOT trigger the post-swap fail-CLOSED deny
// (which only fires on a real DB throw after a real cache miss).
//
// Both tests assert the DB function is NEVER called and the cache
// stays empty — same shape, different sentinel value.

describe("conversation-override cache — legacy sentinel short-circuits", () => {
  test("loadConversationOverride returns null for conversationId='unknown' without touching cache or DB", async () => {
    let dbCalls = 0;
    getEffectiveGrantsImpl = async () => {
      dbCalls += 1;
      throw new Error("DB MUST NOT be called for sentinel conversationId='unknown'");
    };

    // Registry GRANTS appendMessages — so the only way the engine
    // could end up ALLOWING is via the registry fallback path after
    // `loadConversationOverride` returns null. If the sentinel were
    // NOT short-circuited, the DB throw would surface as
    // fail-CLOSED deny with reason 'override-lookup-failed' (see the
    // re-anchored test above). The assertion therefore distinguishes
    // "short-circuit hit" (allow via registry) vs "post-cache throw"
    // (deny via override-lookup-failed).
    const registryGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    const engine = makeEngine(registryGrants);

    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: "unknown", toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    expect(decision.decision).toBe("allow");
    expect(dbCalls).toBe(0);
  });

  test("loadConversationOverride returns null for conversationId='cross-ext' without touching cache or DB", async () => {
    let dbCalls = 0;
    getEffectiveGrantsImpl = async () => {
      dbCalls += 1;
      throw new Error("DB MUST NOT be called for sentinel conversationId='cross-ext'");
    };

    const registryGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    const engine = makeEngine(registryGrants);

    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: "cross-ext", toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    expect(decision.decision).toBe("allow");
    expect(dbCalls).toBe(0);
  });

  test("loadConversationOverride returns null for conversationId=null without touching cache or DB", async () => {
    // Phase 6 canonical "no scope" signal — null short-circuits via the
    // same `if (!conversationId || ...)` guard. Beyond-floor coverage:
    // the spec called out 'unknown' and 'cross-ext' explicitly, but
    // the same predicate covers null/undefined/empty-string. Lock that
    // path too so a future refactor that splits the null branch from
    // the legacy-sentinel branch doesn't accidentally drop DB-skip
    // behavior for the canonical case.
    let dbCalls = 0;
    getEffectiveGrantsImpl = async () => {
      dbCalls += 1;
      throw new Error("DB MUST NOT be called for conversationId=null");
    };

    const registryGrants: ExtensionPermissions = {
      grantedAt: { appendMessages: Date.now() },
      appendMessages: { excludedDefault: false },
    };
    const engine = makeEngine(registryGrants);

    const decision = await engine.authorize(
      { extensionId: EXT, userId: USER, conversationId: null, toolName: "append" },
      [{ kind: "ezcorp:chat:append" }],
    );

    expect(decision.decision).toBe("allow");
    expect(dbCalls).toBe(0);
  });
});
