/**
 * Unit tests for WS2 pre-stream provider failover (src/runtime/stream-chat/
 * failover.ts). Drives the REAL retry loop with injected seams (fake agents,
 * fake buildAgent/subscribe/runPrompt/suggestFallback/resolveAttempt) so the
 * loop's decisions — record failure, pick a fallback, rebuild, retry, honor
 * the pre-first-token boundary, and degrade gracefully with no fallback — are
 * asserted deterministically without a network or DB. The circuit-breaker is
 * REAL (not mocked) so "failure recorded → breaker opens after threshold" is
 * proven end-to-end.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  runWithFailover,
  classifyProviderAvailabilityError,
  MAX_FAILOVER_ATTEMPTS,
  type FailoverAttempt,
  type RunWithFailoverParams,
} from "../runtime/stream-chat/failover";
import { ProviderUnavailableError } from "../providers/router";
import { getCircuitBreaker, resetAllCircuitBreakers } from "../providers/circuit-breaker";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";

// ── fixtures ─────────────────────────────────────────────────────────
function makeCtx(): StreamChatContext {
  return {
    run: { id: "run-1" },
    unsub: undefined,
    allTurnsText: "",
    turnText: "",
    emittedToClient: false,
  } as unknown as StreamChatContext;
}

function makeHost(): StreamChatHost {
  return { activeAgents: new Map() } as unknown as StreamChatHost;
}

function makeAttempt(provider: string, model = `${provider}-model`): FailoverAttempt {
  return {
    provider,
    model,
    resolved: {
      resolved: { provider, model, piModel: { id: model, provider } },
      initialCred: { type: "apikey", token: "t" },
    },
  } as unknown as FailoverAttempt;
}

function makeAgent(errorMessage?: string): Agent {
  return { state: errorMessage ? { errorMessage } : {} } as unknown as Agent;
}

/** Build a params object with sane no-op seams, overridable per test. */
function baseParams(
  ctx: StreamChatContext,
  host: StreamChatHost,
  over: Partial<RunWithFailoverParams>,
): RunWithFailoverParams {
  return {
    ctx,
    host,
    runId: "run-1",
    tier: "balanced",
    initial: makeAttempt("p1"),
    buildAgent: () => makeAgent(),
    subscribe: () => {},
    runPrompt: async () => {},
    suggestFallback: async () => null,
    resolveAttempt: async (s) => makeAttempt(s.provider, s.model),
    ...over,
  };
}

beforeEach(() => resetAllCircuitBreakers());

// ── classifier ───────────────────────────────────────────────────────
describe("classifyProviderAvailabilityError", () => {
  test("undefined / null / empty → not an availability failure", () => {
    expect(classifyProviderAvailabilityError(undefined)).toBe(false);
    expect(classifyProviderAvailabilityError(null)).toBe(false);
    expect(classifyProviderAvailabilityError("")).toBe(false);
  });

  test("429 rate-limit → availability failure", () => {
    expect(classifyProviderAvailabilityError("HTTP 429 Too Many Requests")).toBe(true);
  });

  test("5xx server errors → availability failure", () => {
    expect(classifyProviderAvailabilityError("500 Internal Server Error")).toBe(true);
    expect(classifyProviderAvailabilityError("upstream returned 503")).toBe(true);
    expect(classifyProviderAvailabilityError("529 overloaded")).toBe(true);
  });

  test("connection-class signature → availability failure", () => {
    expect(classifyProviderAvailabilityError("fetch failed: ECONNREFUSED")).toBe(true);
  });

  test("normal 4xx / other error → NOT an availability failure", () => {
    expect(classifyProviderAvailabilityError("400 Bad Request: invalid schema")).toBe(false);
    expect(classifyProviderAvailabilityError("401 Unauthorized")).toBe(false);
    expect(classifyProviderAvailabilityError("tool crashed")).toBe(false);
  });
});

