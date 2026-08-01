/**
 * The adapter half of C5's usage threading: `createPiLlmAdapter` folding
 * every call's reported tokens into a running total, and `AgentRun`
 * carrying that total out.
 *
 * The workflow half — `AgentRun` → `stepRun` → column — is pinned in
 * `workflow-step-telemetry.test.ts`. Split because the failure modes are
 * different: here the risk is arithmetic and the NULL/0 distinction, there
 * it is a hop that silently drops a value.
 */
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

/** Usage the next `complete` call reports, or `undefined` to omit it. */
let nextUsage: { input: number; output: number } | undefined = { input: 10, output: 5 };
/** Usage the next stream's `done` frame reports. */
let nextStreamUsage: { input: number; output: number } | undefined = { input: 7, output: 3 };
/** When true, the stream errors before it ever reaches `done`. */
let streamErrorsEarly = false;

function completion() {
  const msg = stubAssistantMessage("hi");
  if (nextUsage === undefined) {
    // A provider that omits usage entirely. Typed as present, absent at
    // runtime — which is exactly how a cached response arrives.
    msg.usage = {};
    return msg;
  }
  msg.usage = { ...msg.usage, input: nextUsage.input, output: nextUsage.output };
  return msg;
}

async function* streamEvents(): AsyncGenerator<unknown> {
  yield { type: "text_delta", delta: "hi" };
  if (streamErrorsEarly) {
    yield { type: "error", error: { content: [{ type: "text", text: "boom" }] } };
    return;
  }
  yield { type: "done", message: { usage: nextStreamUsage ?? {} } };
}

mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: async () => completion(),
  completeSimple: async () => completion(),
  stream: () => streamEvents(),
  streamSimple: () => streamEvents(),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic"],
  getEnvApiKey: () => undefined,
}));

mock.module("../providers/router", () => ({
  resolveModel: async (provider?: string, model?: string) => ({
    provider: provider ?? "anthropic",
    model: model ?? "claude-opus-5",
    piModel: { id: model ?? "claude-opus-5" },
  }),
  suggestFallback: async () => null,
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ token: "sk-test", type: "apikey" }),
}));

const { createPiLlmAdapter } = await import("../runtime/executor-helpers");

const messages = [{ role: "user" as const, content: "hello" }];

beforeEach(() => {
  nextUsage = { input: 10, output: 5 };
  nextStreamUsage = { input: 7, output: 3 };
  streamErrorsEarly = false;
});

describe("PiLlmAdapter.usage", () => {
  test("is undefined before any call — not a zeroed object", () => {
    // The distinction the whole design rests on. An adapter that started
    // at `{ inputTokens: 0, outputTokens: 0 }` would make "never called an
    // LLM" indistinguishable from "called it and it was free", and the
    // executor would stamp 0 onto a run that made no call at all.
    const adapter = createPiLlmAdapter();
    expect(adapter.usage).toBeUndefined();
  });

  test("records one call's reported tokens", async () => {
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 120, output: 34 };
    await adapter.complete(messages);
    expect(adapter.usage).toEqual({ inputTokens: 120, outputTokens: 34 });
  });

  test("SUMS across several calls in one run", async () => {
    // One `runAgent` may drive several LLM calls, and the number an
    // operator wants is what the run consumed — not what its last call
    // did. Last-write (the `lastResolved` treatment) would undercount.
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 100, output: 10 };
    await adapter.complete(messages);
    nextUsage = { input: 200, output: 20 };
    await adapter.complete(messages);
    nextUsage = { input: 5, output: 1 };
    await adapter.complete(messages);
    expect(adapter.usage).toEqual({ inputTokens: 305, outputTokens: 31 });
  });

  test("a provider that reports NO usage leaves the total untouched", async () => {
    // Not zero, and not `NaN` — the count is simply not folded in. Adding
    // `NaN` once would poison the total for the rest of the run; adding 0
    // would invent a measurement that was never taken.
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 50, output: 5 };
    await adapter.complete(messages);
    nextUsage = undefined;
    await adapter.complete(messages);
    expect(adapter.usage).toEqual({ inputTokens: 50, outputTokens: 5 });
  });

  test("a run whose ONLY call reported nothing has no usage at all", async () => {
    // Stays undefined all the way to SQL NULL. This is the case §6 of the
    // spec names: a cached response, a provider that omits the field.
    const adapter = createPiLlmAdapter();
    nextUsage = undefined;
    await adapter.complete(messages);
    expect(adapter.usage).toBeUndefined();
  });

  test("a genuine zero IS recorded, distinguishably from nothing", async () => {
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 0, output: 0 };
    await adapter.complete(messages);
    expect(adapter.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(adapter.usage).not.toBeUndefined();
  });

  test("the stream path accumulates from its `done` frame", async () => {
    const adapter = createPiLlmAdapter();
    nextStreamUsage = { input: 70, output: 30 };
    for await (const _e of adapter.stream(messages)) {
      // Drained deliberately: the generator is lazy, so a stream that is
      // never consumed reports nothing — which is correct.
    }
    expect(adapter.usage).toEqual({ inputTokens: 70, outputTokens: 30 });
  });

  test("a stream that errors before `done` contributes nothing", async () => {
    // The honest reading: no usage was reported for that call. Charging a
    // guess would be worse than reporting nothing.
    const adapter = createPiLlmAdapter();
    streamErrorsEarly = true;
    const events: string[] = [];
    for await (const e of adapter.stream(messages)) events.push((e as { type: string }).type);
    expect(events).toContain("error");
    expect(events).not.toContain("done");
    expect(adapter.usage).toBeUndefined();
  });

  test("complete and stream share one total", async () => {
    // The adapter is per-`runAgent`, so an agent that mixes both paths
    // must report the sum of both, not whichever ran last.
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 100, output: 10 };
    await adapter.complete(messages);
    nextStreamUsage = { input: 1, output: 2 };
    for await (const _e of adapter.stream(messages)) {
      // drained
    }
    expect(adapter.usage).toEqual({ inputTokens: 101, outputTokens: 12 });
  });

  test("still returns the per-call usage to its caller", async () => {
    // Accumulation is additive to the existing contract, not a
    // replacement: `complete`'s return value is unchanged.
    const adapter = createPiLlmAdapter();
    nextUsage = { input: 9, output: 4 };
    const res = await adapter.complete(messages);
    expect(res.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
    expect(res.text).toBe("hi");
  });
});
