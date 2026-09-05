/**
 * `createPiLlmAdapter` — the ONE chokepoint a per-step model binding
 * reaches the LLM through.
 *
 * The load-bearing assertion in this file is the COMPATIBILITY one:
 * constructed with no override, the adapter must issue exactly the call it
 * always did — `complete(piModel, context, { apiKey })` via the RAW
 * entrypoint, with the caller's own provider/model and no sampling or
 * reasoning options bolted on. Everything else here is the new behaviour
 * that only switches on when an override is supplied.
 */
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { stubAssistantMessage } from "./helpers/mock-pi-ai";

interface RecordedCall {
  entry: "complete" | "completeSimple" | "stream" | "streamSimple";
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
  completeSimple: async (m: { id: string }, c: unknown, o: Record<string, unknown>) =>
    record("completeSimple")(m, c, o),
  stream: recordStream("stream"),
  streamSimple: recordStream("streamSimple"),
  getModel: () => ({ id: "test-model", provider: "anthropic" }),
  getModels: () => [],
  getProviders: () => ["anthropic"],
  getEnvApiKey: () => undefined,
}));

/** Every provider/model pair `resolveModel` was asked for. */
const resolveArgs: Array<[string | undefined, string | undefined]> = [];

/**
 * The `reasoning` flag the next `resolveModel` hands back on its `piModel`.
 *
 * `undefined` is the DEFAULT on purpose: it is the shape a synthesized
 * custom/local model has as far as this adapter is concerned (a resolved
 * model that will not apply an effort), so the effort-drop tests below get
 * the real-world case without opting into it.
 */
let resolvedReasoning: boolean | undefined;

mock.module("../providers/router", () => ({
  resolveModel: async (provider?: string, model?: string) => {
    resolveArgs.push([provider, model]);
    return {
      provider: provider ?? "router-provider",
      model: model ?? "router-model",
      piModel: { id: model ?? "router-model", reasoning: resolvedReasoning },
    };
  },
  suggestFallback: async () => null,
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ token: "sk-test", type: "apikey" }),
}));

const { createPiLlmAdapter } = await import("../runtime/executor-helpers");
const { configToAgent } = await import("../runtime/config-to-agent");

const messages = [{ role: "user" as const, content: "hello" }];

test("release authority is rechecked after model and credential waits before provider effects", async () => {
  for (const method of ["complete", "stream"] as const) {
    let checks = 0;
    const adapter = createPiLlmAdapter(undefined, undefined, { beforeCall: async () => {
      if (++checks === 2) throw new Error("release revoked during provider resolution");
    } });
    const pending = method === "complete" ? adapter.complete(messages) : (async () => { for await (const _event of adapter.stream(messages)) throw new Error("Unexpected provider output"); })();
    await expect(pending).rejects.toThrow("release revoked during provider resolution");
    expect(checks).toBe(2);
    expect(calls).toEqual([]);
  }
});

beforeEach(() => {
  calls.length = 0;
  resolveArgs.length = 0;
  resolvedReasoning = undefined;
});

