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
import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  runWithFailover,
  MAX_FAILOVER_ATTEMPTS,
  SAME_PROVIDER_RETRIES,
  RETRY_BACKOFF_MS,
  type FailoverAttempt,
  type RunWithFailoverParams,
} from "../runtime/stream-chat/failover";
import { ProviderUnavailableError } from "../providers/router";
import { getCircuitBreaker, resetAllCircuitBreakers } from "../providers/circuit-breaker";
import { EventBus } from "../runtime/events";
import type { StreamChatContext } from "../runtime/stream-chat/context";
import type { StreamChatHost } from "../runtime/stream-chat/host";

// ── fixtures ─────────────────────────────────────────────────────────
function makeCtx(): StreamChatContext {
  return {
    run: { id: "run-1" },
    unsub: undefined,
    unsubAgentActivity: [],
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

/** Build a params object with sane no-op seams, overridable per test.
 *  `sleep` defaults to a no-op so the same-provider retry backoff never
 *  waits real wall-clock time in unit tests (the ONE test of the default
 *  sleep overrides it back to `undefined`). */
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
    sleep: async () => {},
    ...over,
  };
}

beforeEach(() => resetAllCircuitBreakers());

// Classification itself is exhaustively pinned against pi-ai 0.80.6's error
// templates in provider-error-classifier.test.ts; here we exercise how the
// runWithFailover LOOP acts on each classified outcome.

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

    // Failover actually fired: p1 got its one same-provider retry FIRST,
    // then the loop rebuilt on the fallback provider…
    expect(built).toEqual(["p1", "p1", "p2"]);
    expect(suggestCalls).toBe(1);
    // …each failed attempt's subscription was detached before its retry…
    expect(unsubbed).toEqual([1, 1]);
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

  test.each(["400 Bad Request: bad tool schema", "401 Unauthorized"])(
    "non-availability error (%s) → surfaced unchanged, no same-provider retry, no failover",
    async (errorText) => {
      const ctx = makeCtx();
      const host = makeHost();
      let suggestCalls = 0;
      let builds = 0;
      let sleeps = 0;

      const promise = runWithFailover(
        baseParams(ctx, host, {
          buildAgent: () => {
            builds++;
            return makeAgent(errorText);
          },
          sleep: async () => {
            sleeps++;
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
      expect(err.message).toContain(errorText.slice(0, 3));
      // A caller-fault error is rethrown from the FIRST attempt: no
      // same-provider retry (no backoff), no fallback consultation, and the
      // breaker records nothing.
      expect(builds).toBe(1);
      expect(sleeps).toBe(0);
      expect(suggestCalls).toBe(0);
      expect(getCircuitBreaker("p1").isOpen()).toBe(false);
    },
  );

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
    // Built p1 then p2 (2 provider attempts, each with its one
    // same-provider retry), then gave up before building p3 — intra-provider
    // retries do NOT consume the cross-provider attempt budget.
    expect(built).toEqual(["p1", "p1", "p2", "p2"]);
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

  test("retry constants match the shipped policy (one retry, 150ms base)", () => {
    expect(SAME_PROVIDER_RETRIES).toBe(1);
    expect(RETRY_BACKOFF_MS).toBe(150);
  });
});

// ── account-limit: failover-only (no same-provider retry) ────────────
describe("runWithFailover — account-limit (failover-only)", () => {
  test("quota-exhausted provider → ZERO same-provider retries, straight to cross-provider failover which serves the turn", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const events: string[] = [];
    let sleeps = 0;

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: (r) => {
          const p = (r as { resolved: { provider: string } }).resolved.provider;
          events.push(`build:${p}`);
          // p1 is billing-exhausted; the fallback provider serves cleanly.
          return p === "p1"
            ? makeAgent('429: {"error":{"type":"insufficient_quota"}}')
            : makeAgent();
        },
        sleep: async () => {
          sleeps++;
        },
        runPrompt: async (agent) => {
          if (!agent.state.errorMessage) {
            ctx.allTurnsText = "served by fallback";
            ctx.emittedToClient = true;
          }
        },
        suggestFallback: async (failed) => {
          events.push(`suggest:${failed}`);
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    // p1 built exactly ONCE (no same-provider retry — a quota state can't
    // clear), then straight to the router and a rebuild on the fallback.
    expect(events).toEqual(["build:p1", "suggest:p1", "build:p2"]);
    expect(sleeps).toBe(0); // no backoff — the same-provider retry was skipped
    expect(ctx.allTurnsText).toBe("served by fallback");
    // The active agent is the fallback (p2) — a clean agent with no error.
    expect((host.activeAgents.get("run-1") as Agent).state.errorMessage).toBeUndefined();
    // The breaker recorded p1's one failure (prod wiring live).
    expect(getCircuitBreaker("p1").isOpen()).toBe(false);
  });

  test("quota-exhausted single-provider user → clean ProviderUnavailableError (not a raw Error)", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    let builds = 0;
    let sleeps = 0;

    const promise = runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("solo"),
        buildAgent: () => {
          builds++;
          return makeAgent("quota exceeded for this account");
        },
        sleep: async () => {
          sleeps++;
        },
        suggestFallback: async () => null, // BYOK: only one provider key
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(ProviderUnavailableError);
    const err = await promise.catch((e) => e);
    // Structured (rendered by finalize.ts), NOT the raw quota Error string.
    expect(err.failedProvider).toBe("solo");
    expect(err.suggestion).toBeNull();
    // One build, no same-provider retry backoff.
    expect(builds).toBe(1);
    expect(sleeps).toBe(0);
  });
});

// ── same-provider retry-first ────────────────────────────────────────
describe("runWithFailover — same-provider retry", () => {
  test("retryable failure → same-provider retry FIRST (after jittered backoff), cross-provider fallback second", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    // Ordered trace of every decision the loop makes — proves the retry
    // happens BEFORE suggestFallback is consulted.
    const events: string[] = [];

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: (r) => {
          const p = (r as { resolved: { provider: string } }).resolved.provider;
          events.push(`build:${p}`);
          return p === "p1" ? makeAgent("429 rate limited") : makeAgent();
        },
        sleep: async (ms) => {
          events.push("sleep");
          // Jitter bound: RETRY_BACKOFF_MS + Math.random()*RETRY_BACKOFF_MS.
          expect(ms).toBeGreaterThanOrEqual(RETRY_BACKOFF_MS);
          expect(ms).toBeLessThanOrEqual(2 * RETRY_BACKOFF_MS);
        },
        runPrompt: async (agent) => {
          if (!agent.state.errorMessage) {
            ctx.allTurnsText = "served by fallback";
            ctx.emittedToClient = true;
          }
        },
        suggestFallback: async (failed) => {
          events.push(`suggest:${failed}`);
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    expect(events).toEqual(["build:p1", "sleep", "build:p1", "suggest:p1", "build:p2"]);
    expect(ctx.allTurnsText).toBe("served by fallback");
  });

  test("retry succeeds on the same provider → no breaker failure, no fallback, default backoff is bounded", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    let p1Builds = 0;
    let suggestCalls = 0;
    const start = performance.now();

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        // No injected sleep → exercises the REAL default backoff once.
        sleep: undefined,
        buildAgent: () => {
          p1Builds++;
          // First build fails with a transient 529; the retry serves cleanly.
          return p1Builds === 1 ? makeAgent("529 overloaded") : makeAgent();
        },
        runPrompt: async (agent) => {
          if (!agent.state.errorMessage) {
            ctx.allTurnsText = "served by retry";
            ctx.emittedToClient = true;
          }
        },
        suggestFallback: async () => {
          suggestCalls++;
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    const elapsed = performance.now() - start;
    expect(ctx.allTurnsText).toBe("served by retry");
    expect(p1Builds).toBe(2);
    // The transient blip never reached the router or the breaker.
    expect(suggestCalls).toBe(0);
    expect(getCircuitBreaker("p1").isOpen()).toBe(false);
    // Default backoff really waited, and is bounded (150–300ms jitter; wide
    // margins so the assertion can't race the event loop).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("exactly ONE recordFailure per provider per turn despite the intra-provider retry", async () => {
    // Each failed turn prompts p1 twice (initial + retry) but must feed the
    // breaker only ONCE. Threshold is 3: with one failure per turn the
    // breaker stays closed after two turns and opens on the third; per-
    // attempt double-counting would open it after two turns (4 failures).
    let p1Builds = 0;
    async function driveOneFailedTurn(): Promise<void> {
      const ctx = makeCtx();
      const host = makeHost();
      await runWithFailover(
        baseParams(ctx, host, {
          initial: makeAttempt("p1"),
          buildAgent: () => {
            p1Builds++;
            return makeAgent("503 unavailable");
          },
          suggestFallback: async () => null,
        }),
      ).catch(() => {});
    }

    await driveOneFailedTurn();
    await driveOneFailedTurn();
    expect(p1Builds).toBe(4); // retry really ran twice per turn…
    expect(getCircuitBreaker("p1").isOpen()).toBe(false); // …but only 2 failures recorded
    await driveOneFailedTurn();
    expect(getCircuitBreaker("p1").isOpen()).toBe(true); // 3rd failure opens it
  });
});

// ── per-user (credentialScope) breaker keying ────────────────────────
describe("runWithFailover — credentialScope breaker keying", () => {
  async function driveFailedTurnAs(credentialScope: string | undefined): Promise<void> {
    const ctx = makeCtx();
    const host = makeHost();
    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("prov"),
        credentialScope,
        buildAgent: () => makeAgent("429 too many requests"),
        suggestFallback: async () => null,
      }),
    ).catch(() => {});
  }

  test("user A's failures open only user A's breaker — not user B's, not the shared one", async () => {
    for (let i = 0; i < 3; i++) await driveFailedTurnAs("user-a");
    expect(getCircuitBreaker("prov", "user-a").isOpen()).toBe(true);
    expect(getCircuitBreaker("prov", "user-b").isOpen()).toBe(false);
    expect(getCircuitBreaker("prov").isOpen()).toBe(false);
  });

  test("no credentialScope → old behavior: failures land on the shared breaker", async () => {
    for (let i = 0; i < 3; i++) await driveFailedTurnAs(undefined);
    expect(getCircuitBreaker("prov").isOpen()).toBe(true);
    expect(getCircuitBreaker("prov", "user-a").isOpen()).toBe(false);
  });

  test("recordSuccess lands on the scoped breaker", async () => {
    // Two prior scoped failures…
    getCircuitBreaker("prov", "user-a").recordFailure();
    getCircuitBreaker("prov", "user-a").recordFailure();
    // …then a clean scoped turn resets the count…
    const ctx = makeCtx();
    const host = makeHost();
    await runWithFailover(
      baseParams(ctx, host, { initial: makeAttempt("prov"), credentialScope: "user-a" }),
    );
    // …so two MORE failures still don't reach the threshold of 3.
    getCircuitBreaker("prov", "user-a").recordFailure();
    getCircuitBreaker("prov", "user-a").recordFailure();
    expect(getCircuitBreaker("prov", "user-a").isOpen()).toBe(false);
  });

  test("suggestFallback seam receives the turn's credentialScope", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const seen: Array<string | undefined> = [];

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        credentialScope: "user-42",
        buildAgent: (r) =>
          (r as { resolved: { provider: string } }).resolved.provider === "p1"
            ? makeAgent("503 unavailable")
            : makeAgent(),
        suggestFallback: async (_failed, _tier, credentialScope) => {
          seen.push(credentialScope);
          return { provider: "p2", model: "p2-model", tier: "balanced" };
        },
      }),
    );

    expect(seen).toEqual(["user-42"]);
  });
});

