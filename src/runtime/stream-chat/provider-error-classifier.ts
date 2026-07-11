/**
 * Provider-error classification, grounded in pi-ai 0.80.6's own error
 * templates and its authoritative transient-error classifier.
 *
 * ── Why this module exists ───────────────────────────────────────────
 * The pre-stream failover loop (failover.ts) decides retry / cross-provider
 * failover / circuit-breaker actions from a single stringly-typed
 * `agent.state.errorMessage`. pi-agent-core sets that string verbatim from the
 * thrown provider error's `.message`
 * (node_modules/@earendil-works/pi-agent-core/dist/agent.js:346-347 —
 * `errorMessage: error instanceof Error ? error.message : String(error)`), so
 * classification is necessarily text-based.
 *
 * pi-ai 0.80.6 already ships the canonical text classifier for exactly this
 * string: `isRetryableAssistantError`
 * (node_modules/@earendil-works/pi-ai/dist/utils/retry.js, re-exported from the
 * package root via dist/index.js `export * from "./utils/retry.js"`). It
 * encodes ~30 transient / transport patterns AND a non-retryable account-limit
 * exclusion (quota / billing / usage-limit) that it checks FIRST. Delegating to
 * it — instead of hand-maintaining a parallel regex — is the whole point of
 * this module: the failover decision now moves in lockstep with the pinned
 * pi-ai version and cannot silently drift on the next upgrade (the exact defect
 * that motivated this PR — the previous `/\b(?:429|5xx|529)\b/` table had never
 * been checked against what pi-ai actually emits).
 *
 * ── Pattern table (each row cites the upstream site it matches) ───────
 * PRIMARY — delegated to pi-ai's `isRetryableAssistantError`
 *   (dist/utils/retry.js). Its RETRYABLE_PROVIDER_ERROR_PATTERN covers, among
 *   others: overloaded · rate.?limit · too many requests · 429 · 500 · 502 ·
 *   503 · 504 · 524 · service.?unavailable · server.?error · internal.?error ·
 *   provider.?returned.?error · network/connection.?error · connection.?refused
 *   · connection.?lost · other side closed · fetch failed · upstream.?connect ·
 *   reset before headers · socket hang up · socket connection was closed ·
 *   timed?.?out · timeout · terminated · websocket.?closed/error · ended
 *   without · stream ended before message_stop · http2 request did not get a
 *   response · retry delay · "you can retry your request" / "try your request
 *   again" / "please retry your request" · ResourceExhausted. These are the
 *   `.message` strings produced by the provider `formatProviderError(
 *   normalizeProviderError(error))` path (dist/utils/error-body.js →
 *   dist/api/openai-completions.js:370, openai-responses.js:55,
 *   google-generative-ai.js:214, openai-codex-responses.js:315) and the raw
 *   throws in dist/api/*.js (e.g. anthropic-messages.js:296 "Anthropic stream
 *   ended before message_stop", openai-completions.js:357 "Stream ended without
 *   finish_reason").
 *   pi's NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN (checked first) excludes:
 *   insufficient_quota · quota exceeded · billing · out of budget · Monthly
 *   usage limit reached · available balance · GoUsageLimitError ·
 *   FreeUsageLimitError — hard account/billing states that no retry or failover
 *   can clear.
 *
 * SUPPLEMENT 1 — connection-error *shapes* pi's word-based patterns miss:
 *   bare Node errno codes (ECONNREFUSED / ECONNRESET / ENOTFOUND / EAI_AGAIN /
 *   ETIMEDOUT), Bun error names (ConnectionClosed / FailedToOpenSocket), and
 *   Bun's fetch hints ("Was there a typo in the url or port?", "Unable to
 *   connect…"). Delegated to the sibling `isProviderConnectionError`
 *   (providers/provider-error.ts) — the same detector `friendlyProviderError`
 *   uses — so the two stay DRY.
 *
 * SUPPLEMENT 2 — Anthropic HTTP 529 ("overloaded") as a bare status number.
 *   pi catches the *text* "overloaded" and the Anthropic SDK message for a 529
 *   does carry "overloaded_error" (dist/api/anthropic-messages.js:275
 *   `throw new Error(sse.data)` for mid-stream error events, :555
 *   `output.errorMessage = error.message` for the SDK APIError), but 529 is not
 *   in pi's numeric list — so we retain the numeric marker to stay robust to a
 *   body-less 529 and identical to the pre-hardening behavior.
 *
 * ── Precedence invariant ─────────────────────────────────────────────
 * The account-limit exclusion must win over EVERY retryable signal, including
 * the two supplements. It does, by construction: a quota/billing message is a
 * 4xx JSON body (insufficient_quota / billing / …) that contains neither a
 * connection-error shape nor the number 529, so the supplements are disjoint
 * from the account-limit class and OR-ing them can never re-admit an excluded
 * error. (This is why no separate exclusion re-check is needed here.)
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { isProviderConnectionError } from "../../providers/provider-error";

/**
 * Anthropic HTTP 529 "overloaded" surfaced as a bare status number. pi-ai's
 * retry patterns match the *text* "overloaded" but omit 529 from their numeric
 * set (dist/utils/retry.js lists 429/500/502/503/504/524, not 529), so this
 * supplements pi for a body-less 529.
 */
const ANTHROPIC_OVERLOADED_STATUS = /\b529\b/;

/**
 * Classify a pi-ai `stopReason:"error"` message as a provider-AVAILABILITY
 * failure (retryable via a same-provider retry or a cross-provider failover)
 * vs a normal error that must surface unchanged.
 *
 * Returns `false` for an absent/empty message, for hard account-limit failures
 * (quota / billing — excluded by pi's own classifier), and for any error text
 * that is neither a pi-recognized transient signal nor a connection-error shape
 * nor a 529.
 */
export function classifyProviderAvailabilityError(
  errorMessage: string | undefined | null,
): boolean {
  if (!errorMessage) return false;
  // PRIMARY: pi-ai's authoritative transient-error classifier. It applies the
  // non-retryable account-limit exclusion (quota/billing) FIRST, so those never
  // count as retryable here either. We hand it the same field shape it reads —
  // `{ stopReason: "error", errorMessage }` — nothing else is inspected.
  if (isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage)) return true;
  // SUPPLEMENT 1: connection-error shapes pi's word patterns miss (errno codes,
  // Bun fetch hints). Disjoint from the account-limit class, so OR-ing is safe.
  if (isProviderConnectionError(errorMessage)) return true;
  // SUPPLEMENT 2: Anthropic 529 surfaced as a bare status number.
  return ANTHROPIC_OVERLOADED_STATUS.test(errorMessage);
}
