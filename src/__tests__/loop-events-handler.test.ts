// Unit tests for src/extensions/loop-events-handler.ts (Loops EZ Mode Phase 2).
//
// The handler emits the two CONTENT-FREE approval nudges onto the host bus
// over `ezcorp/emit-loop-event`. Unlike emit-task-event it needs NO
// conversation (loops fire ownerless / global-scope) and no DB — so this is a
// pure, DB-free unit test.
//
// Covers: v-guard, payload-shape guards (loopId / runId / conversationId /
// decision), both happy paths (with + without conversationId), the
// bus-undefined no-op, the unknown-type tail, and the rate limiter.

import { test, expect, describe } from "bun:test";

import { handleEmitLoopEventRpc, type LoopEventsContext } from "../extensions/loop-events-handler";
import type { JsonRpcRequest } from "../extensions/types";
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

function ctx(bus?: EventBus<AgentEvents>): LoopEventsContext {
  return { bus };
}

// Each test uses a fresh extensionId so the per-id rate-limit bucket starts full.
function ext(): string {
  return `loop-ev-${crypto.randomUUID().slice(0, 8)}`;
}

describe("handleEmitLoopEventRpc — validation", () => {
  test("v !== 1 → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(ext(), rpc({ v: 2, type: "approval_pending", payload: {} }), ctx());
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toMatch(/'v'/);
  });

  test("non-object payload → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: "nope" }), ctx());
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
    const r1 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { loopId: "l" } }), ctx());
    expect(r1.error?.message).toMatch(/runId/);
    const r2 = await handleEmitLoopEventRpc(ext(), rpc({ v: 1, type: "approval_pending", payload: { loopId: "l", runId: "" } }), ctx());
    expect(r2.error?.message).toMatch(/runId/);
  });

  test("non-string conversationId → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "l", runId: "r", conversationId: 5 } }),
      ctx(),
    );
    expect(resp.error?.message).toMatch(/conversationId/);
  });

  test("unknown type → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "whoops", payload: { loopId: "l", runId: "r" } }),
      ctx(),
    );
    expect(resp.error?.message).toMatch(/Unknown event type/);
  });

  test("approval_resolved with a bad decision → -32602", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_resolved", payload: { loopId: "l", runId: "r", decision: "maybe" } }),
      ctx(),
    );
    expect(resp.error?.message).toMatch(/decision/);
  });
});

describe("handleEmitLoopEventRpc — happy paths", () => {
  test("approval_pending (global, no conversationId) broadcasts content-free", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(bus),
    );
    expect(resp.result).toEqual({ ok: true });
    expect(calls).toEqual([{ event: "loops:approval_pending", payload: { loopId: "docs", runId: "r1" } }]);
  });

  test("approval_pending threads a non-empty conversationId", async () => {
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1", conversationId: "c9" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: "docs", runId: "r1", conversationId: "c9" });
  });

  test("an EMPTY conversationId is dropped (global broadcast)", async () => {
    const { bus, calls } = makeBus();
    await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1", conversationId: "" } }),
      ctx(bus),
    );
    expect(calls[0]!.payload).toEqual({ loopId: "docs", runId: "r1" });
  });

  test("approval_resolved carries the decision", async () => {
    const { bus, calls } = makeBus();
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_resolved", payload: { loopId: "docs", runId: "r1", decision: "declined", conversationId: "c1" } }),
      ctx(bus),
    );
    expect(resp.result).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      event: "loops:approval_resolved",
      payload: { loopId: "docs", runId: "r1", decision: "declined", conversationId: "c1" },
    });
  });

  test("a missing bus is a clean no-op emit (still ok)", async () => {
    const resp = await handleEmitLoopEventRpc(
      ext(),
      rpc({ v: 1, type: "approval_pending", payload: { loopId: "docs", runId: "r1" } }),
      ctx(undefined),
    );
    expect(resp.result).toEqual({ ok: true });
  });
});

describe("handleEmitLoopEventRpc — rate limit", () => {
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
