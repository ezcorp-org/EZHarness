// Unit tests for handleQueueAgentMessageRpc (Phase B3 — send_to_agent host
// side). The handler enqueues a steering message onto a running child's
// sub-conversation. We inject the `getSubConversations` + `enqueue` seams so no
// DB / real pending-messages module is needed, and a stub PDP engine.

import { test, expect, describe } from "bun:test";
import {
  handleQueueAgentMessageRpc,
  MAX_QUEUE_MESSAGE_CHARS,
  type QueueAgentMessageContext,
  type QueueAgentMessageDeps,
} from "../extensions/spawn-assignment-handler";
import type { JsonRpcRequest } from "../extensions/types";
import type { PermissionEngine } from "../extensions/permission-engine";

const EXT = "orchestration";
const CONV = "conv-parent";
const SUB = "sub-child-1";

const allowEngine = {
  authorize: async () => ({ decision: "allow" as const }),
} as unknown as PermissionEngine;
const denyEngine = {
  authorize: async () => ({ decision: "deny" as const }),
} as unknown as PermissionEngine;

function makeCtx(over: Partial<QueueAgentMessageContext> = {}): QueueAgentMessageContext {
  return {
    conversationId: CONV,
    userId: "user-1",
    grantedPermissions: { grantedAt: {}, spawnAgents: { maxPerHour: 10, maxConcurrent: 3 } },
    engine: allowEngine,
    ...over,
  };
}

function makeDeps(over: Partial<QueueAgentMessageDeps> = {}) {
  const enqueued: Array<{ sub: string; content: string }> = [];
  const deps: QueueAgentMessageDeps = {
    getSubConversations: (async (_conv: string) => [
      { id: SUB, agentConfigId: "cfg-a" },
    ]) as unknown as QueueAgentMessageDeps["getSubConversations"],
    enqueue: ((sub: string, msg: { content: string }) => {
      enqueued.push({ sub, content: msg.content });
    }) as unknown as QueueAgentMessageDeps["enqueue"],
    ...over,
  };
  return { deps, enqueued };
}

function req(params: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "ezcorp/queue-agent-message", params };
}