// ── listener hygiene across retries ──────────────────────────────────
describe("runWithFailover — unsubAgentActivity detach", () => {
  test("every prior attempt's bus listeners are detached; only the serving attempt's stay live", async () => {
    const ctx = makeCtx();
    const host = makeHost();
    const bus = new EventBus<Record<string, unknown>>();
    let fired = 0;
    // Off-function spies, grouped per attempt (mirrors subscribe-bridge,
    // which REASSIGNS ctx.unsubAgentActivity with 3 fresh bus listeners on
    // every subscribe call).
    const attemptOffs: Array<Array<ReturnType<typeof mock>>> = [];

    await runWithFailover(
      baseParams(ctx, host, {
        initial: makeAttempt("p1"),
        buildAgent: (r) =>
          (r as { resolved: { provider: string } }).resolved.provider === "p1"
            ? makeAgent("429 rate limited")
            : makeAgent(),
        subscribe: () => {
          const offs = (["agent:spawn", "agent:status", "agent:complete"] as const).map((ev) => {
            const off = bus.on(ev, () => {
              fired++;
            });
            return mock(() => off());
          });
          attemptOffs.push(offs);
          ctx.unsubAgentActivity = offs;
        },
        runPrompt: async (agent) => {
          if (!agent.state.errorMessage) ctx.emittedToClient = true;
        },
        suggestFallback: async () => ({ provider: "p2", model: "p2-model", tier: "balanced" }),
      }),
    );

    // Three attempts ran: p1, p1-retry, p2. The two failed attempts' off
    // functions were ALL called exactly once (no orphaned bus listeners);
    // the serving attempt's are still attached for finalizeCleanup.
    expect(attemptOffs).toHaveLength(3);
    for (const off of attemptOffs[0]!) expect(off).toHaveBeenCalledTimes(1);
    for (const off of attemptOffs[1]!) expect(off).toHaveBeenCalledTimes(1);
    for (const off of attemptOffs[2]!) expect(off).not.toHaveBeenCalled();
    expect(ctx.unsubAgentActivity).toBe(attemptOffs[2]!);

    // Bus-level proof: emitting each event fires exactly ONE listener (the
    // serving attempt's), not three — listener count is back to baseline+1.
    bus.emit("agent:spawn", {});
    bus.emit("agent:status", {});
    bus.emit("agent:complete", {});
    expect(fired).toBe(3);
  });
});
