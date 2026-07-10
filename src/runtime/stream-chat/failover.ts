/**
 * WS2 — Pre-stream provider failover.
 *
 * The router already knows how to *suggest* a fallback provider
 * (`suggestFallback`) and the circuit breaker already knows how to open
 * after repeated failures — but nothing in prod fed the breaker or acted on
 * a suggestion, so reactive failover was dead code. This module is the
 * missing loop: it drives the initial LLM call and, when the provider fails
 * BEFORE the first token reaches the client, records the failure, asks for a
 * fallback, rebuilds the pi-agent on it, and retries.
 *
 * Deliberate boundaries (see docs/plans/2026-07-07-pi-caching-routing-
 * integration.md §WS2 + §5):
 *   - PRE-STREAM ONLY. Retries happen only while `ctx.emittedToClient` is
 *     false (nothing has streamed). Once a token or tool card reached the
 *     client, mid-stream failover is OUT OF SCOPE (partial-output
 *     re-emission + dedup is a documented follow-up) — the error is
 *     rethrown and the caller's existing error handling renders it.
 *   - Only provider-AVAILABILITY failures (429 / 5xx / connection-class) are
 *     retried; every other error (bad request, auth, content filter, tool
 *     bug) rethrows unchanged.
 *   - SAME-PROVIDER RETRY FIRST. Before consulting the router for a
 *     cross-provider fallback, the failing provider gets exactly
 *     {@link SAME_PROVIDER_RETRIES} rebuild+reprompt retries after a
 *     jittered backoff — a transient 429/5xx often clears in a few hundred
 *     ms, and staying on the same provider preserves Anthropic prompt-cache
 *     locality and avoids a cross-model quality discontinuity. The breaker
 *     records exactly ONE failure per provider per turn (after its retry
 *     budget is spent), not one per intra-provider attempt. Retry-After
 *     cannot be honored: pi-agent-core keeps only a string `errorMessage`,
 *     so the header is gone by the time we classify.
 *   - No usable fallback (single-provider BYOK user, every breaker open, or
 *     the suggestion loops back to a provider we already tried) surfaces a
 *     clean {@link ProviderUnavailableError} — finalize.ts renders it as a
 *     structured payload; the run never crashes.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import { getCircuitBreaker } from "../../providers/circuit-breaker";
import { ProviderUnavailableError, type FallbackSuggestion } from "../../providers/router";
import { isProviderConnectionError } from "../../providers/provider-error";
import { logger } from "../../logger";
import type { SetupToolsResult } from "./setup-tools";
import type { StreamChatContext } from "./context";
import type { StreamChatHost } from "./host";

const log = logger.child("executor.streamChat.failover");

/**
 * Hard cap on total LLM attempts (initial + fallbacks) for a single turn.
 * A belt-and-suspenders guard: the `attempted` provider set already
 * terminates the loop once every distinct provider has been tried, but this
 * bounds a misbehaving `suggestFallback` that keeps producing fresh
 * candidates.
 */
export const MAX_FAILOVER_ATTEMPTS = 4;

/**
 * Number of SAME-provider rebuild+reprompt retries a failing provider gets
 * (after a jittered backoff) before the loop records a breaker failure and
 * asks the router for a cross-provider fallback. Intra-provider retries do
 * NOT consume the {@link MAX_FAILOVER_ATTEMPTS} budget — that cap counts
 * providers, so total LLM calls stay bounded at
 * `maxAttempts × (1 + SAME_PROVIDER_RETRIES)`.
 */
export const SAME_PROVIDER_RETRIES = 1;

/**
 * Base backoff before a same-provider retry. The actual wait is jittered:
 * `RETRY_BACKOFF_MS + Math.random() * RETRY_BACKOFF_MS` (150–300 ms), so
 * concurrent turns hitting the same rate limit don't retry in lockstep.
 */
export const RETRY_BACKOFF_MS = 150;

/** Real wall-clock sleep; unit tests inject a recording fake instead. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detach everything the previous attempt's `subscribe` seam wired up, so a
 * failed attempt's bridge can't double-emit into the retry and no bus
 * listeners are orphaned:
 *   - `ctx.unsub` — the pi-agent event subscription;
 *   - `ctx.unsubAgentActivity` — the agent:spawn/status/complete bus
 *     listeners. subscribe-bridge REASSIGNS this array per attempt, so
 *     without detaching here every retry leaked its three host.bus
 *     listeners for the life of the process.
 * Resetting to undefined/[] keeps `finalizeCleanup` idempotent (it detaches
 * only what is still attached).
 */
