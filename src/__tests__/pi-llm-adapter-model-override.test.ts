/**
 * `createPiLlmAdapter` — the ONE chokepoint a per-step model binding
 * reaches the LLM through.
 *
 * The load-bearing assertion in this file is the COMPATIBILITY one:
 * constructed with no override, the adapter must issue exactly the call it
 * always did — `complete(piModel, context, { apiKey })` with the caller's
 * own provider/model and no sampling options bolted on. Everything else
 * here is the new behaviour that only switches on when an override is
 * supplied.
 */
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

interface RecordedCall {
  entry: "complete" | "stream";
  model: { id: string };
  options: Record<string, unknown>;
}

const calls: RecordedCall[] = [];

function record(entry: RecordedCall["entry"]) {
  return (model: { id: string }, _context: unknown, options: Record<string, unknown>) => {
    calls.push({ entry, model, options });
    return stubAssistantMessage("hi");
  };
}

async function* oneToken(): AsyncGenerator<unknown> {
  yield { type: "text_delta", delta: "hi" };
  yield { type: "done", message: { usage: { input: 1, output: 2 } } };
}

function recordStream(entry: RecordedCall["entry"]) {
  return (model: { id: string }, _context: unknown, options: Record<string, unknown>) => {
    calls.push({ entry, model, options });
    return oneToken();
  };
}

mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: async (m: { id: string }, c: unknown, o: Record<string, unknown>) => record("complete")(m, c, o),
  stream: recordStream("stream"),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic"],
  getEnvApiKey: () => undefined,
}));

/** Every provider/model pair `resolveModel` was asked for. */
const resolveArgs: Array<[string | undefined, string | undefined]> = [];

mock.module("../providers/router", () => ({
  resolveModel: async (provider?: string, model?: string) => {
    resolveArgs.push([provider, model]);
    return {
      provider: provider ?? "router-provider",
      model: model ?? "router-model",
      piModel: { id: model ?? "router-model" },
    };
  },
  suggestFallback: async () => null,
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ token: "sk-test", type: "apikey" }),
}));

const { createPiLlmAdapter } = await import("../runtime/executor-helpers");

const messages = [{ role: "user" as const, content: "hello" }];

beforeEach(() => {
  calls.length = 0;
  resolveArgs.length = 0;
});

describe("createPiLlmAdapter — no override (compatibility)", () => {
  test("complete() issues the historical raw call with only apiKey", async () => {
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { system: "s", provider: "anthropic", model: "agent-model" });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.entry).toBe("complete");
    // Byte-identical options object: apiKey and nothing else. A stray
    // `temperature: undefined` key would already be a wire change.
    expect(Object.keys(calls[0]!.options)).toEqual(["apiKey"]);
    expect(calls[0]!.options.apiKey).toBe("sk-test");
    // The CALLER's binding reaches the router untouched.
    expect(resolveArgs).toEqual([["anthropic", "agent-model"]]);
  });

  test("stream() issues the historical raw call with apiKey + signal", async () => {
    const adapter = createPiLlmAdapter();
    const signal = new AbortController().signal;
    for await (const _ of adapter.stream(messages, { model: "agent-model", signal })) {
      // drain
    }
    expect(calls[0]!.entry).toBe("stream");
    expect(Object.keys(calls[0]!.options).sort()).toEqual(["apiKey", "signal"]);
    expect(calls[0]!.options.signal).toBe(signal);
  });

  test("an explicit `undefined` override is the same as omitting the argument", async () => {
    // The workflow executor always passes a 5th argument, so this is the
    // shape the no-binding path actually takes in production.
    const adapter = createPiLlmAdapter(undefined);
    await adapter.complete(messages, { provider: "anthropic", model: "agent-model" });
    expect(calls[0]!.entry).toBe("complete");
    expect(Object.keys(calls[0]!.options)).toEqual(["apiKey"]);
    expect(resolveArgs).toEqual([["anthropic", "agent-model"]]);
  });

  test("the CURRENT_MODEL_SENTINEL is passed through verbatim, not interpreted", async () => {
    // The agent-config inherit sentinel is the router's problem, not the
    // adapter's — the adapter must not start resolving it.
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { provider: "__current__", model: "__current__" });
    expect(resolveArgs).toEqual([["__current__", "__current__"]]);
  });
});

describe("createPiLlmAdapter — with an override", () => {
  test("provider/model beat the caller's own binding", async () => {
    const adapter = createPiLlmAdapter({ provider: "openai", model: "gpt-5" });
    await adapter.complete(messages, { provider: "anthropic", model: "agent-model" });
    expect(resolveArgs).toEqual([["openai", "gpt-5"]]);
  });

  test("a partial override keeps the caller's other half", async () => {
    const adapter = createPiLlmAdapter({ model: "claude-haiku-4-5" });
    await adapter.complete(messages, { provider: "anthropic", model: "agent-model" });
    expect(resolveArgs).toEqual([["anthropic", "claude-haiku-4-5"]]);
  });

  test("temperature / maxTokens are forwarded to the provider", async () => {
    const adapter = createPiLlmAdapter({ temperature: 0.1, maxTokens: 8000 });
    await adapter.complete(messages, {});
    expect(calls[0]!.entry).toBe("complete");
    expect(calls[0]!.options).toEqual({ apiKey: "sk-test", temperature: 0.1, maxTokens: 8000 });
  });

  test("stream() honours the same override", async () => {
    const adapter = createPiLlmAdapter({ model: "gpt-5", temperature: 0.5, maxTokens: 42 });
    for await (const _ of adapter.stream(messages, { model: "agent-model" })) {
      // drain
    }
    expect(calls[0]!.entry).toBe("stream");
    expect(calls[0]!.options.temperature).toBe(0.5);
    expect(calls[0]!.options.maxTokens).toBe(42);
    expect(resolveArgs).toEqual([[undefined, "gpt-5"]]);
  });
});

describe("createPiLlmAdapter — lastResolved", () => {
  test("is undefined until the first call", () => {
    expect(createPiLlmAdapter().lastResolved).toBeUndefined();
  });

  test("reports what the call RESOLVED to, not what was requested", async () => {
    // The router's pick is the answer — an override, an agent binding and a
    // bare "whatever you like" all collapse to one resolved pair here.
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, {});
    expect(adapter.lastResolved).toEqual({ provider: "router-provider", model: "router-model" });
  });

  test("is updated by stream() too, and reflects the most recent call", async () => {
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { provider: "anthropic", model: "first" });
    for await (const _ of adapter.stream(messages, { provider: "openai", model: "second" })) {
      // drain
    }
    expect(adapter.lastResolved).toEqual({ provider: "openai", model: "second" });
  });
});
