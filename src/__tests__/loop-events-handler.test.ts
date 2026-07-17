// Unit tests for src/extensions/loop-events-handler.ts (Loops EZ Mode Phase 2).
//
// The handler emits the three CONTENT-FREE approval nudges onto the host bus
// over `ezcorp/emit-loop-event`. Unlike emit-task-event it needs NO
// conversation (loops fire ownerless / global-scope) — but it now carries the
// emit-task-event SECURITY posture: a capability kill-switch, the `loopEvents`
// permission gate (PDP `ezcorp:loops:emit` + boolean fallback), host-side
// loopId PROVENANCE stamping (`<extensionId>:<loopId>`), a rate limit, and an
// audit MIRROR for both emissions and rejections. Those last two touch the
// audit path, so this is a real-PGlite test (mock only db/connection), mirroring
// emit-task-event-handler.test.ts.
//
// Covers: kill-switch, permission-missing (+audit), PDP allow/deny, the
// provenance stamp (own loops only — a foreign/colon loopId is re-namespaced),
// v-guard, payload-shape guards, all three happy paths (with + without
// conversationId), the emission audit mirror, the bus-undefined no-op, the
// unknown-type tail, and the rate limiter.

import { test, expect, describe, beforeAll, afterAll, afterEach } from "bun:test";
import { mock } from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { handleEmitLoopEventRpc } = await import("../extensions/loop-events-handler");
const { getDb } = await import("../db/connection");
const { users, auditLog } = await import("../db/schema");
const { eq, desc, and } = await import("drizzle-orm");

import type { LoopEventsContext } from "../extensions/loop-events-handler";
import type { JsonRpcRequest, ExtensionPermissions } from "../extensions/types";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";

interface EmitCall { event: string; payload: unknown; }

function makeBus(): { bus: EventBus<AgentEvents>; calls: EmitCall[] } {
  const calls: EmitCall[] = [];
  const bus = {
    emit: (event: string, payload: unknown) => { calls.push({ event, payload }); },
    on: () => () => {},
    off: () => {},
  } as unknown as EventBus<AgentEvents>;
  return { bus, calls };
}

function rpc(params: Record<string, unknown>, id: number | string = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "ezcorp/emit-loop-event", params };
}

function perms(loopEvents = true): ExtensionPermissions {
  return { ...(loopEvents ? { loopEvents: true as const } : {}), grantedAt: {} };
}

function ctx(
  bus: EventBus<AgentEvents> | undefined,
  overrides: Partial<LoopEventsContext> = {},
): LoopEventsContext {
  return {
    bus,
    userId: overrides.userId ?? "user-loops",
    grantedPermissions: overrides.grantedPermissions ?? perms(true),
    ...(overrides.engine ? { engine: overrides.engine } : {}),
    ...(overrides.conversationId !== undefined ? { conversationId: overrides.conversationId } : {}),
  };
}

// Each test uses a fresh extensionId so the per-id rate-limit bucket starts full.
function ext(): string {
  return `loop-ev-${crypto.randomUUID().slice(0, 8)}`;
}

async function lastAudit(
  extensionId: string,
  action: "ext:loop-event-emitted" | "ext:loop-event-rejected",
): Promise<{ action: string; metadata: any } | undefined> {
  const rows = await getDb()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.target, extensionId), eq(auditLog.action, action)))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return rows[0] as any;
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values({
    id: "user-loops",
    email: "user-loops@t.local",
    passwordHash: "x",
    name: "user-loops",
  } as any).onConflictDoNothing();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

afterEach(() => {
  delete process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"];
});

// ── Permission ladder ────────────────────────────────────────────────

describe("emit-loop-event — permission + kill-switch", () => {
  test("loopEvents not granted → -32001 + audit {reason:'permission-missing'}", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }, "p1"),
      ctx(bus, { grantedPermissions: perms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toMatch(/loopEvents permission not granted/);
    expect(calls).toHaveLength(0);
    const audit = await lastAudit(id, "ext:loop-event-rejected");
    expect(audit?.metadata?.reason).toBe("permission-missing");
  });

  test("EZCORP_DISABLE_CAPABILITY_TOOLS=1 → -32001 even with the grant", async () => {
    process.env["EZCORP_DISABLE_CAPABILITY_TOOLS"] = "1";
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }, "k1"),
      ctx(bus),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
    const audit = await lastAudit(id, "ext:loop-event-rejected");
    expect(audit?.metadata?.reason).toBe("permission-missing");
  });

  test("ownerless fire (userId 'unknown') is still gated + audited with a null user", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }, "own1"),
      ctx(bus, { userId: "unknown", grantedPermissions: perms(false) }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
    const audit = await lastAudit(id, "ext:loop-event-rejected");
    expect(audit?.metadata?.reason).toBe("permission-missing");
  });
});

