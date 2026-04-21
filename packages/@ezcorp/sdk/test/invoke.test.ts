// invoke.test.ts — 100% line + branch coverage for runtime/invoke.ts
//
// Strategy: invoke() is a thin wrapper over getChannel().request. Tests
// spy on the singleton's .request method and assert (a) the JSON-RPC
// method is "ezcorp/invoke", (b) params shape is
// { tool: toolName, arguments: args } (NOT the raw args object), and
// (c) opts.timeoutMs is forwarded as the 3rd arg or left undefined.

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { invoke } from "../src/runtime/invoke";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";

// Per-file afterEach guard — preload.ts already wires global reset, but
// this keeps the file self-contained under direct `bun test <file>` runs.
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

// ── param-shape & method ────────────────────────────────────────

describe("invoke — JSON-RPC frame shape", () => {
  test("sends method 'ezcorp/invoke' with params { tool, arguments }", async () => {
    const { calls } = stubRequest({ ok: true });
    const result = await invoke("my.tool", { a: 1, b: 2 });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("ezcorp/invoke");
    expect(calls[0]?.params).toEqual({
      tool: "my.tool",
      arguments: { a: 1, b: 2 },
    });
  });

  test("wraps args under `arguments` key — NOT passed raw", async () => {
    const { calls } = stubRequest(null);
    await invoke("x", { key: "value" });
    const params = calls[0]?.params as Record<string, unknown>;
    // Guard: raw args would surface `key` at the top level.
    expect(params).not.toHaveProperty("key");
    expect(params.arguments).toEqual({ key: "value" });
  });

  test("empty args object still arrives as `arguments: {}`", async () => {
    const { calls } = stubRequest(null);
    await invoke("noargs", {});
    expect(calls[0]?.params).toEqual({ tool: "noargs", arguments: {} });
  });
});

// ── timeout forwarding ──────────────────────────────────────────

describe("invoke — timeoutMs pass-through", () => {
  test("opts.timeoutMs forwarded as 3rd arg to channel.request", async () => {
    const { calls } = stubRequest(null);
    await invoke("t", {}, { timeoutMs: 500 });
    expect(calls[0]?.timeoutMs).toBe(500);
  });

  test("3rd arg is undefined when opts is omitted entirely", async () => {
    const { calls } = stubRequest(null);
    await invoke("t", {});
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  test("3rd arg is undefined when opts is {} (no timeoutMs field)", async () => {
    const { calls } = stubRequest(null);
    await invoke("t", {}, {});
    expect(calls[0]?.timeoutMs).toBeUndefined();
  });

  test("timeoutMs: 0 is forwarded literally (disables channel timer)", async () => {
    const { calls } = stubRequest(null);
    await invoke("t", {}, { timeoutMs: 0 });
    expect(calls[0]?.timeoutMs).toBe(0);
  });
});

// ── propagation & typing ────────────────────────────────────────

describe("invoke — channel behavior propagation", () => {
  test("channel rejection propagates to the caller (timeout case)", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new Error("[@ezcorp/sdk] request timeout after 100ms: ezcorp/invoke");
      }) as HostChannel["request"],
    );
    await expect(invoke("slow", {}, { timeoutMs: 100 })).rejects.toThrow(
      /timeout after 100ms/,
    );
  });

  test("channel rejection propagates to the caller (host protocol error case)", async () => {
    const ch = getChannel();
    const spy = spyOn(ch, "request");
    spy.mockImplementation(
      (async () => {
        throw new Error("Tool not found: missing");
      }) as HostChannel["request"],
    );
    await expect(invoke("missing", {})).rejects.toThrow(/Tool not found: missing/);
  });

  test("generic type parameter narrows the resolved value", async () => {
    stubRequest<{ count: number }>({ count: 7 });
    const result = await invoke<{ count: number }>("countTool", {});
    expect(result.count).toBe(7);
  });
});