function detachAttemptSubscriptions(ctx: StreamChatContext): void {
  ctx.unsub?.();
  ctx.unsub = undefined;
  for (const off of ctx.unsubAgentActivity) off();
  ctx.unsubAgentActivity = [];
}

/**
 * HTTP status markers that mean "provider temporarily unavailable" and are
 * therefore worth failing over: 429 (rate limited), 500/502/503/504
 * (server / bad-gateway / overloaded / gateway-timeout), 529 (Anthropic
 * "overloaded"). A 4xx that ISN'T 429 (400 bad request, 401/403 auth, 404,
 * 422) is the caller's fault — retrying a different provider won't help.
 */
const AVAILABILITY_STATUS = /\b(?:429|500|502|503|504|529)\b/;

/**
 * Classify a pi-ai `stopReason:"error"` message as a provider-AVAILABILITY
 * failure (retryable via a different provider) vs a normal error.
 *
 * pi-agent-core catches the provider error internally and keeps only its
 * `.message` string (see provider-error.ts), so classification is text-based:
 * an HTTP 429/5xx marker, OR a connection-class signature (refused / reset /
 * DNS-miss / socket-closed / timeout). An absent or empty message, or any
 * other error text, is treated as NON-availability (not retried).
 */
export function classifyProviderAvailabilityError(
  errorMessage: string | undefined | null,
): boolean {
  if (!errorMessage) return false;
  if (AVAILABILITY_STATUS.test(errorMessage)) return true;
  // Reuse the connection-class detector (ECONNREFUSED, socket closed, DNS
  // failure, fetch failed, timeout, …). It accepts a raw string.
  return isProviderConnectionError(errorMessage);
}

/** One resolved model attempt: the provider/model plus the built
 *  {@link SetupToolsResult} that `buildAgent` needs to construct the agent. */
export interface FailoverAttempt {
  provider: string;
  model: string;
  resolved: SetupToolsResult;
}

export interface RunWithFailoverParams {
  ctx: StreamChatContext;
  host: StreamChatHost;
  runId: string;
  /** Quality tier used when asking the router for a fallback candidate. */
  tier: string;
  /** The initial (already-resolved) model attempt. */
  initial: FailoverAttempt;
  /** Optional cap on total attempts (defaults to {@link MAX_FAILOVER_ATTEMPTS}). */
  maxAttempts?: number;
  /**
   * Circuit-breaker credential scope for this turn — the conversation
   * owner's userId (`convRecord?.userId`). Keys breaker state per
   * (provider, user) so one user's rate-limit failures don't open the
   * breaker for everyone else. Omitted → the process-wide `"shared"`
   * breaker (old behavior).
   */
  credentialScope?: string;
  /**
   * Sleep used for the same-provider retry backoff. Defaults to a real
   * `setTimeout` wait; unit tests inject a recording fake so the retry
   * path is deterministic and wall-clock-free.
   */
  sleep?: (ms: number) => Promise<void>;

  // ── seams: real impls wired by the executor, fakes in unit tests ──
  /** Construct a fresh pi-agent for the given resolved model. */
  buildAgent(resolved: SetupToolsResult): Agent;
  /** Wire the pi-agent event stream into the bus for THIS attempt. */
  subscribe(agent: Agent, attempt: FailoverAttempt): void;
  /** Issue the prompt. Resolves even on an LLM error (pi-agent-core stores
   *  the failure on `agent.state.errorMessage` rather than throwing). */
  runPrompt(agent: Agent): Promise<void>;
  /** Ask the router for the next provider to try (it skips open breakers and
   *  the failed provider). Real impl: providers/router.suggestFallback —
   *  `credentialScope` keys its breaker checks per user. */
  suggestFallback(
    failedProvider: string,
    tier: string,
    credentialScope?: string,
  ): Promise<FallbackSuggestion | null>;
  /** Resolve a suggested fallback into a full attempt (model object + cred). */
  resolveAttempt(suggestion: FallbackSuggestion): Promise<FailoverAttempt>;
}