describe("emit-loop-event — PDP path (Phase 6)", () => {
  test("ctx.engine returns deny → -32001 (needed=ezcorp:loops:emit)", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("deny-all");
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      // grant says loopEvents:true, but the PDP overrides.
      ctx(bus, { grantedPermissions: perms(true), engine }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(calls).toHaveLength(0);
    expect(engine.calls.length).toBe(1);
    expect(engine.calls[0]!.needed).toEqual([{ kind: "ezcorp:loops:emit" }]);
  });

  test("ctx.engine returns allow + empty grant → handler proceeds", async () => {
    const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");
    const engine = createStubPermissionEngine("allow-all");
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(bus, { grantedPermissions: perms(false), engine }),
    );
    expect(resp.error).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(engine.calls.length).toBe(1);
  });
});

// ── loopId provenance — an extension can only emit for its own loops ──

describe("emit-loop-event — loopId provenance stamp", () => {
  test("the wire loopId is stamped with the emitting extension's id", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: `${id}:docs`, runId: "r1" });
  });

  test("a FOREIGN/colon-bearing loopId cannot spoof another extension — it is re-namespaced under the caller", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "victim-ext:secret", runId: "r1" } }),
      ctx(bus),
    );
    // Stamped under the CALLER's id — the wire id is `<caller>:victim-ext:secret`,
    // never `victim-ext:secret`.
    expect((calls[0]!.payload as { loopId: string }).loopId).toBe(`${id}:victim-ext:secret`);
  });

  test("the emission audit row carries the STAMPED loopId (tamper-evident mirror)", async () => {
    const id = ext();
    const { bus } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_resolved", payload: { loopId: "docs", runId: "r1", decision: "approved" } }),
      ctx(bus),
    );
    const audit = await lastAudit(id, "ext:loop-event-emitted");
    expect(audit?.metadata?.loopId).toBe(`${id}:docs`);
    expect(audit?.metadata?.newValue).toBe("approval_resolved");
    expect(audit?.metadata?.decision).toBe("approved");
  });
});

// ── Validation ───────────────────────────────────────────────────────

describe("emit-loop-event — validation", () => {
  test("v !== 1 → -32602 + audit", async () => {
    const id = ext();
    const resp = await handleEmitLoopEventRpc(id, rpc({ v: 2, type: "approval_pending", payload: {} }), ctx(makeBus().bus));
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/'v'/);
    const audit = await lastAudit(id, "ext:loop-event-rejected");
    expect(audit?.metadata?.reason).toBe("schema-mismatch");
  });

  test("non-object payload → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: "nope" }), ctx(makeBus().bus));
    expect(resp.error?.message).toMatch(/payload/);
  });

  test("missing/empty loopId → -32602", async () => {
    const { bus, calls } = makeBus();
    const r1 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { runId: "r" } }), ctx(bus));
    expect(r1.error?.message).toMatch(/loopId/);
    const r2 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { loopId: "", runId: "r" } }), ctx(bus));
    expect(r2.error?.message).toMatch(/loopId/);
    expect(calls).toHaveLength(0);
  });

  test("missing/empty runId → -32602", async () => {
    const r1 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { loopId: "l" } }), ctx(makeBus().bus));
    expect(r1.error?.message).toMatch(/runId/);
    const r2 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { loopId: "l", runId: "" } }), ctx(makeBus().bus));
    expect(r2.error?.message).toMatch(/runId/);
  });

  test("non-string conversationId → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "l", runId: "r", conversationId: 5 } }),
      ctx(makeBus().bus),
    );
    expect(resp.error?.message).toMatch(/conversationId/);
  });

  test("unknown type → -32602 + audit", async () => {
    const id = ext();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "whoops", payload: { loopId: "l", runId: "r" } }),
      ctx(makeBus().bus),
    );
    expect(resp.error?.message).toMatch(/Unknown event type/);
    const audit = await lastAudit(id, "ext:loop-event-rejected");
    expect(audit?.metadata?.reason).toBe("schema-mismatch");
  });

  test("approval_resolved with a bad decision → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_resolved", payload: { loopId: "l", runId: "r", decision: "maybe" } }),
      ctx(makeBus().bus),
    );
    expect(resp.error?.message).toMatch(/decision/);
  });

  test("auto_disabled with a non-number consecutiveErrors → -32602", async () => {
    const r1 = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "auto_disabled", payload: { loopId: "l", consecutiveErrors: "five" } }),
      ctx(makeBus().bus),
    );
    expect(r1.error?.message).toMatch(/consecutiveErrors/);
    const r2 = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "auto_disabled", payload: { loopId: "l", consecutiveErrors: Infinity } }),
      ctx(makeBus().bus),
    );
    expect(r2.error?.message).toMatch(/consecutiveErrors/);
  });

  test("auto_disabled does NOT require a runId", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "auto_disabled", payload: { loopId: "flaky", consecutiveErrors: 5 } }),
      ctx(bus),
    );
    expect(resp.result).toEqual({ ok: true });
    expect(calls[0]).toEqual({ event: "loops:auto_disabled", payload: { loopId: `${id}:flaky`, consecutiveErrors: 5 } });
  });
});

