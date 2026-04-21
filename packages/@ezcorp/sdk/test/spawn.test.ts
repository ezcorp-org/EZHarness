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

// ── Phase 4 §5.1a: pass-through of 5 new optional fields ────────────
//
// Each field is omitted when absent (no `{key: undefined}` on the wire)
// and echoed verbatim when provided. Also covers the orchestrationDepth
// numeric-type gate: only `typeof === "number"` passes through.

describe("spawnAssignment — Phase 4 new-field serialization", () => {
  test("no Phase 4 fields in params when none supplied (absence test)", async () => {
    const { calls } = happy();
    await spawnAssignment({ agentConfigId: "cfg-1", task: "t" });
    const params = calls[0]?.params as Record<string, unknown>;
    expect(params).not.toHaveProperty("reuseSubConversationFor");
    expect(params).not.toHaveProperty("parentMessageId");
    expect(params).not.toHaveProperty("overrides");
    expect(params).not.toHaveProperty("teamToolScope");
    expect(params).not.toHaveProperty("orchestrationDepth");
  });

  test("reuseSubConversationFor: echoed verbatim", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      reuseSubConversationFor: "cfg-target",
    });
    expect((calls[0]?.params as Record<string, unknown>).reuseSubConversationFor).toBe(
      "cfg-target",
    );
  });

  test("parentMessageId: echoed verbatim", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      parentMessageId: "msg-anchor-123",
    });
    expect((calls[0]?.params as Record<string, unknown>).parentMessageId).toBe(
      "msg-anchor-123",
    );
  });

  test("overrides: full TeamMemberOverrides bundle is echoed verbatim", async () => {
    const { calls } = happy();
    const overrides = {
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      systemPromptAppend: "Be concise.",
      permissionMode: "yolo",
      toolRestriction: "read-only",
      allowedTools: ["bash", "read"],
      deniedTools: ["write"],
      modeId: "mode-fast",
    };
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      overrides,
    });
    expect((calls[0]?.params as Record<string, unknown>).overrides).toEqual(overrides);
  });

  test("teamToolScope: both lists echoed verbatim", async () => {
    const { calls } = happy();
    const teamToolScope = { allowedTools: ["read", "grep"], deniedTools: ["bash"] };
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      teamToolScope,
    });
    expect((calls[0]?.params as Record<string, unknown>).teamToolScope).toEqual(teamToolScope);
  });

  test("orchestrationDepth: numeric value echoed verbatim", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      orchestrationDepth: 3,
    });
    expect((calls[0]?.params as Record<string, unknown>).orchestrationDepth).toBe(3);
  });

  test("orchestrationDepth: zero is a valid value (not filtered as falsy)", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      orchestrationDepth: 0,
    });
    // The `typeof === "number"` gate must admit 0; proves we don't truthy-filter it.
    expect((calls[0]?.params as Record<string, unknown>).orchestrationDepth).toBe(0);
  });

  test("orchestrationDepth: non-numeric is dropped (typeof gate)", async () => {
    const { calls } = happy();
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      // Force an invalid type past TS.
      orchestrationDepth: "3" as unknown as number,
    });
    expect((calls[0]?.params as Record<string, unknown>)).not.toHaveProperty(
      "orchestrationDepth",
    );
  });

  test("all 5 Phase 4 fields together — each sits at its own key", async () => {
    const { calls } = happy();
    const overrides = { model: "gpt-4o" };
    const teamToolScope = { allowedTools: ["read"] };
    await spawnAssignment({
      agentConfigId: "cfg-1",
      task: "t",
      reuseSubConversationFor: "cfg-r",
      parentMessageId: "mid",
      overrides,
      teamToolScope,
      orchestrationDepth: 2,
    });
    expect(calls[0]?.params).toEqual({
      v: 1,
      task: "t",
      agentConfigId: "cfg-1",
      reuseSubConversationFor: "cfg-r",
      parentMessageId: "mid",
      overrides,
      teamToolScope,
      orchestrationDepth: 2,
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
