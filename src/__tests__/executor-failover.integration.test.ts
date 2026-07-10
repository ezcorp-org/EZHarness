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
// Tier the executor passed to suggestFallback on each failover lookup —
// proves a pinned powerful-tier model fails over IN-tier (not "balanced").
let suggestFallbackTiers: string[] = [];
let resolveModelCalls: string[] = [];

function piModelFor(provider: string, id = `${provider}-model`) {
  return {
    id,
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
  // A pinned modelId is honored so the REAL tierForModel sees the pin's id.
  resolveModel: async (provider?: string, modelId?: string) => {
    const p = provider === "prov-ok" ? "prov-ok" : "prov-fail";
    resolveModelCalls.push(p);
    const model = modelId ?? `${p}-model`;
    return { provider: p, model, piModel: piModelFor(p, model) };
  },
  suggestFallback: async (_failedProvider: string, tier: string) => {
    suggestFallbackCalls++;
    suggestFallbackTiers.push(tier);
    return suggestFallbackResult;
  },
  getDefaultTier: async () => "balanced",
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
  // Full model shape — the pinned-turn path reaches the REAL registry
  // (model-capabilities → resolveModelObject → getModel) which reads
  // `model.input`, so a bare {id, provider} stub would throw there.
  getModel: (provider?: string, modelId?: string) =>
    piModelFor(provider ?? "prov-fail", modelId ?? undefined),
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
import { createConversation, getMessages } from "../db/queries/conversations";
import { resetAllCircuitBreakers, getCircuitBreaker } from "../providers/circuit-breaker";

/** Fetch the single persisted assistant row for a conversation. */
async function getAssistantRow(convId: string) {
  const msgs = await getMessages(convId);
  const assistant = msgs.find((m) => m.role === "assistant");
  expect(assistant).toBeDefined();
  return assistant!;
}

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
  suggestFallbackTiers = [];
  resolveModelCalls = [];
  resetAllCircuitBreakers();
});

describe("AgentExecutor.streamChat — pre-stream provider failover", () => {
  test("pre-first-token provider failure → rebuilds on fallback, fallback serves the turn", async () => {
    suggestFallbackResult = { provider: "prov-ok", model: "prov-ok-model", tier: "balanced" };
    const conv = await createConversation(projectId, { title: "Failover Success" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await executor.streamChat(conv.id, "hello", {});

    // The turn completed — served by the FALLBACK provider, not the failed one.
    expect(run.status).toBe("success");
    expect((run.result?.output as { fullText?: string })?.fullText).toBe("served by fallback");
    // Failover actually fired: one fallback lookup + a rebuild on prov-ok.
    expect(suggestFallbackCalls).toBe(1);
    expect(resolveModelCalls).toEqual(["prov-fail", "prov-ok"]);
    // The circuit breaker recorded the prov-fail failure (prod wiring live).
    expect(getCircuitBreaker("prov-fail")).toBeDefined();

    // The persisted assistant row names the model that SERVED the turn (the
    // fallback), with truthful provenance: no user pin (Auto/routed turn),
    // the classifier's tier, and the failover flag set.
    const assistant = await getAssistantRow(conv.id);
    expect(assistant.provider).toBe("prov-ok");
    expect(assistant.model).toBe("prov-ok-model");
    expect(assistant.usage?.failover).toBe(true);
    expect(assistant.usage?.requestedProvider).toBeNull();
    expect(assistant.usage?.requestedModel).toBeNull();
    // Unpinned short tool-less turn → the classifier routed "fast".
    expect(assistant.usage?.routedTier).toBe("fast");
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

  test("routed initial attempt succeeds → row persists the SERVED provider/model + routedTier (not undefined)", async () => {
    // No pinned model → routing fires (classifier picks a tier). The INITIAL
    // attempt serves the turn (provider-only hint resolves to the healthy
    // "prov-ok"), so no failover is involved — this is exactly the path that
    // used to persist undefined provider/model and meter as "unknown".
    const conv = await createConversation(projectId, { title: "Routed Success" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await executor.streamChat(conv.id, "hello", { provider: "prov-ok" });

    expect(run.status).toBe("success");
    // Initial attempt served — the failover loop never consulted the router.
    expect(suggestFallbackCalls).toBe(0);
    expect(resolveModelCalls).toEqual(["prov-ok"]);

    const assistant = await getAssistantRow(conv.id);
    // SERVED identity persisted on the row columns — NOT undefined/null.
    expect(assistant.provider).toBe("prov-ok");
    expect(assistant.model).toBe("prov-ok-model");
    // Provenance: provider hint recorded, no model pin (routed turn), the
    // classifier's tier (short tool-less prompt → "fast"), no failover.
    expect(assistant.usage?.requestedProvider).toBe("prov-ok");
    expect(assistant.usage?.requestedModel).toBeNull();
    expect(assistant.usage?.routedTier).toBe("fast");
    expect(assistant.usage?.failover).toBe(false);
  });

  test("pinned powerful-tier model 429s pre-token → failover searches the PINNED tier, not 'balanced'", async () => {
    // Pin a model whose id infers "powerful" (real tierForModel heuristic).
    // The pinned provider 429s before the first token; the fallback lookup
    // must ask the router for a POWERFUL-tier peer — the old hardcode passed
    // "balanced" and silently downgraded pinned-Opus-class turns.
    suggestFallbackResult = { provider: "prov-ok", model: "prov-ok-model", tier: "powerful" };
    const conv = await createConversation(projectId, { title: "Pinned Powerful Failover" });
    const bus = new EventBus<AgentEvents>();
    const executor = new AgentExecutor(new Map(), bus, { persist: true });

    const run = await executor.streamChat(conv.id, "hello", {
      provider: "prov-fail",
      model: "prov-fail-opus",
    });

    expect(run.status).toBe("success");
    // THE defect assertion: the tier handed to suggestFallback is the pinned
    // model's own tier.
    expect(suggestFallbackTiers).toEqual(["powerful"]);

    const assistant = await getAssistantRow(conv.id);
    // Served by the fallback; the pin is preserved as provenance.
    expect(assistant.provider).toBe("prov-ok");
    expect(assistant.model).toBe("prov-ok-model");
    expect(assistant.usage?.requestedProvider).toBe("prov-fail");
    expect(assistant.usage?.requestedModel).toBe("prov-fail-opus");
    expect(assistant.usage?.failover).toBe(true);
    // Pinned turn → routing never fired → no routedTier written.
    expect(assistant.usage?.routedTier).toBeUndefined();
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
