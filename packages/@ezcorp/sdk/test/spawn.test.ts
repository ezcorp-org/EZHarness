// spawn.test.ts — coverage for runtime/spawn.ts (Phase 2d).
//
// Strategy mirrors invoke.test.ts — spy on the singleton channel's
// .request method and assert: (a) the JSON-RPC method is
// "ezcorp/spawn-assignment", (b) the params shape includes v:1 and the
// expected keys only when provided, (c) host errors propagate with
// their JsonRpcError code + data intact, (d) synchronous input
// validation throws before any channel call.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { spawnAssignment } from "../src/runtime/spawn";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
}

function stubRequest<T>(
  returnValue: T,
): { calls: RequestCall[]; spy: ReturnType<typeof spyOn> } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown, timeoutMs?: number) => {
      calls.push({ method, params, timeoutMs });
      return returnValue;
    }) as HostChannel["request"],
  );
  return { calls, spy };
}

function happy() {
  return stubRequest({
    v: 1 as const,
    subConversationId: "sub-123",
    agentRunId: "run-abc",
    taskId: "task-xyz",
    assignmentId: "a-1",
  });
}

// ── method + param-shape ────────────────────────────────────────────

describe("spawnAssignment — JSON-RPC frame shape", () => {
  test("sends method 'ezcorp/spawn-assignment' with v:1 and agentConfigId", async () => {
    const { calls } = happy();
    const handle = await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "do the thing",
    });
    expect(handle).toEqual({
      subConversationId: "sub-123",
      agentRunId: "run-abc",
      taskId: "task-xyz",
      assignmentId: "a-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("ezcorp/spawn-assignment");
    expect(calls[0]?.params).toEqual({
      v: 1,
      task: "do the thing",
      agentConfigId: "cfg-1",
    });
  });

  test("sends agentName when only name is supplied (no agentConfigId key)", async () => {
    const { calls } = happy();
    await spawnAssignment({ agentName: "Alice", task: "hello" });
    expect(calls[0]?.params).toEqual({
      v: 1,
      task: "hello",
      agentName: "Alice",
    });
    expect((calls[0]?.params as Record<string, unknown>).agentConfigId).toBeUndefined();
  });

  test("omits title when not provided (no key, not {title: undefined})", async () => {
    const { calls } = happy();
    await spawnAssignment({ agentConfigId: "cfg-1", task: "t" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("title");
  });

  test("includes title when provided", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      title: "Custom Title",
    });
    expect((calls[0]?.params as Record<string, unknown>).title).toBe("Custom Title");
  });

  test("if BOTH agentConfigId and agentName are supplied, both are sent (host decides precedence)", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      agentName: "Alice",
      task: "t",
    });
    expect(calls[0]?.params).toEqual({
      v: 1,
      task: "t",
      agentConfigId: "cfg-1",
      agentName: "Alice",
    });
  });
});

// ── synchronous validation ──────────────────────────────────────────

describe("spawnAssignment — input validation (pre-channel)", () => {
  test("missing both agentConfigId and agentName → throws before channel call", async () => {
    const { calls } = happy();
    await expect(
      spawnAssignment({ task: "hi" } as never),
    ).rejects.toThrow(/agentConfigId.*agentName.*required/i);
    expect(calls).toHaveLength(0);
  });

  test("empty task → throws before channel call", async () => {
    const { calls } = happy();
    await expect(
      spawnAssignment({ agentConfigId: "cfg-1", task: "" }),
    ).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });

  test("whitespace-only task → throws before channel call", async () => {
    const { calls } = happy();
    await expect(
      spawnAssignment({ agentConfigId: "cfg-1", task: "   \n\t" }),
    ).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });

  test("non-string task → throws before channel call", async () => {
    const { calls } = happy();
    await expect(
      spawnAssignment({ agentConfigId: "cfg-1", task: 42 as never }),
    ).rejects.toThrow(/non-empty string/i);
    expect(calls).toHaveLength(0);
  });
});

// ── host error propagation ──────────────────────────────────────────

describe("spawnAssignment — host error propagation", () => {
  test("-32029 Rate limited surfaces as JsonRpcError", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new JsonRpcError(-32029, "Rate limited");
      }) as HostChannel["request"],
    );
    try {
      await spawnAssignment({ agentConfigId: "c", task: "t" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      expect((err as JsonRpcError).code).toBe(-32029);
    }
  });

  test("-32000 hourly-exceeded preserves data.reason", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new JsonRpcError(-32000, "Spawn quota exceeded", {
          reason: "hourly-exceeded",
          limit: 10,
          windowMs: 3_600_000,
        });
      }) as HostChannel["request"],
    );
    try {
      await spawnAssignment({ agentConfigId: "c", task: "t" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      expect((err as JsonRpcError).code).toBe(-32000);
      expect((err as JsonRpcError).data).toMatchObject({
        reason: "hourly-exceeded",
      });
    }
  });

  test("-32001 permission-missing surfaces as JsonRpcError", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new JsonRpcError(-32001, "spawnAgents permission not granted");
      }) as HostChannel["request"],
    );
    try {
      await spawnAssignment({ agentConfigId: "c", task: "t" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(JsonRpcError);
      expect((err as JsonRpcError).code).toBe(-32001);
    }
  });
});
