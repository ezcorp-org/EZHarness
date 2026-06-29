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
    const compaction = { safetyFraction: 0, responseReserveFloor: 0, responseReserveCap: 0 };
    build(piModel, compaction);

    const budget = computeInputBudget(piModel, { ...DEFAULTS, ...compaction });
    const turns = Array.from({ length: 40 }, (_, i) => userMsg("q".repeat(400) + i));
    const out = await capturedOpts.transformContext(turns);

    expect(out.length).toBeLessThan(turns.length);
    expect(isCompactionMarker(out[0])).toBe(true);
    expect(estimateTokens(out)).toBeLessThanOrEqual(budget);
    // Model still untouched after the transform ran.
    const agentModel = (build(piModel, compaction) as any).state.model;
    expect(agentModel.maxTokens).toBe(128_000);
  });
});
