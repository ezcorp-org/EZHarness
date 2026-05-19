/**
 * Phase 54 SEC-03 — per-conversation cross-ext call-depth cap.
 *
 * Pre-fix: `handlePiInvoke` enforced MAX_CALL_DEPTH=10 per CHAIN
 * (caller-supplied `_depth` param). 50 parallel chains could each
 * fan out 10 levels deep without hitting any global cap — a runaway
 * extension graph could spawn unbounded work in a single conversation.
 *
 * Post-fix: a module-scope `Map<convId, count>` tracks the in-flight
 * cross-ext invokes per conversation. The 51st call in the same
 * conversation is rejected with "Per-conversation call-depth cap
 * exceeded (max 50)" and an audit row is written. The counter
 * decrements via `finally` so the slot is reusable after a call
 * completes.
 *
 * RED tests (fail before Task 2 ships):
 *   1. 50 parked calls succeed; 51st rejected (same conv).
 *   2. 51st call in a DIFFERENT conv succeeds (per-conv isolation).
 *   3. After 50 calls complete, slot is reusable (counter decrements).
 *   4. Audit row written for the cap-exceeded reject.
 */

import { afterAll, beforeEach, afterEach, describe, expect, mock, test } from "bun:test";
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

// Avoid pulling the real conversation-extensions DB code path.
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

import { ExtensionRegistry } from "../extensions/registry";
import {
  ToolExecutor,
  _resetConversationCallDepthForTests,
  _resetToolCallsCounterForTests,
  _peekConversationCallDepthMapSizeForTests,
} from "../extensions/tool-executor";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../extensions/types";
import type { Decision, PermissionEngine } from "../extensions/permission-engine";
import type { AlwaysAllowScope } from "../extensions/permissions";
import { auditLog } from "../db/schema";
import { eq } from "drizzle-orm";

// ── Allow-everything stub engine ────────────────────────────────────

function makeAllowEngine(): PermissionEngine {
  return {
    async authorize(): Promise<Decision> {
      return { decision: "allow", auditId: "stub-allow" };
    },
    async resolvePrompt(
      _id: string,
      _ok: boolean,
      _scope: AlwaysAllowScope,
      _scopeId: string,
    ): Promise<void> {},
    _resetCacheForTests(): void {},
  };
}

// ── Manifest + registry helpers ─────────────────────────────────────

function makeManifest(name: string): ExtensionManifestV2 {
  return {
    schemaVersion: 3,
    name,
    version: "1.0.0",
    description: "test",
    author: { name: "tester" },
    permissions: {},
    entrypoint: "./index.ts",
    tools: [
      {
        name: "doStuff",
        description: "does stuff",
        inputSchema: { type: "object" },
      },
    ],
  };
}

function setupRegistry(registry: ExtensionRegistry): void {
  const grants: ExtensionPermissions = { grantedAt: {} };
  registry.setManifestForTest("caller-id", makeManifest("caller"));
  registry.setManifestForTest("callee-id", makeManifest("callee"));
  registry.setGrantedPermsForTest("caller-id", grants);
  registry.setGrantedPermsForTest("callee-id", grants);
  registry.setDepRoutes(new Map([["caller-id", new Map([["callee", "callee-id"]])]]));
  registry.registerToolForTest("callee__doStuff", {
    name: "callee__doStuff",
    originalName: "doStuff",
    description: "does stuff",
    inputSchema: { type: "object" },
    extensionId: "callee-id",
    extensionName: "callee",
  });
}

function makeInvoke(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "ezcorp/invoke",
    params: { tool: "callee__doStuff", arguments: {} },
  };
}

// ── Test setup ──────────────────────────────────────────────────────

let registry: ExtensionRegistry;
let executor: ToolExecutor;

beforeEach(async () => {
  await setupTestDb();
  ExtensionRegistry.resetInstance();
  registry = ExtensionRegistry.getInstance();
  setupRegistry(registry);
  executor = new ToolExecutor(registry, makeAllowEngine());
  _resetConversationCallDepthForTests();
  _resetToolCallsCounterForTests();
});

afterEach(() => {
  ExtensionRegistry.resetInstance();
  _resetConversationCallDepthForTests();
  _resetToolCallsCounterForTests();
});

// ── Test 1 — 50 parked calls + 51st rejected (same conv) ────────────

