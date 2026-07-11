/**
 * Integration test: `buildPiAgent` wires per-model history compaction
 * via pi-agent-core's `transformContext` hook WITHOUT mutating the
 * resolved model (input-only — Codex sends no output cap; shrinking
 * `maxTokens` would regress other providers).
 *
 * The `@earendil-works/pi-agent-core` `Agent` is stubbed to capture the
 * constructor options so we can assert on `initialState.model` and
 * invoke the wired `transformContext` directly (no real LLM call).
 */
import { test, expect, describe, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

let capturedOpts: any;

mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state: any;
    constructor(opts: any) {
      capturedOpts = opts;
      this.state = { ...(opts.initialState ?? {}) };
    }
  },
}));

// Import AFTER the mock registers so build-pi-agent binds the stub.
const { buildPiAgent } = await import("../runtime/stream-chat/build-pi-agent");
const { estimateTokens, computeInputBudget, isCompactionMarker, DEFAULTS } =
  await import("../runtime/stream-chat/context-compaction");

const userMsg = (text: string): any => ({ role: "user", content: text, timestamp: 1 });

function build(piModel: any, compaction: any) {
  const ctx = { system: "sys", agentTools: [] } as any;
  const resolvedModel = {
    resolved: { provider: "openai", model: piModel.id, piModel },
    initialCred: { type: "api-key", token: "k" },
  } as any;
  return buildPiAgent(ctx, [], { compaction } as any, resolvedModel, "conv-1");
}

/** Build with an explicit memory tail (the system-block cache split path). */
function buildWithTail(piModel: any, systemMemoryTail: string | undefined) {
  const ctx = { system: "frozen base", systemMemoryTail, agentTools: [] } as any;
  const resolvedModel = {
    resolved: { provider: piModel.provider ?? "openai", model: piModel.id, piModel },
    initialCred: { type: "api-key", token: "k" },
  } as any;
  return buildPiAgent(ctx, [], {} as any, resolvedModel, "conv-1");
}

const anthropicModel = () => ({
  id: "claude-sonnet",
  provider: "anthropic",
  api: "anthropic-messages",
  contextWindow: 200_000,
  maxTokens: 8_000,
});

/**
 * Mirror pi-ai's `buildParams` (providers/anthropic.js) for the non-OAuth
 * case: ONE system block built from `initialState.systemPrompt`, carrying a
 * cache_control breakpoint, plus tools (last one marked) and a last-message
 * tail mark.
 */
const anthropicWireFromSystemPrompt = (systemPrompt: string) => ({
  system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
  tools: [
    { name: "a" },
    { name: "b", cache_control: { type: "ephemeral" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] },
  ],
});

describe("buildPiAgent + compaction", () => {
  test("does NOT mutate the resolved model", () => {
    const piModel = { id: "gpt-5.5", contextWindow: 272_000, maxTokens: 128_000 };
    const agent = build(piModel, undefined) as any;
    expect(agent.state.model.maxTokens).toBe(128_000);
    expect(agent.state.model.contextWindow).toBe(272_000);
    expect(piModel.maxTokens).toBe(128_000);
  });

  test("wires a transformContext function", () => {
    const piModel = { id: "gpt-5.5", contextWindow: 272_000, maxTokens: 128_000 };
    build(piModel, undefined);
    expect(typeof capturedOpts.transformContext).toBe("function");
  });

  test("pins maxRetryDelayMs to pi's documented 60s default (failover timing stability)", () => {
    // We pin the value so an upstream change to pi-ai's default retry-delay
    // cap can't silently shift when WS2 pre-stream failover takes over.
    const piModel = { id: "gpt-5.5", contextWindow: 272_000, maxTokens: 128_000 };
    build(piModel, undefined);
    expect(capturedOpts.maxRetryDelayMs).toBe(60_000);
  });

  test("wired transformContext leaves a short history untouched", async () => {
    const piModel = { id: "gpt-5.5", contextWindow: 272_000, maxTokens: 128_000 };
    build(piModel, undefined);
    const msgs = [userMsg("hello"), userMsg("world")];
    expect(await capturedOpts.transformContext(msgs)).toBe(msgs);
  });

  test("wired transformContext trims a long history below budget + marks it", async () => {
    const piModel = { id: "small", contextWindow: 1_000, maxTokens: 128_000 };
    // Anchor is opt-in (default 0); this test exercises the anchor layout.
    const compaction = { safetyFraction: 0, responseReserveFloor: 0, responseReserveCap: 0, cacheAnchorFraction: 0.5 };
    build(piModel, compaction);

    const budget = computeInputBudget(piModel, { ...DEFAULTS, ...compaction });
    const turns = Array.from({ length: 40 }, (_, i) => userMsg("q".repeat(400) + i));
    const out = await capturedOpts.transformContext(turns);

    expect(out.length).toBeLessThan(turns.length);
    // Cache-stable prefix: the oldest turn leads, marker is relocated after it.
    expect(isCompactionMarker(out[0])).toBe(false);
    expect(out[0]).toBe(turns[0]);
    expect(out.some(isCompactionMarker)).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
    // Model still untouched after the transform ran.
    const agentModel = (build(piModel, compaction) as any).state.model;
    expect(agentModel.maxTokens).toBe(128_000);
  });
});