// ── runWithFailover ──────────────────────────────────────────────────
describe("runWithFailover", () => {
  test("initial success → served, no fallback lookup, breaker closed", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const a1 = makeAgent();
    const built: string[] = [];
    let suggestCalls = 0;

    await runWithFailover(
      baseParams(ctx, host, {
        buildAgent: (r) => {
          built.push((r as { resolved: { provider: string } }).resolved.provider);
          return a1;
        },
        runPrompt: async () => {
          ctx.allTurnsText = "hello from p1";
          ctx.emittedToClient = true;
        },
        suggestFallback: async () => {
          suggestCalls++;
          return null;
        },
      }),
    );

    expect(built).toEqual(["p1"]);
    expect(suggestCalls).toBe(0);
    expect(host.activeAgents.get("run-1")).toBe(a1);
    expect(ctx.allTurnsText).toBe("hello from p1");
    expect(getCircuitBreaker("p1").isOpen()).toBe(false);
  });

  test("pre-first-token failure → fallback selected, agent rebuilt, fallback serves the turn", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const a1 = makeAgent("429 rate limited"); // fails pre-token
    const a2 = makeAgent(); // fallback succeeds
    const built: string[] = [];
    const unsubbed: number[] = [];
    let suggestCalls = 0;

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: (r) => {
          const p = (r as { resolved: { provider: string } }).resolved.provider;
          built.push(p);
          return p === "p1" ? a1 : a2;
        },
        subscribe: (_agent, attempt) => {
          // real subscribeBridge assigns ctx.unsub; emulate so the retry's
          // detach path (ctx.unsub?.()) is exercised.
          ctx.unsub = () => unsubbed.push(1);
        },
        runPrompt: async (agent) => {
          if (agent === a2) {
            ctx.allTurnsText = "served by fallback";
            ctx.emittedToClient = true;
          }
          // a1 fails pre-token: nothing streams (errorMessage already set).
        },
        suggestFallback: async (failed, tier) => {
          suggestCalls++;
          expect(failed).toBe("p1");
          expect(tier).toBe("balanced");
          return { provider: "p2", model: "p2-model", tier };
        },
      }),
    );

    // Failover actually fired: it rebuilt on the fallback provider…
    expect(built).toEqual(["p1", "p2"]);
    expect(suggestCalls).toBe(1);
    // …the previous attempt's subscription was detached before the retry…
    expect(unsubbed).toEqual([1]);
    // …and the FALLBACK's output is what the client receives.
    expect(ctx.allTurnsText).toBe("served by fallback");
    expect(host.activeAgents.get("run-1")).toBe(a2);
    // Breaker: p1 has one failure (not yet open), p2 recorded success.
    expect(getCircuitBreaker("p1").isOpen()).toBe(false);
    expect(getCircuitBreaker("p2").isOpen()).toBe(false);
  });

  test("single-provider / no fallback → clean ProviderUnavailableError (no crash)", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    let suggestCalls = 0;

    const promise = runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("solo"),
        buildAgent: () => makeAgent("503 Service Unavailable"),
        suggestFallback: async () => {
          suggestCalls++;
          return null; // BYOK user with a single provider key
        },
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
    const err = await promise.catch((e) => e);
    expect(err.failedProvider).toBe("solo");
    expect(err.failedModel).toBe("solo-model");
    expect(err.suggestion).toBeNull();
    expect(suggestCalls).toBe(1);
  });

  test("fallback loops back to an already-tried provider → ProviderUnavailableError", async () => {
    const ctx = makeCtx();
    const host = makeHost();

    const promise = runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: () => makeAgent("500 server error"),
        // Suggest the SAME provider we started on → nothing new to try.
        suggestFallback: async () => ({ provider: "p1", model: "p1-model", tier: "balanced" }),
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  test("failure AFTER first token → NOT retried (mid-stream boundary)", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    let suggestCalls = 0;
    const built: string[] = [];

    const promise = runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: (r) => {
          built.push((r as { resolved: { provider: string } }).resolved.provider);
          return makeAgent("429 mid stream");
        },
        runPrompt: async () => {
          // A token streamed BEFORE the failure → past the boundary.
          ctx.allTurnsText = "partial answer";
          ctx.emittedToClient = true;
        },
        suggestFallback: async () => {
          suggestCalls++;
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect(err.message).toContain("429");
    // No fallback was attempted once output had streamed.
    expect(suggestCalls).toBe(0);
    expect(built).toEqual(["p1"]);
  });

  test("non-availability error → surfaced unchanged, no failover", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    let suggestCalls = 0;

    const promise = runWithFailover(
      baseParams(ctx, host, {
        buildAgent: () => makeAgent("400 Bad Request: bad tool schema"),
        suggestFallback: async () => {
          suggestCalls++;
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    const err = await promise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect(err.message).toContain("400");
    expect(suggestCalls).toBe(0);
  });

  test("exhausts the attempt budget → ProviderUnavailableError on the last candidate", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const built: string[] = [];

    const promise = runWithFailover(
      baseParams(ctx, host, {
        maxAttempts: 2,
        initial: makeAttempt("p1"),
        buildAgent: (r) => {
          const p = (r as { resolved: { provider: string } }).resolved.provider;
          built.push(p);
          return makeAgent("503 overloaded"); // every candidate fails
        },
        // Always hand back a fresh provider so the loop is bounded by
        // maxAttempts, not by the attempted-set.
        suggestFallback: async (failed) => {
          const next = failed === "p1" ? "p2" : "p3";
          return { provider: next, model: `${next}-model`, tier: "balanced" };
        },
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
    const err = await promise.catch((e) => e);
    // Built p1 then p2 (2 attempts), then gave up before building p3.
    expect(built).toEqual(["p1", "p2"]);
    expect(err.failedProvider).toBe("p3");
    expect(err.suggestion).toBeNull();
  });

  test("failure recorded → circuit breaker opens after the threshold (real breaker)", async () => {
    resetAllCircuitBreakers();

    async function driveOneFailure(): Promise<void> {
      const ctx = makeCtx();
      const host = makeHost();
      await runWithFailover(
        baseParams(ctx, host, {
          initial: makeAttempt("flaky"),
          buildAgent: () => makeAgent("503 Service Unavailable"),
          suggestFallback: async () => null, // no fallback → one failure, then give up
        }),
      ).catch(() => {}); // swallow the ProviderUnavailableError
    }

    // Threshold is 3 (CircuitBreaker default).
    await driveOneFailure();
    expect(getCircuitBreaker("flaky").isOpen()).toBe(false);
    await driveOneFailure();
    expect(getCircuitBreaker("flaky").isOpen()).toBe(false);
    await driveOneFailure();
    expect(getCircuitBreaker("flaky").isOpen()).toBe(true);
  });

  test("MAX_FAILOVER_ATTEMPTS is a sane finite bound", () => {
    expect(MAX_FAILOVER_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(Number.isFinite(MAX_FAILOVER_ATTEMPTS)).toBe(true);
  });
});