// ── Happy paths ──────────────────────────────────────────────────────

describe("emit-loop-event — happy paths", () => {
  test("approval_pending (global, no conversationId) broadcasts content-free", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(bus),
    );
    expect(resp.result).toEqual({ ok: true });
    expect(calls).toEqual([{ event: "loops:approval_pending", payload: { loopId: `${id}:docs`, runId: "r1" } }]);
    const audit = await lastAudit(id, "ext:loop-event-emitted");
    expect(audit?.metadata?.newValue).toBe("approval_pending");
  });

  test("approval_pending threads a non-empty conversationId", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1", conversationId: "c9" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: `${id}:docs`, runId: "r1", conversationId: "c9" });
  });

  test("an EMPTY conversationId is dropped (global broadcast)", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1", conversationId: "" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: `${id}:docs`, runId: "r1" });
  });

  test("approval_resolved carries the decision", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_resolved", payload: { loopId: "docs", runId: "r1", decision: "declined", conversationId: "c1" } }),
      ctx(bus),
    );
    expect(resp.result).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      event: "loops:approval_resolved",
      payload: { loopId: `${id}:docs`, runId: "r1", decision: "declined", conversationId: "c1" },
    });
  });

  test("auto_disabled threads a conversationId", async () => {
    const id = ext();
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "auto_disabled", payload: { loopId: "flaky", consecutiveErrors: 2, conversationId: "c1" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: `${id}:flaky`, consecutiveErrors: 2, conversationId: "c1" });
  });

  test("a missing bus is a clean no-op emit (still ok, still audited)", async () => {
    const id = ext();
    const resp = await handleEmitLoopEventRpc(
      id,
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(undefined),
    );
    expect(resp.result).toEqual({ ok: true });
    const audit = await lastAudit(id, "ext:loop-event-emitted");
    expect(audit?.metadata?.newValue).toBe("approval_pending");
  });
});

// ── Rate limit ───────────────────────────────────────────────────────

describe("emit-loop-event — rate limit", () => {
  test("60 tight-loop emits for one extension → many accepted, remainder -32029", async () => {
    const id = ext();
    const { bus } = makeBus();
    let accepted = 0;
    let limited = 0;
    for (let i = 0; i < 60; i++) {
      const resp = await handleEmitLoopEventRpc(
        id,
        rpc({ v: 1, type: "approval_pending", payload: { loopId: "l", runId: `r${i}` } }, `rl-${i}`),
        ctx(bus),
      );
      if (resp.error?.code === -32029) limited++;
      else if (!resp.error) accepted++;
    }
    expect(accepted).toBeGreaterThanOrEqual(45);
    expect(limited).toBeGreaterThan(0);
  });
});