describe("buildPiAgent + cache retention (onPayload)", () => {
  const anthropicPayload = () => ({
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    tools: [
      { name: "a" },
      { name: "b", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
      },
    ],
  });

  test("default retention (long) → 1h TTL on the stable prefix, tail stays short", async () => {
    build({ id: "claude", contextWindow: 200_000, maxTokens: 8_000 }, undefined);
    const payload = anthropicPayload();
    const out = (await capturedOpts.onPayload(payload)) as any;
    // system prompt + LAST tool = the stable prefix → 1h.
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // Conversation tail (last message block) is left short (5m).
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("preserves the existing reasoning-summary detail behavior + no-ops non-Anthropic", async () => {
    build({ id: "gpt", contextWindow: 200_000, maxTokens: 8_000 }, undefined);
    const body: any = { reasoning: { summary: "auto" } };
    const out = await capturedOpts.onPayload(body);
    expect(body.reasoning.summary).toBe("detailed");
    // A payload with no cache_control blocks is returned untouched.
    expect(out).toBe(body);
  });
});

describe("buildPiAgent + system-block cache split (memory tail)", () => {
  test("SHIPPED DEFAULTS: region-1 system block is byte-stable across turns with DIFFERENT memory tails", async () => {
    // Two consecutive turns of the same conversation; per-turn recall
    // injects a DIFFERENT memory/KB block each time (query-dependent).
    // Pre-fix this re-wrote the system prompt and busted the region-1
    // cache every memory turn.
    buildWithTail(anthropicModel(), "\n\n## Relevant Memories\n- [a] turn one recall");
    // Anthropic path: the frozen prompt EXCLUDES the tail.
    expect(capturedOpts.initialState.systemPrompt).toBe("frozen base");
    const wire1 = anthropicWireFromSystemPrompt(capturedOpts.initialState.systemPrompt);
    const out1 = (await capturedOpts.onPayload(wire1)) as any;

    buildWithTail(anthropicModel(), "\n\n## Relevant Memories\n- [b] a totally different recall");
    expect(capturedOpts.initialState.systemPrompt).toBe("frozen base");
    const wire2 = anthropicWireFromSystemPrompt(capturedOpts.initialState.systemPrompt);
    const out2 = (await capturedOpts.onPayload(wire2)) as any;

    // Frozen block: byte-identical across the two turns AND carrying the
    // shipped default retention (cache_control ttl "1h").
    expect(JSON.stringify(out1.system[0])).toBe(JSON.stringify(out2.system[0]));
    expect(out1.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    // Memory block: LAST, varies per turn, carries NO cache_control.
    expect(out1.system).toHaveLength(2);
    expect(out2.system).toHaveLength(2);
    expect(out1.system[1].text).toContain("turn one recall");
    expect(out2.system[1].text).toContain("a totally different recall");
    expect(out1.system[1].text).not.toBe(out2.system[1].text);
    expect("cache_control" in out1.system[1]).toBe(false);
    expect("cache_control" in out2.system[1]).toBe(false);

    // Tools prefix keeps its 1h mark; conversation tail stays short.
    expect(out1.tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out1.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("OAuth-mode payload keeps exactly 2 system breakpoints: [identity, frozen, memory]", async () => {
    buildWithTail(anthropicModel(), "\n\n## Relevant Memories\n- [c] oauth recall");
    // pi-ai's OAuth buildParams shape: identity + frozen prompt, each with
    // a cache_control breakpoint.
    const oauthWire: any = {
      system: [
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "frozen base", cache_control: { type: "ephemeral" } },
      ],
    };
    const out = (await capturedOpts.onPayload(oauthWire)) as any;

    expect(out.system).toHaveLength(3);
    expect(out.system[2].text).toContain("oauth recall");
    // The memory block adds CONTENT, never a breakpoint: still exactly 2.
    const breakpoints = out.system.filter((b: any) => b.cache_control);
    expect(breakpoints).toHaveLength(2);
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(out.system[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("Anthropic with NO tail: system untouched, single frozen block", async () => {
    buildWithTail(anthropicModel(), undefined);
    expect(capturedOpts.initialState.systemPrompt).toBe("frozen base");
    const wire = anthropicWireFromSystemPrompt("frozen base");
    const out = (await capturedOpts.onPayload(wire)) as any;
    expect(out.system).toHaveLength(1);
    expect(out.system[0].text).toBe("frozen base");
  });

  test("non-Anthropic: tail merged into systemPrompt; onPayload leaves body.system untouched", async () => {
    const tail = "\n\n## Relevant Memories\n- [d] non-anthropic recall";
    buildWithTail({ id: "gpt-5.5", provider: "openai", api: "openai-responses", contextWindow: 272_000, maxTokens: 128_000 }, tail);

    // Memory is NOT dropped: it rides the plain systemPrompt string.
    expect(capturedOpts.initialState.systemPrompt).toBe(`frozen base${tail}`);

    // onPayload is a strict wire no-op for the system field.
    const body: any = { system: "provider-built system", input: [] };
    const bytes = JSON.stringify(body);
    const out = await capturedOpts.onPayload(body);
    expect(out).toBe(body);
    expect(JSON.stringify(body)).toBe(bytes);
  });
});
