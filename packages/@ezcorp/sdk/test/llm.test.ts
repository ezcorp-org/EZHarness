// llm.test.ts — coverage for runtime/llm.ts (Phase 51.1).
//
// Asserts the SDK class wraps `ezcorp/llm-complete` correctly, maps
// soft-fail RPC error codes onto typed errors, and that
// `ctx.llm.stream()` throws NotImplementedError immediately (locked
// decision: streaming deferred to v1.4).

import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  Llm,
  LlmQuotaError,
  LlmProviderError,
  LlmCredentialError,
  NotImplementedError,
} from "../src/runtime/llm";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../src/runtime/channel";

afterEach(() => {
  __resetChannelForTests();
});

interface RequestCall { method: string; params: unknown }

function stubRequest(
  impl: (call: RequestCall) => Promise<unknown>,
): { calls: RequestCall[] } {
  const ch: HostChannel = getChannel();
  const calls: RequestCall[] = [];
  const spy = spyOn(ch, "request");
  spy.mockImplementation((async (method: string, params: unknown) => {
    const call: RequestCall = { method, params };
    calls.push(call);
    return impl(call);
  }) as HostChannel["request"]);
  return { calls };
}

describe("Llm — wire format", () => {
  test("complete() sends `op:'complete'` to ezcorp/llm-complete", async () => {
    const { calls } = stubRequest(async () => ({
      content: "ok",
      blocks: [],
      usage: { inputTokens: 1, outputTokens: 2 },
      finishReason: "stop",
      model: "claude-sonnet-4",
    }));
    const result = await new Llm().complete({
      provider: "anthropic",
      model: "claude-sonnet-4",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
    });
    expect(calls[0]?.method).toBe("ezcorp/llm-complete");
    const params = calls[0]!.params as Record<string, unknown>;
    expect(params.op).toBe("complete");
    expect(params.provider).toBe("anthropic");
    expect(params.model).toBe("claude-sonnet-4");
    expect(params.maxTokens).toBe(100);
    expect(result.content).toBe("ok");
  });

  test("getBudget() sends `op:'budget'`", async () => {
    const { calls } = stubRequest(async () => ({
      callsRemaining: { hour: 60, day: 500 },
      tokensRemaining: { day: 10_000 },
    }));
    const snapshot = await new Llm().getBudget("anthropic");
    expect(calls[0]?.method).toBe("ezcorp/llm-complete");
    const params = calls[0]!.params as Record<string, unknown>;
    expect(params.op).toBe("budget");
    expect(snapshot.callsRemaining.hour).toBe(60);
  });
});

describe("Llm — error mapping", () => {
  test("-32101 → LlmProviderError", async () => {
    stubRequest(async () => { throw new JsonRpcError(-32101, "Provider not granted"); });
    try {
      await new Llm().complete({
        provider: "openai", model: "gpt-4",
        messages: [{ role: "user", content: "x" }],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmProviderError);
      expect((e as LlmProviderError).provider).toBe("openai");
      expect((e as LlmProviderError).code).toBe("LLM_PROVIDER_NOT_GRANTED");
    }
  });

  test("-32103 → LlmQuotaError with retryAfterMs", async () => {
    stubRequest(async () => {
      throw new JsonRpcError(-32103, "Quota exceeded", {
        reason: "calls-per-hour", retryAfterMs: 1234,
      });
    });
    try {
      await new Llm().complete({
        provider: "anthropic", model: "claude-sonnet-4",
        messages: [{ role: "user", content: "x" }],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmQuotaError);
      expect((e as LlmQuotaError).reason).toBe("calls-per-hour");
      expect((e as LlmQuotaError).retryAfterMs).toBe(1234);
    }
  });

  test("-32104 → LlmCredentialError", async () => {
    stubRequest(async () => { throw new JsonRpcError(-32104, "Credential missing"); });
    try {
      await new Llm().complete({
        provider: "anthropic", model: "claude-sonnet-4",
        messages: [{ role: "user", content: "x" }],
      });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(LlmCredentialError);
      expect((e as LlmCredentialError).code).toBe("LLM_CREDENTIAL_MISSING");
    }
  });
});

describe("Llm — stream() is stub-only", () => {
  test("stream() throws NotImplementedError immediately (deferred to v1.4)", async () => {
    const llm = new Llm();
    const iter = llm.stream({
      provider: "anthropic", model: "claude-sonnet-4",
      messages: [{ role: "user", content: "x" }],
    });
    let threw: unknown = null;
    try {
      // The async generator throws on first iteration.
      // eslint-disable-next-line no-empty
      for await (const _ of iter) {}
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(NotImplementedError);
    expect((threw as NotImplementedError).message).toContain("v1.4");
  });
});
