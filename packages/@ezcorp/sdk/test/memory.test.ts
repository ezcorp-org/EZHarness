// memory.test.ts — 100% line coverage for runtime/memory.ts
//
// `Memory` is a typed client over the `ezcorp/memory` reverse RPC. We
// spy `getChannel().request` (mirroring storage.test.ts) to assert the
// per-action wire shape and to feed synthetic results / errors. The
// notable branch is `get()`, which maps a -32001 JsonRpcError (host's
// "not found" code) to `null` but rethrows every other error.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { Memory, type MemoryRecord } from "../src/runtime/memory";
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
  params: Record<string, unknown>;
}

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown) => {
      const call: RequestCall = {
        method,
        params: (params ?? {}) as Record<string, unknown>,
      };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls };
}

function makeMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "m1",
    content: "User prefers dark mode.",
    category: "preferences",
    confidence: "high",
    status: "active",
    projectId: null,
    conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Memory.list", () => {
  test("no opts → only { action: 'list' }, returns memories", async () => {
    const mem = makeMemory();
    const { calls } = stubRequest(async () => ({ memories: [mem] }));
    const result = await new Memory().list();
    expect(calls[0]?.method).toBe("ezcorp/memory");
    expect(calls[0]?.params).toEqual({ action: "list" });
    expect(result).toEqual([mem]);
  });

  test("category only attaches category, omits limit", async () => {
    const { calls } = stubRequest(async () => ({ memories: [] }));
    await new Memory().list({ category: "technical" });
    expect(calls[0]?.params).toEqual({ action: "list", category: "technical" });
  });

  test("limit only attaches limit (including 0), omits category", async () => {
    const { calls } = stubRequest(async () => ({ memories: [] }));
    await new Memory().list({ limit: 0 });
    expect(calls[0]?.params).toEqual({ action: "list", limit: 0 });
  });

  test("both category + limit attached", async () => {
    const { calls } = stubRequest(async () => ({ memories: [] }));
    await new Memory().list({ category: "decisions_goals", limit: 5 });
    expect(calls[0]?.params).toEqual({
      action: "list",
      category: "decisions_goals",
      limit: 5,
    });
  });

  test("empty opts omits both", async () => {
    const { calls } = stubRequest(async () => ({ memories: [] }));
    await new Memory().list({});
    expect(calls[0]?.params).toEqual({ action: "list" });
  });
});

describe("Memory.get", () => {
  test("sends { action:'get', id } and returns the record", async () => {
    const mem = makeMemory({ id: "abc" });
    const { calls } = stubRequest(async () => ({ memory: mem }));
    const result = await new Memory().get("abc");
    expect(calls[0]?.params).toEqual({ action: "get", id: "abc" });
    expect(result).toEqual(mem);
  });

  test("maps -32001 JsonRpcError to null (host 'not found')", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32001, "memory not found");
    });
    expect(await new Memory().get("ghost")).toBeNull();
  });

  test("rethrows a JsonRpcError with a different code", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32000, "boom");
    });
    await expect(new Memory().get("x")).rejects.toThrow(/boom/);
  });

  test("rethrows a non-JsonRpcError verbatim", async () => {
    stubRequest(async () => {
      throw new Error("network down");
    });
    await expect(new Memory().get("x")).rejects.toThrow(/network down/);
  });
});

describe("Memory.write", () => {
  test("forwards input + returns the created record", async () => {
    const mem = makeMemory();
    const { calls } = stubRequest(async () => ({ memory: mem }));
    const input = {
      content: "User prefers dark mode.",
      category: "preferences" as const,
      confidence: "high" as const,
      sourceMessageIds: ["msg-1"],
      projectId: "p1",
    };
    const result = await new Memory().write(input);
    expect(calls[0]?.params).toEqual({ action: "write", input });
    expect(result).toEqual(mem);
  });
});

describe("Memory.update / archive", () => {
  test("update sends { action:'update', id, patch } and returns {ok:true}", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const patch = { content: "updated", confidence: "low" as const };
    const result = await new Memory().update("id-1", patch);
    expect(calls[0]?.params).toEqual({ action: "update", id: "id-1", patch });
    expect(result).toEqual({ ok: true });
  });

  test("archive sends { action:'archive', id } and returns {ok:true}", async () => {
    const { calls } = stubRequest(async () => ({ ok: true }));
    const result = await new Memory().archive("id-2");
    expect(calls[0]?.params).toEqual({ action: "archive", id: "id-2" });
    expect(result).toEqual({ ok: true });
  });
});