describe("createPiLlmAdapter — no override (compatibility)", () => {
  test("complete() issues the historical raw call with only apiKey", async () => {
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { system: "s", provider: "anthropic", model: "agent-model" });

    expect(calls).toHaveLength(1);
    // RAW entrypoint, never the reasoning-normalizing *Simple one.
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

  test("effort routes through the *Simple entrypoint as `reasoning`", async () => {
    // Reasoning effort has no home on the raw options — each provider
    // spells it differently, and pi-ai's *Simple entrypoints are the
    // normalizer.
    const adapter = createPiLlmAdapter({ effort: "high", maxTokens: 100 });
    await adapter.complete(messages, {});
    expect(calls[0]!.entry).toBe("completeSimple");
    expect(calls[0]!.options).toEqual({ apiKey: "sk-test", maxTokens: 100, reasoning: "high" });
  });

  test("stream() honours the same override, including effort", async () => {
    const adapter = createPiLlmAdapter({ model: "gpt-5", temperature: 0.5, effort: "max" });
    for await (const _ of adapter.stream(messages, { model: "agent-model" })) {
      // drain
    }
    expect(calls[0]!.entry).toBe("streamSimple");
    expect(calls[0]!.options.reasoning).toBe("max");
    expect(calls[0]!.options.temperature).toBe(0.5);
    expect(resolveArgs).toEqual([[undefined, "gpt-5"]]);
  });

  test("stream() without effort stays on the raw entrypoint", async () => {
    const adapter = createPiLlmAdapter({ maxTokens: 42 });
    for await (const _ of adapter.stream(messages, {})) {
      // drain
    }
    expect(calls[0]!.entry).toBe("stream");
    expect(calls[0]!.options.maxTokens).toBe(42);
  });
});

/**
 * The agent's OWN sampling knobs.
 *
 * `AgentConfig.temperature` / `AgentConfig.maxTokens` are user-facing
 * config fields, and `configToAgent` has always put them on the per-call
 * options object. The adapter used to read sampling knobs ONLY off the
 * caller-level `overrides` binding, so the config fields were accepted,
 * type-checked (`AgentContext.llm` is `any`, so nothing complained) and
 * then silently dropped on the floor. A field that reads as functional
 * and isn't is worse than one that errors.
 *
 * The precedence rule these tests pin: an explicit caller-level override
 * (a workflow step's `model:` binding) still BEATS the agent's own ask —
 * that was already the documented contract for provider/model, and
 * sampling now follows the same rule instead of a different one.
 */
describe("createPiLlmAdapter — the agent's own sampling knobs", () => {
  test("an agent-level maxTokens reaches the provider with no override present", async () => {
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { model: "agent-model", maxTokens: 256 });
    expect(calls[0]!.options.maxTokens).toBe(256);
  });

  test("an agent-level temperature reaches the provider with no override present", async () => {
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { model: "agent-model", temperature: 0.2 });
    expect(calls[0]!.options.temperature).toBe(0.2);
  });

  test("an override BEATS the agent's own ask (same rule as provider/model)", async () => {
    const adapter = createPiLlmAdapter({ temperature: 0.9, maxTokens: 9000 });
    await adapter.complete(messages, { temperature: 0.1, maxTokens: 10 });
    expect(calls[0]!.options.temperature).toBe(0.9);
    expect(calls[0]!.options.maxTokens).toBe(9000);
  });

  test("a partial override leaves the agent's other knob alone", async () => {
    const adapter = createPiLlmAdapter({ maxTokens: 9000 });
    await adapter.complete(messages, { temperature: 0.1, maxTokens: 10 });
    expect(calls[0]!.options.maxTokens).toBe(9000);
    expect(calls[0]!.options.temperature).toBe(0.1);
  });

  test("stream() forwards the agent's knobs on the raw entrypoint too", async () => {
    const adapter = createPiLlmAdapter();
    for await (const _ of adapter.stream(messages, { maxTokens: 77, temperature: 0.3 })) {
      // drain
    }
    expect(calls[0]!.entry).toBe("stream");
    expect(calls[0]!.options.maxTokens).toBe(77);
    expect(calls[0]!.options.temperature).toBe(0.3);
  });

  test("a caller that asks for NOTHING still gets the byte-identical `{apiKey}` call", async () => {
    // The compatibility floor: forwarding must not start emitting
    // `temperature: undefined` keys onto the wire for agents that set none.
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { system: "s" });
    expect(Object.keys(calls[0]!.options)).toEqual(["apiKey"]);
  });

  test("temperature 0 is a real value, not an absent one", async () => {
    // `0` is the one falsy temperature a user can legitimately mean.
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, { temperature: 0 });
    expect(calls[0]!.options.temperature).toBe(0);
  });

  test("a YAML-shaped null/garbage knob is treated as absent, never shipped", async () => {
    // `yaml-loader.ts` `parse()`s an untrusted *.agent.yaml and casts
    // straight to AgentConfig with no validation, so `maxTokens: ~` and
    // `temperature: "warm"` reach the adapter wearing a `number` type they
    // do not have. Before forwarding existed they were inert; they must
    // stay inert rather than go on the wire as null/"warm".
    const adapter = createPiLlmAdapter();
    await adapter.complete(messages, {
      maxTokens: null as unknown as number,
      temperature: "warm" as unknown as number,
    });
    expect(Object.keys(calls[0]!.options)).toEqual(["apiKey"]);
  });

  test("a NaN knob is skipped and the next candidate wins", async () => {
    const adapter = createPiLlmAdapter({ maxTokens: Number.NaN });
    await adapter.complete(messages, { maxTokens: 500 });
    expect(calls[0]!.options.maxTokens).toBe(500);
  });

  test("end-to-end: an AgentConfig's maxTokens/temperature actually reach pi-ai", async () => {
    // The whole point — through the real `configToAgent`, not a hand-built
    // options object. This is the path a user setting `maxTokens:` in agent
    // config actually takes.
    const agent = configToAgent({
      name: "a",
      description: "d",
      capabilities: ["llm"],
      prompt: "p",
      temperature: 0.42,
      maxTokens: 1234,
    });
    const result = await agent.execute({
      input: { q: "hi" },
      llm: createPiLlmAdapter(),
      shell: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
      file: { read: async () => "", write: async () => {}, exists: async () => false },
      log: () => {},
      signal: new AbortController().signal,
      run: async () => ({ success: true, output: null }),
    } as unknown as Parameters<typeof agent.execute>[0]);

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.maxTokens).toBe(1234);
    expect(calls[0]!.options.temperature).toBe(0.42);
  });
});

