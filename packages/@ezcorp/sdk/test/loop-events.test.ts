// loop-events.test.ts — 100% coverage for the LoopEvents reverse-RPC client.
//
// `LoopEvents` emits the two content-free approval nudges over
// `ezcorp/emit-loop-event`. We spy `getChannel().request` (mirroring
// memory.test.ts) to assert the exact wire shape — the payload must carry
// ONLY loopId/runId (+ decision + optional conversationId), never a
// proposal body.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { LoopEvents } from "../src/runtime/loop-events";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: Record<string, unknown>;
}

function stubRequest(): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  spyOn(ch, "request").mockImplementation(
    (async (method: string, params: unknown) => {
      calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
      return { ok: true };
    }) as HostChannel["request"],
  );
  return { calls };
}

describe("LoopEvents.emitApprovalPending", () => {
  test("emits v1 approval_pending with a content-free payload (no conversation)", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitApprovalPending({ loopId: "docs", runId: "r1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("ezcorp/emit-loop-event");
    expect(calls[0]!.params).toEqual({
      v: 1,
      type: "approval_pending",
      payload: { loopId: "docs", runId: "r1" },
    });
    // Never carries a proposal body.
    const payload = calls[0]!.params.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("proposal");
  });

  test("threads conversationId when the loop is conversation-wired", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitApprovalPending({ loopId: "docs", runId: "r1", conversationId: "c9" });
    expect((calls[0]!.params.payload as Record<string, unknown>).conversationId).toBe("c9");
  });
});

describe("LoopEvents.emitApprovalResolved", () => {
  test("emits v1 approval_resolved carrying the decision", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitApprovalResolved({ loopId: "docs", runId: "r1", decision: "approved" });
    expect(calls[0]!.params).toEqual({
      v: 1,
      type: "approval_resolved",
      payload: { loopId: "docs", runId: "r1", decision: "approved" },
    });
  });

  test("threads conversationId + declined decision", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitApprovalResolved({
      loopId: "docs",
      runId: "r1",
      decision: "declined",
      conversationId: "c9",
    });
    expect(calls[0]!.params.payload).toEqual({
      loopId: "docs",
      runId: "r1",
      decision: "declined",
      conversationId: "c9",
    });
  });
});

describe("LoopEvents.emitAutoDisabled", () => {
  test("emits v1 auto_disabled with the loop id + error count (no runId)", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitAutoDisabled({ loopId: "flaky", consecutiveErrors: 5 });
    expect(calls[0]!.params).toEqual({
      v: 1,
      type: "auto_disabled",
      payload: { loopId: "flaky", consecutiveErrors: 5 },
    });
  });

  test("threads conversationId when present", async () => {
    const { calls } = stubRequest();
    await new LoopEvents().emitAutoDisabled({ loopId: "flaky", consecutiveErrors: 3, conversationId: "c1" });
    expect((calls[0]!.params.payload as Record<string, unknown>).conversationId).toBe("c1");
  });
});