describe("handleQueueAgentMessageRpc", () => {
  test("happy path: owned running child → enqueues + returns { queued: true }", async () => {
    const { deps, enqueued } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "also check X" }),
      makeCtx(),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: true });
    expect(enqueued).toEqual([{ sub: SUB, content: "also check X" }]);
  });

  test("foreign / unknown sub-conversation → fail-closed not-found, no enqueue", async () => {
    const { deps, enqueued } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: "sub-someone-else", message: "hi" }),
      makeCtx(),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: false, reason: "not-found" });
    expect(enqueued).toHaveLength(0);
  });

  test("PDP deny → -32001, no enqueue", async () => {
    const { deps, enqueued } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "hi" }),
      makeCtx({ engine: denyEngine }),
      deps,
    );
    expect(resp.error?.code).toBe(-32001);
    expect(enqueued).toHaveLength(0);
  });

  test("kill-switch (EZCORP_DISABLE_CAPABILITY_TOOLS) → -32001", async () => {
    const { deps } = makeDeps();
    const prev = process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    try {
      const resp = await handleQueueAgentMessageRpc(
        EXT,
        req({ v: 1, subConversationId: SUB, message: "hi" }),
        makeCtx(),
        deps,
      );
      expect(resp.error?.code).toBe(-32001);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
      else process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = prev;
    }
  });

  test("invalid spawnAgents quota → -32001 (quota config invalid)", async () => {
    const { deps } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "hi" }),
      makeCtx({ grantedPermissions: { grantedAt: {} } }),
      deps,
    );
    expect(resp.error?.code).toBe(-32001);
  });

  test("unbound conversation → -32602", async () => {
    const { deps } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "hi" }),
      makeCtx({ conversationId: "unknown" }),
      deps,
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("wrong payload version → -32602", async () => {
    const { deps } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 2, subConversationId: SUB, message: "hi" }),
      makeCtx(),
      deps,
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("empty subConversationId → -32602", async () => {
    const { deps } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: "  ", message: "hi" }),
      makeCtx(),
      deps,
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("empty message → -32602", async () => {
    const { deps } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "   " }),
      makeCtx(),
      deps,
    );
    expect(resp.error?.code).toBe(-32602);
  });

  test("message over the char cap → -32602", async () => {
    const { deps, enqueued } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "x".repeat(MAX_QUEUE_MESSAGE_CHARS + 1) }),
      makeCtx(),
      deps,
    );
    expect(resp.error?.code).toBe(-32602);
    expect(enqueued).toHaveLength(0);
  });

  test("no engine (pre-PDP unit context) still enqueues on valid quota", async () => {
    const { deps, enqueued } = makeDeps();
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "go" }),
      makeCtx({ engine: undefined }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: true });
    expect(enqueued).toHaveLength(1);
  });

  test("liveness: owned child with a LIVE run → STEERS (delivery: steered, no enqueue)", async () => {
    const { deps, enqueued } = makeDeps();
    const steerCalls: Array<{ sub: string; message: string; hasCallback: boolean }> = [];
    const executor = {
      getActiveRunForConversation: (id: string) =>
        id === SUB ? ({ id: "run-live" } as unknown) : undefined,
      steerConversation: (sub: string, message: string, onUndelivered?: () => void) => {
        steerCalls.push({ sub, message, hasCallback: typeof onUndelivered === "function" });
        return { status: "steered", runId: "run-live" };
      },
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "steer" }),
      makeCtx({ executor }),
      deps,
    );
    // Atomic: steered ⇒ delivery signal + NO enqueue. The re-enqueue fallback
    // callback is handed to the executor (fired only if the steer is dropped).
    expect(resp.result).toEqual({ v: 1, queued: true, delivery: "steered" });
    expect(steerCalls).toEqual([{ sub: SUB, message: "steer", hasCallback: true }]);
    expect(enqueued).toHaveLength(0);
  });

  test("liveness: LIVE run but steer declined (no-agent) → enqueue fallback (queued: true)", async () => {
    const { deps, enqueued } = makeDeps();
    const executor = {
      getActiveRunForConversation: (id: string) =>
        id === SUB ? ({ id: "run-live" } as unknown) : undefined,
      // Pre-first-token window: a live run but no Agent registered yet.
      steerConversation: () => ({ status: "no-agent", runId: "run-live" }),
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "steer" }),
      makeCtx({ executor }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: true }); // unchanged fallback shape
    expect(enqueued).toEqual([{ sub: SUB, content: "steer" }]);
  });

  test("liveness: LIVE run but steer sees no-live-run (race) → enqueue fallback", async () => {
    // Post-P3 `steerConversation` is a REQUIRED member of the executor Pick, so
    // there is no longer an "executor without steerConversation" fixture. The
    // remaining non-`steered` fallback this exercises is the race where the run
    // ends BETWEEN the step-6 liveness check (still live) and this steer (the
    // run reached terminal in the gap → `no-live-run`) → enqueue for the next run.
    const { deps, enqueued } = makeDeps();
    const executor = {
      getActiveRunForConversation: (id: string) =>
        id === SUB ? ({ id: "run-live" } as unknown) : undefined,
      steerConversation: () => ({ status: "no-live-run" }),
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "steer" }),
      makeCtx({ executor }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: true });
    expect(enqueued).toHaveLength(1);
  });

  test("liveness: LIVE run but steer is GUARDED (autonomous/schema child) → enqueue fallback", async () => {
    // P4: an autonomous / structured-output child registers a guarding run mode,
    // so steerConversation returns `guarded` WITHOUT steering. The handler's
    // "any non-steered result → enqueue" fallback must route it to
    // pending-messages so branch (1)'s run-boundary drain delivers it — the
    // pre-P3 behavior, preserved for exactly those children.
    const { deps, enqueued } = makeDeps();
    const executor = {
      getActiveRunForConversation: (id: string) =>
        id === SUB ? ({ id: "run-live" } as unknown) : undefined,
      steerConversation: () => ({ status: "guarded", runId: "run-live", reason: "autonomous" }),
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "steer" }),
      makeCtx({ executor }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: true }); // NOT delivery: steered
    expect(enqueued).toEqual([{ sub: SUB, content: "steer" }]);
  });

  test("liveness: owned child with NO live run → not-running, no enqueue", async () => {
    const { deps, enqueued } = makeDeps();
    const executor = {
      getActiveRunForConversation: () => undefined,
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: SUB, message: "steer" }),
      makeCtx({ executor }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: false, reason: "not-running" });
    expect(enqueued).toHaveLength(0);
  });

  test("an idle-but-foreign target still fails not-found before the liveness check", async () => {
    const { deps } = makeDeps();
    const executor = {
      getActiveRunForConversation: () => undefined,
    } as unknown as QueueAgentMessageContext["executor"];
    const resp = await handleQueueAgentMessageRpc(
      EXT,
      req({ v: 1, subConversationId: "sub-foreign", message: "hi" }),
      makeCtx({ executor }),
      deps,
    );
    expect(resp.result).toEqual({ v: 1, queued: false, reason: "not-found" });
  });
});