/**
 * The effort no-op, made audible.
 *
 * A step's `model: { effort }` on a local/custom model was pure silence: the
 * model resolves with `reasoning: false`, pi-ai clamps the level to "off" and
 * drops the field before serializing, and NOTHING — not the request, not the
 * response, not an error — said the step did not get what it asked for.
 *
 * These tests pin the two halves that make the notice trustworthy: it fires
 * on the RESOLVED model (never on the binding, which cannot know), and it
 * never fires when the effort actually lands.
 */
describe("createPiLlmAdapter — a dropped effort is reported", () => {
  test("complete() reports an effort the resolved model will not apply", async () => {
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ effort: "high" }, (m) => seen.push(m));
    await adapter.complete(messages, { provider: "ollama", model: "qwen3:1.7b" });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('"high"');
    expect(seen[0]).toContain("ollama/qwen3:1.7b");
    // The call still HAPPENS, and still carries the effort pi-ai will drop —
    // reporting the no-op must not change what is requested.
    expect(calls[0]!.entry).toBe("completeSimple");
    expect(calls[0]!.options.reasoning).toBe("high");
  });

  test("stream() reports it on the same terms", async () => {
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ effort: "max" }, (m) => seen.push(m));
    for await (const _ of adapter.stream(messages, { provider: "ollama", model: "local" })) {
      // drain
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("ollama/local");
    expect(calls[0]!.entry).toBe("streamSimple");
  });

  test("says NOTHING when the resolved model honours the effort", async () => {
    resolvedReasoning = true;
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ effort: "high" }, (m) => seen.push(m));
    await adapter.complete(messages, { provider: "anthropic", model: "claude-opus-5" });
    expect(seen).toEqual([]);
  });

  test("says nothing when no effort was asked for", async () => {
    // A non-reasoning model is the NORM. Warning about every call that did
    // not request an effort would bury the one case that matters.
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ maxTokens: 10 }, (m) => seen.push(m));
    await adapter.complete(messages, { provider: "ollama", model: "qwen3:1.7b" });
    expect(seen).toEqual([]);
  });

  test("reports the RESOLVED model, not the one the caller asked for", async () => {
    // The binding cannot answer this — only the object the call is about to
    // ship can. A caller-side answer would be a second opinion that could
    // disagree with the request actually made.
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ effort: "low", model: "override-model" }, (m) =>
      seen.push(m),
    );
    await adapter.complete(messages, { provider: "ollama", model: "caller-model" });
    expect(seen[0]).toContain("override-model");
    expect(seen[0]).not.toContain("caller-model");
  });

  test("repeats once per DISTINCT model, not once per call", async () => {
    // A code-based agent may call `complete` in a loop; the same sentence a
    // hundred times is how a true warning becomes noise. But a caller that
    // varies its model drops the effort separately each time, and each of
    // those is its own fact.
    const seen: string[] = [];
    const adapter = createPiLlmAdapter({ effort: "high" }, (m) => seen.push(m));
    await adapter.complete(messages, { provider: "ollama", model: "a" });
    await adapter.complete(messages, { provider: "ollama", model: "a" });
    for await (const _ of adapter.stream(messages, { provider: "ollama", model: "a" })) {
      // drain — the stream path shares the dedup set with complete()
    }
    expect(seen).toHaveLength(1);

    await adapter.complete(messages, { provider: "ollama", model: "b" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain("ollama/b");
  });

  test("with no sink supplied the call is byte-identical to before", async () => {
    // Every existing caller passes one argument. The notice must be additive.
    const adapter = createPiLlmAdapter({ effort: "high" });
    await adapter.complete(messages, { provider: "ollama", model: "qwen3:1.7b" });
    expect(calls[0]!.entry).toBe("completeSimple");
    expect(calls[0]!.options).toEqual({ apiKey: "sk-test", reasoning: "high" });
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