describe("Phase 54 SEC-03 — per-conversation call-depth cap", () => {
  test("50 in-flight handlePiInvoke calls succeed; 51st rejected with cap-exceeded", async () => {
    // Park executeToolCall on a deferred Promise so calls remain in-flight.
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });
    let inFlight = 0;
    executor.executeToolCall = async () => {
      inFlight += 1;
      await allDone;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    // Pin the executor to a single conversation.
    executor.setCurrentConversationId("conv-cap");

    // Fire 50 calls that park inside executeToolCall (counter increments
    // BEFORE the body, so all 50 contribute to the in-flight count).
    const parked = [];
    for (let i = 0; i < 50; i++) {
      parked.push(executor.handlePiInvoke("caller-id", makeInvoke(i + 1)));
    }
    // Yield so the 50 async fns reach the parked await.
    await Promise.resolve();
    await Promise.resolve();

    expect(inFlight).toBe(50);

    // 51st call should be rejected WITHOUT awaiting the parked promises.
    const rejected = await executor.handlePiInvoke("caller-id", makeInvoke(51));
    expect(rejected.error).toBeDefined();
    expect(rejected.error!.code).toBe(-32000);
    expect(rejected.error!.message).toMatch(
      /Per-conversation call-depth cap exceeded \(max 50\)/,
    );

    // Drain the parked promises.
    resolveAll!();
    await Promise.all(parked);
  });

  test("Different conversation has its own slot — 51st in OTHER conv succeeds", async () => {
    // Park 50 calls in conv-a.
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });
    executor.executeToolCall = async () => {
      await allDone;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };
    executor.setCurrentConversationId("conv-a");
    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      parked.push(executor.handlePiInvoke("caller-id", makeInvoke(i + 1)));
    }
    await Promise.resolve();
    await Promise.resolve();

    // Switch to a fresh conversation; the 51st invoke counts against
    // conv-b, NOT conv-a, so it succeeds (executeToolCall is also
    // parked → response will be the parked promise; we don't await).
    executor.setCurrentConversationId("conv-b");
    let convBStarted = false;
    const newExecuteImpl = async () => {
      convBStarted = true;
      await allDone;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };
    executor.executeToolCall = newExecuteImpl;
    const convBCall = executor.handlePiInvoke("caller-id", makeInvoke(101));
    await Promise.resolve();
    await Promise.resolve();
    expect(convBStarted).toBe(true);

    resolveAll!();
    await Promise.all([...parked, convBCall]);
  });

  test("Counter decrements on finally — after 50 settled calls, the slot is reusable", async () => {
    // Resolve immediately so each invocation completes and decrements.
    executor.executeToolCall = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    });
    executor.setCurrentConversationId("conv-drain");

    // Run 50 calls that complete promptly.
    for (let i = 0; i < 50; i++) {
      const resp = await executor.handlePiInvoke("caller-id", makeInvoke(i + 1));
      expect(resp.error).toBeUndefined();
    }

    // Counter back to 0 — 51st call succeeds.
    const fifty1 = await executor.handlePiInvoke("caller-id", makeInvoke(51));
    expect(fifty1.error).toBeUndefined();
  });

  // ── Phase 54 gap-closure (2026-05-11) — finally decrements on throw ──
  //
  // Phase 54 SEC-03 wires a `try { … } finally { decrement }` block at
  // tool-executor.ts:931..1137. The four pre-existing tests above only
  // exercise the SUCCESS path (executeToolCall resolves). Independent
  // verification flagged the throw path as uncovered: if
  // `executeToolCall` throws, the `catch` at L1120-1129 converts the
  // throw into a JSON-RPC error response, but the `finally` at L1130
  // MUST still decrement the per-conversation counter so the slot is
  // reusable. Without that decrement a single thrown call would
  // permanently waste a slot — under 50 throws, the entire conversation
  // would lock out future cross-ext invokes.
  //
  // Mechanism: mock `executor.executeToolCall` to reject; assert (a)
  // the returned JSON-RPC has the wrapped error, AND (b) the slot is
  // reusable for 50 more in-flight calls in the same conversation.
  test("finally decrements conversationCallDepth when executeToolCall throws", async () => {
    let throwCalls = 0;
    executor.executeToolCall = async () => {
      throwCalls += 1;
      throw new Error("simulated callee crash");
    };
    executor.setCurrentConversationId("conv-throw");

    // Drive one cross-ext invoke that throws. handlePiInvoke wraps
    // the inner executeToolCall in try/catch so the throw becomes a
    // JSON-RPC error response, not a propagated reject.
    const resp = await executor.handlePiInvoke("caller-id", makeInvoke(1));
    expect(throwCalls).toBe(1);
    expect(resp.error).toBeDefined();
    expect(resp.error!.code).toBe(-32000);
    expect(resp.error!.message).toMatch(/simulated callee crash/);

    // If the finally decrement DID NOT run, the slot count for
    // 'conv-throw' is stuck at 1; running 50 more parked calls would
    // see currentConvDepth start at 1, hit MAX (50) on the 50th, and
    // reject the 50th with "Per-conversation call-depth cap exceeded".
    // If finally DID run, the count is back to 0 and all 50 succeed.
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });
    executor.executeToolCall = async () => {
      await allDone;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };
    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      parked.push(executor.handlePiInvoke("caller-id", makeInvoke(i + 100)));
    }
    await Promise.resolve();
    await Promise.resolve();

    // Drain the 50 parked calls and assert all 50 succeeded. If the
    // finally on the THROW path had leaked its slot, the per-conv
    // counter would have started this batch at 1 instead of 0, and
    // the 50th parked call would have observed currentConvDepth == 50
    // before its own pre-increment — tripping the MAX_CALL_DEPTH cap
    // and surfacing as a JSON-RPC error on `r.error`. All 50 clean ⇒
    // the throw-path `finally` decremented the counter back to 0
    // before this batch started.
    resolveAll!();
    const results = await Promise.all(parked);
    for (const r of results) {
      expect(r.error).toBeUndefined();
    }

    // Final liveness check: with all 50 settled, the counter must be
    // back to 0 (the finally on each path decrements). A fresh call
    // succeeds.
    executor.executeToolCall = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    });
    const fresh = await executor.handlePiInvoke("caller-id", makeInvoke(999));
    expect(fresh.error).toBeUndefined();
  });

  // Beyond-floor coverage: lazy-delete on count == 0. The finally
  // block at tool-executor.ts:1135 calls `Map.delete` when the
  // decremented count reaches 0 (memory hygiene — the Map must not
  // grow unboundedly with one entry per ever-touched conversation).
  // The previous test exercises the decrement path; this one locks
  // the delete path by switching conversations after each settled
  // call and asserting the slot is fresh each time. Without the
  // lazy-delete the Map would accumulate stale 0-count entries.
  // Phase 54 gap-closure (2026-05-11): the prior version of this test
  // could only observe "no growth" indirectly (100 settled calls all
  // succeed). Now we use the test-only peek helper
  // `_peekConversationCallDepthMapSizeForTests` to lock the actual
  // `Map.delete` call at tool-executor.ts:1135 rather than the absence
  // of growth — a "decrement-but-don't-delete" refactor would set
  // size = 100 after the loop and fail the post-loop assertion below.
  test("finally lazy-deletes the conversation slot when count hits 0", async () => {
    executor.executeToolCall = async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      isError: false,
    });

    // Sanity check — beforeEach calls _resetConversationCallDepthForTests
    // so the map starts empty.
    expect(_peekConversationCallDepthMapSizeForTests()).toBe(0);

    for (let i = 0; i < 100; i++) {
      executor.setCurrentConversationId(`conv-cycle-${i}`);
      const r = await executor.handlePiInvoke("caller-id", makeInvoke(i + 1));
      expect(r.error).toBeUndefined();
    }

    // Lock the lazy-delete: every conversation slot was incremented
    // (during the call) then decremented to 0 (in the `finally`); on
    // hitting 0 the entry MUST be deleted. If the delete were dropped,
    // the map would still hold 100 stale 0-count entries here.
    expect(_peekConversationCallDepthMapSizeForTests()).toBe(0);
  });

  test("Cap-exceeded reject writes an AUDIT_PERM_DENIED audit row", async () => {
    // Park 50 calls, then trigger reject and assert the audit row.
    let resolveAll: (() => void) | null = null;
    const allDone = new Promise<void>((res) => {
      resolveAll = res;
    });
    executor.executeToolCall = async () => {
      await allDone;
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };
    executor.setCurrentConversationId("conv-audit");

    const parked: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) {
      parked.push(executor.handlePiInvoke("caller-id", makeInvoke(i + 1)));
    }
    await Promise.resolve();
    await Promise.resolve();

    await executor.handlePiInvoke("caller-id", makeInvoke(51));

    // Audit row written via insertAuditEntry → audit_log table.
    const rows = await getTestDb()
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "ext:perm:denied"));
    const capRows = rows.filter((r) => {
      const meta = r.metadata as Record<string, unknown> | null;
      return (
        typeof meta?.reason === "string" &&
        meta.reason.includes("Per-conversation call-depth cap exceeded")
      );
    });
    expect(capRows.length).toBeGreaterThanOrEqual(1);
    expect(capRows[0]!.target).toBe("caller-id");

    resolveAll!();
    await Promise.all(parked);
  });
});