/**
 * Build → subscribe → prompt the initial model, failing over PRE-stream on a
 * provider-availability error. Returns normally on success (the caller then
 * runs `finalizeSuccess`); throws on failure (the caller runs
 * `finalizeError`, which already renders {@link ProviderUnavailableError}).
 *
 * Feeds the circuit breaker in prod — keyed per `(provider,
 * credentialScope)`: exactly one `recordFailure()` per provider per turn
 * (after its same-provider retry budget is spent), `recordSuccess()` on the
 * turn that completes cleanly.
 */
export async function runWithFailover(params: RunWithFailoverParams): Promise<void> {
  const { ctx, host, runId, tier, initial, credentialScope } = params;
  const maxAttempts = params.maxAttempts ?? MAX_FAILOVER_ATTEMPTS;
  const sleep = params.sleep ?? defaultSleep;

  // Providers we've already tried (incl. the initial) — prevents a
  // suggestFallback loop (A→B→A) from cycling forever.
  const attempted = new Set<string>([initial.provider]);
  let current = initial;
  let lastErrorMessage = "";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Intra-provider tries: each provider gets 1 + SAME_PROVIDER_RETRIES
    // shots before the loop records a breaker failure and consults the
    // router — same-provider retry FIRST (cache locality, no cross-model
    // quality discontinuity), cross-provider failover second.
    for (let tryIdx = 0; tryIdx <= SAME_PROVIDER_RETRIES; tryIdx++) {
      // Detach the previous attempt's event subscriptions before rebuilding
      // so a failed attempt's bridge can't double-emit into the retry and
      // its bus listeners aren't orphaned.
      detachAttemptSubscriptions(ctx);
      // Fresh streaming state per attempt. A pre-token failure left nothing,
      // but reset defensively so no stale partial leaks into the retry and
      // the emitted-to-client boundary is re-armed for this attempt.
      ctx.allTurnsText = "";
      ctx.turnText = "";
      ctx.emittedToClient = false;

      const agent = params.buildAgent(current.resolved);
      host.activeAgents.set(runId, agent);
      params.subscribe(agent, current);
      await params.runPrompt(agent);

      const errorMessage = agent.state.errorMessage;
      if (!errorMessage) {
        // Clean turn → close the breaker for the serving provider.
        getCircuitBreaker(current.provider, credentialScope).recordSuccess();
        return;
      }
      lastErrorMessage = errorMessage;

      // Something already streamed to the client → mid-stream failure, out
      // of scope. Rethrow so the caller's error path renders it (no retry,
      // no re-emission). This is the explicit pre/post-first-token boundary.
      if (ctx.emittedToClient) {
        throw new Error(errorMessage);
      }
      // Not an availability failure (bad request / auth / content filter) →
      // retrying anywhere won't help; surface it unchanged.
      if (!classifyProviderAvailabilityError(errorMessage)) {
        throw new Error(errorMessage);
      }

      // Retryable, pre-first-token, retry budget left → jittered backoff,
      // then rebuild+reprompt on the SAME provider. No breaker failure yet.
      if (tryIdx < SAME_PROVIDER_RETRIES) {
        const backoffMs = RETRY_BACKOFF_MS + Math.random() * RETRY_BACKOFF_MS;
        log.info("provider failure before first token — same-provider retry", {
          provider: current.provider,
          model: current.model,
          retry: tryIdx + 1,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
      }
    }

    // Provider spent its same-provider retry budget → feed the breaker
    // (exactly ONE failure per provider per turn) and try a fallback.
    getCircuitBreaker(current.provider, credentialScope).recordFailure();
    log.info("provider failure before first token — attempting failover", {
      failedProvider: current.provider,
      failedModel: current.model,
      attempt: attempt + 1,
    });

    const suggestion = await params.suggestFallback(current.provider, tier, credentialScope);
    if (!suggestion || attempted.has(suggestion.provider)) {
      // Single-provider BYOK, every alternative's breaker open, or a loop
      // back to an already-tried provider → clean, rendered outcome.
      throw new ProviderUnavailableError(lastErrorMessage, current.provider, current.model, null);
    }
    attempted.add(suggestion.provider);
    current = await params.resolveAttempt(suggestion);
  }

  // Exhausted the attempt budget with every candidate failing.
  throw new ProviderUnavailableError(lastErrorMessage, current.provider, current.model, null);
}
