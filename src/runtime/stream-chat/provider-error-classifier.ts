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
 * ── Three actions, not two ───────────────────────────────────────────
 * failover.ts needs a THREE-way decision, because "should I retry the SAME
 * provider?" and "should I try a DIFFERENT provider?" are distinct questions:
 *
 *   - `"rethrow"`             — not an availability failure (bad request, auth,
 *                               content filter, context-length, unknown). No
 *                               retry, no failover; surface it unchanged.
 *   - `"retry-then-failover"` — transient provider/transport failure. Same-
 *                               provider retry FIRST (cache locality), then
 *                               cross-provider failover.
 *   - `"failover-only"`       — account/billing limit (quota exhausted, out of
 *                               budget, usage cap). A same-provider retry can
 *                               NEVER clear it, but a DIFFERENT provider may
 *                               well serve the turn, so skip the doomed retry
 *                               and go straight to cross-provider failover.
 *
 * pi-ai 0.80.6's `isRetryableAssistantError`
 * (node_modules/@earendil-works/pi-ai/dist/utils/retry.js, re-exported from the
 * package root via dist/index.js `export * from "./utils/retry.js"`) answers a
 * NARROWER question than failover needs: "should the last assistant turn be
 * restarted?" — i.e. same-model/same-provider (pi has no provider-routing
 * concept). It returns `false` for BOTH the account-limit class AND genuine
 * non-availability errors, collapsing our `"failover-only"` and `"rethrow"`
 * into one bucket. So we split them: detect the account-limit class explicitly
 * (mirroring pi's own NON_RETRYABLE list — see PATTERN NOTE) and route it to
 * `"failover-only"`; everything pi still calls retryable is
 * `"retry-then-failover"`.
 *
 * ── Pattern table (each row cites the upstream site it matches) ───────
 * ACCOUNT-LIMIT (→ "failover-only"): mirrors retry.js
 *   NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN — GoUsageLimitError /
 *   FreeUsageLimitError / "Monthly usage limit reached" / "available balance" /
 *   insufficient_quota / "out of budget" / "quota exceeded" / billing. These are
 *   the 4xx JSON bodies surfaced via `formatProviderError(
 *   normalizeProviderError(error))` (dist/utils/error-body.js) at
 *   dist/api/openai-completions.js:370 etc. (e.g. OpenAI 429 insufficient_quota).
 *
 * TRANSIENT (→ "retry-then-failover"), delegated to pi's
 *   `isRetryableAssistantError` RETRYABLE_PROVIDER_ERROR_PATTERN
 *   (dist/utils/retry.js): overloaded · rate.?limit · too many requests · 429 ·
 *   500 · 502 · 503 · 504 · 524 · service.?unavailable · server.?error ·
 *   internal.?error · provider.?returned.?error · network/connection.?error ·
 *   connection.?refused · connection.?lost · other side closed · fetch failed ·
 *   upstream.?connect · reset before headers · socket hang up · socket
 *   connection was closed · timed?.?out · timeout · terminated ·
 *   websocket.?closed/error · ended without · stream ended before message_stop ·
 *   http2 request did not get a response · retry delay · "you can retry your
 *   request" / "try your request again" / "please retry your request" ·
 *   ResourceExhausted. These are the `.message` strings from the same
 *   formatProviderError path plus the raw throws in dist/api/*.js (e.g.
 *   anthropic-messages.js:296 "Anthropic stream ended before message_stop",
 *   openai-completions.js:357 "Stream ended without finish_reason").
 *   Delegating (vs re-copying the ~30-entry regex) keeps this classifier in
 *   lockstep with the pinned pi-ai version so it can't silently drift on the
 *   next upgrade — the exact defect this module was created to fix.
 *
 * SUPPLEMENT (→ "retry-then-failover") — two transient shapes pi's word-based
 *   patterns miss:
 *   1. connection-error shapes — bare Node errno codes (ECONNREFUSED / ENOTFOUND
 *      / …) and Bun fetch hints ("Was there a typo in the url or port?"),
 *      delegated to the sibling `isProviderConnectionError`
 *      (providers/provider-error.ts) so the two stay DRY.
 *   2. Anthropic HTTP 529 ("overloaded") as a bare status number — pi catches
 *      the TEXT "overloaded" (and the Anthropic SDK 529 message does carry
 *      "overloaded_error", dist/api/anthropic-messages.js:275/:555) but 529 is
 *      absent from pi's numeric set (429/500/502/503/504/524), so we retain the
 *      numeric marker to stay robust to a body-less 529.
 *
 * ── PATTERN NOTE (drift) ─────────────────────────────────────────────
 * `ACCOUNT_LIMIT_PATTERN` is the ONE piece we must re-declare from pi's source
 * (pi exports only `isRetryableAssistantError`, not the raw patterns), because
 * the three-way split needs to distinguish account-limit from other
 * non-retryable errors — a distinction pi collapses. Keep it in sync with
 * dist/utils/retry.js NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN on pi upgrades;
 * the classifier tests pin it to verbatim dist strings so a drift shows up as a
 * red test.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { isProviderConnectionError } from "../../providers/provider-error";

/**
 * How failover.ts should react to a pre-stream provider error:
 *  - `"rethrow"`             surface unchanged (not an availability failure);
 *  - `"retry-then-failover"` same-provider retry first, then cross-provider;
 *  - `"failover-only"`       skip the same-provider retry, cross-provider only.
 */
export type ProviderErrorAction = "rethrow" | "retry-then-failover" | "failover-only";

/**
 * Account / billing limits — mirror of pi-ai 0.80.6 dist/utils/retry.js
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN. Same-provider retry can't clear
 * these, but a different provider may serve the turn → `"failover-only"`.
 */
const ACCOUNT_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

/**
 * Anthropic HTTP 529 "overloaded" surfaced as a bare status number. pi-ai's
 * retry patterns match the *text* "overloaded" but omit 529 from their numeric
 * set (dist/utils/retry.js lists 429/500/502/503/504/524, not 529).
 */
const ANTHROPIC_OVERLOADED_STATUS = /\b529\b/;

/**
 * Classify a pi-ai `stopReason:"error"` message into the failover action to
 * take. An absent/empty message is `"rethrow"` (nothing to fail over on).
 *
 * Account-limit is checked FIRST, and that ORDER is load-bearing: a quota/billing
 * body can incidentally carry a "529" or a connection token — e.g.
 * `insufficient_quota ... retry after 529 seconds` or
 * `insufficient_quota; connect ECONNREFUSED 10.0.0.1:443` — so if the 529 marker
 * or the connection detector ran first they would misroute a hard account limit
 * to the same-provider retry path. Matching the account-limit pattern before
 * pi's classifier AND before the two supplements is what prevents that (there is
 * no "disjoint by construction" guarantee — the classes genuinely overlap).
 */
export function classifyProviderError(errorMessage: string | undefined | null): ProviderErrorAction {
  if (!errorMessage) return "rethrow";
  // Account/billing limit → failover-eligible but NOT same-provider-retryable.
  // MUST stay ahead of the pi/supplement checks below (see the ordering note).
  if (ACCOUNT_LIMIT_PATTERN.test(errorMessage)) return "failover-only";
  // Transient provider/transport failure per pi-ai's own classifier (it already
  // excludes the account-limit class, handled above), plus the two shapes pi's
  // word patterns miss (connection errno/Bun hints, bare Anthropic 529).
  if (isRetryableAssistantError({ stopReason: "error", errorMessage } as AssistantMessage))
    return "retry-then-failover";
  if (isProviderConnectionError(errorMessage)) return "retry-then-failover";
  if (ANTHROPIC_OVERLOADED_STATUS.test(errorMessage)) return "retry-then-failover";
  return "rethrow";
}
