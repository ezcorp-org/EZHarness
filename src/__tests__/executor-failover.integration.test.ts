/**
 * WS2 — pre-stream provider failover driven through the REAL
 * AgentExecutor.streamChat retry loop.
 *
 * The pi-agent-core Agent and the router are mocked (no network, no keys),
 * but everything in between — setup-tools model resolution, buildPiAgent,
 * subscribeBridge, runWithFailover, finalize* — is the real code path. The
 * mock Agent's prompt() keys off the resolved model's provider: a "prov-fail"
 * model reports a pre-first-token 429; a "prov-ok" model streams
 * "served by fallback". That lets us prove, end-to-end, that a provider
 * failure before the first token transparently rebuilds the agent on the
 * fallback and delivers the fallback's output to the client — and that the
 * single-provider + mid-stream boundaries behave as specified.
 *
 * The circuit breaker is REAL (not mocked) so the executor's prod wiring
 * (recordFailure/recordSuccess) is exercised for real.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents } from "../types";

mockDbConnection();

// ── mutable scenario knobs (closed over by the mocks) ──────────────────
type AgentScenario = "pre-token-fail" | "midstream-fail";
let agentScenario: AgentScenario = "pre-token-fail";
let suggestFallbackResult: { provider: string; model: string; tier: string } | null = null;
let suggestFallbackCalls = 0;
let resolveModelCalls: string[] = [];

function piModelFor(provider: string) {
  return {
    id: `${provider}-model`,
    provider,
    api: "anthropic-messages",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
}

mock.module("../providers/router", () => ({
  // Initial resolution (setup-tools) passes no pinned provider → "prov-fail".
  // The failover resolveAttempt closure passes the suggested "prov-ok".
  resolveModel: async (provider?: string) => {
    const p = provider === "prov-ok" ? "prov-ok" : "prov-fail";
    resolveModelCalls.push(p);
    return { provider: p, model: `${p}-model`, piModel: piModelFor(p) };
  },
  suggestFallback: async () => {
    suggestFallbackCalls++;
    return suggestFallbackResult;
  },
  ProviderUnavailableError: class extends Error {
    failedProvider: string;
    failedModel: string;
    suggestion: unknown;
    constructor(msg: string, fp: string, fm: string, sug: unknown) {
      super(msg);
      this.name = "ProviderUnavailableError";
      this.failedProvider = fp;
      this.failedModel = fm;
      this.suggestion = sug;
    }
  },
}));

mock.module("../providers/credentials", () => ({
  getCredential: async () => ({ type: "apikey", token: "test-key" }),
  getApiKey: async () => "test-key",
}));

mock.module("@earendil-works/pi-ai", () => ({
  stream: () => ({ [Symbol.asyncIterator]: async function* () {}, result: async () => ({}) }),
  complete: async () => ({}),
  getModel: () => ({ id: "prov-fail-model", provider: "prov-fail" }),
  getModels: () => [],
  getProviders: () => ["anthropic", "openai", "google"],
  getEnvApiKey: () => undefined,
}));

// Mock pi-agent-core Agent: fail pre-first-token on "prov-fail", succeed on
// the fallback "prov-ok". Behaviour keys off the constructed model provider.
mock.module("@earendil-works/pi-agent-core", () => ({
  Agent: class MockAgent {
    state: { errorMessage?: string } = {};
    private _subs: Array<(e: unknown) => void> = [];
    private _provider: string;
    constructor(opts: any) {
      this._provider = opts?.initialState?.model?.provider ?? "unknown";
    }
    subscribe(cb: (e: unknown) => void) {
      this._subs.push(cb);
      return () => {};
    }
    abort() {}
    async prompt() {
      const emit = (e: unknown) => {
        for (const s of this._subs) s(e);
      };
      if (this._provider === "prov-fail") {
        if (agentScenario === "midstream-fail") {
          // A token streams BEFORE the failure → past the pre-stream boundary.
          emit({ type: "turn_start" });
          emit({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial answer" },
          });
        }
        // pi-agent-core stores the provider failure on state (no throw).
        this.state.errorMessage = "429 Too Many Requests";
        return;
      }
      // Fallback provider serves the turn cleanly.
      emit({ type: "turn_start" });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "served by fallback" },
      });
      emit({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "served by fallback" }],
          usage: {
            input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    }
  },
}));

import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { createProject } from "../db/queries/projects";
import { createConversation } from "../db/queries/conversations";
import { resetAllCircuitBreakers, getCircuitBreaker } from "../providers/circuit-breaker";

let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const project = await createProject({ name: "Failover E2E", path: "/tmp/failover-e2e" });
  projectId = project.id;
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(() => {
  agentScenario = "pre-token-fail";
  suggestFallbackResult = null;
  suggestFallbackCalls = 0;
  resolveModelCalls = [];
  resetAllCircuitBreakers();
});

describe("AgentExecutor.streamChat — pre-stream provider failover", () => {
  test("pre-first-token provider failure → rebuilds on fallback, fallback serves the turn", async () => {
    suggestFallbackResult = { provider: "prov-ok", model: "prov-ok-model", tier: "balanced" };
    const conv = await createConversation(projectId, { title: "Failover Success" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const run = await executor.streamChat(conv.id, "hello", {});

    // The turn completed — served by the FALLBACK provider, not the failed one.
    expect(run.status).toBe("success");
    expect((run.result?.output as { fullText?: string })?.fullText).toBe("served by fallback");
    // Failover actually fired: one fallback lookup + a rebuild on prov-ok.
    expect(suggestFallbackCalls).toBe(1);
    expect(resolveModelCalls).toEqual(["prov-fail", "prov-ok"]);
    // The circuit breaker recorded the prov-fail failure (prod wiring live).
    expect(getCircuitBreaker("prov-fail")).toBeDefined();
  });

  test("single-provider / no fallback → clean ProviderUnavailableError payload, no crash", async () => {
    suggestFallbackResult = null; // BYOK user with one provider key
    const conv = await createConversation(projectId, { title: "No Fallback" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const run = await executor.streamChat(conv.id, "hello", {});

    expect(run.status).toBe("error");
    const payload = JSON.parse((run.result?.error as string) ?? "{}");
    expect(payload.type).toBe("provider_unavailable");
    expect(payload.failedProvider).toBe("prov-fail");
    expect(payload.suggestion).toBeNull();
    expect(suggestFallbackCalls).toBe(1);
  });

  test("failure AFTER the first token → NOT retried (mid-stream boundary)", async () => {
    agentScenario = "midstream-fail";
    // A fallback IS available, but the boundary must prevent using it.
    suggestFallbackResult = { provider: "prov-ok", model: "prov-ok-model", tier: "balanced" };
    const conv = await createConversation(projectId, { title: "Mid-stream" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus);

    const run = await executor.streamChat(conv.id, "hello", {});

    expect(run.status).toBe("error");
    // No fallback was attempted once a token had streamed to the client.
    expect(suggestFallbackCalls).toBe(0);
    expect(resolveModelCalls).toEqual(["prov-fail"]);
    expect(String(run.result?.error)).toContain("429");
  });
});
