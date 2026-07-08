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
