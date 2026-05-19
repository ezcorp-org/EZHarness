// agent-configs.test.ts — coverage for runtime/agent-configs.ts (Phase 2b).
//
// Spy getChannel().request to (a) assert the RPC shape matches the
// host's contract, (b) feed back synthetic responses, (c) verify error
// propagation for the -32001 / -32029 / -32602 cases documented in
// agent-configs-handler.ts.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { AgentConfigs } from "../src/runtime/agent-configs";
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
}

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation(
    (async (method: string, params: unknown) => {
      const call: RequestCall = { method, params };
      calls.push(call);
      return impl(call);
    }) as HostChannel["request"],
  );
  return { calls };
}

function paramsOf(call: RequestCall | undefined): Record<string, unknown> {
  return (call?.params ?? {}) as Record<string, unknown>;
}

const sampleSummary = {
  id: "agent-1",
  name: "helper",
  description: "helps",
  isTeam: false,
  ownerUserId: "user-alice",
};

// ── Wire format ─────────────────────────────────────────────────

describe("AgentConfigs — wire format", () => {
  test("list() sends { v:1, action:'list' } to ezcorp/agent-configs", async () => {
    const { calls } = stubRequest(async () => ({ v: 1, configs: [sampleSummary] }));
    await new AgentConfigs().list();
    expect(calls[0]?.method).toBe("ezcorp/agent-configs");
    expect(paramsOf(calls[0])).toEqual({ v: 1, action: "list" });
  });

  test("resolve(id) sends { v:1, action:'resolve', idOrName } to ezcorp/agent-configs", async () => {
    const { calls } = stubRequest(async () => ({ v: 1, config: sampleSummary }));
    await new AgentConfigs().resolve("agent-1");
    expect(paramsOf(calls[0])).toEqual({
      v: 1,
      action: "resolve",
      idOrName: "agent-1",
    });
  });
});

// ── Return unwrapping ───────────────────────────────────────────

describe("AgentConfigs — return unwrapping", () => {
  test("list() returns the configs array from the envelope", async () => {
    stubRequest(async () => ({ v: 1, configs: [sampleSummary, { ...sampleSummary, id: "x", name: "other" }] }));
    const out = await new AgentConfigs().list();
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(sampleSummary);
  });

  test("list() with empty result returns empty array", async () => {
    stubRequest(async () => ({ v: 1, configs: [] }));
    const out = await new AgentConfigs().list();
    expect(out).toEqual([]);
  });

  test("resolve() returns the config object when match is found", async () => {
    stubRequest(async () => ({ v: 1, config: sampleSummary }));
    const out = await new AgentConfigs().resolve("helper");
    expect(out).toEqual(sampleSummary);
  });

  test("resolve() returns null when host reports no match", async () => {
    stubRequest(async () => ({ v: 1, config: null }));
    const out = await new AgentConfigs().resolve("missing");
    expect(out).toBeNull();
  });
});

// ── Error propagation ───────────────────────────────────────────

describe("AgentConfigs — error propagation", () => {
  test("-32001 (permission denied) propagates as JsonRpcError", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32001, "agentConfig permission not granted");
    });
    await expect(new AgentConfigs().list()).rejects.toThrow(
      /agentConfig permission/,
    );
  });

  test("-32029 (rate limited) propagates — no client-side retry", async () => {
    let attempts = 0;
    stubRequest(async () => {
      attempts += 1;
      throw new JsonRpcError(-32029, "Rate limited");
    });
    await expect(new AgentConfigs().list()).rejects.toThrow(/Rate limited/);
    expect(attempts).toBe(1);
  });

  test("-32602 (bad params) propagates", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32602, "User scope unavailable");
    });
    await expect(
      new AgentConfigs().resolve("anything"),
    ).rejects.toThrow(/User scope/);
  });
});
