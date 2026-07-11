/**
 * Ground-truth tests for the provider-error classifier
 * (src/runtime/stream-chat/provider-error-classifier.ts).
 *
 * Unlike the hand-written mock strings the failover suite drives, every string
 * here is lifted VERBATIM (with realistic interpolations) from a pi-ai 0.80.6
 * error-construction site in node_modules/@earendil-works/pi-ai/dist, so the
 * classifier is pinned to what the pinned SDK actually emits — not to a guess.
 * Each group cites the dist file it mirrors.
 *
 * The classifier returns a THREE-way action. The headline case is the
 * account-limit block: an OpenAI `429 insufficient_quota` (billing exhaustion)
 * is `"failover-only"` — a same-provider retry can't clear it (the pre-hardening
 * `/\b(?:429|5xx|529)\b/` table wrongly treated it as fully retryable), but a
 * DIFFERENT provider may still serve the turn, so it must NOT collapse to
 * `"rethrow"` either.
 */
import { test, expect, describe } from "bun:test";
import { classifyProviderError } from "../runtime/stream-chat/provider-error-classifier";

// ── TRANSIENT → "retry-then-failover" (pi-ai retry.js) ────────────────
// Realistic `.message` strings produced by the provider HTTP-error path
// `formatProviderError(normalizeProviderError(error))` (dist/utils/error-body.js
// composing "<status>: <body>" / "<prefix> (<status>): <message>") and by the
// raw `throw new Error(...)` sites across dist/api/*.js.
const TRANSIENT: Array<[label: string, message: string]> = [
  // openai-completions.js:370 — no-prefix "<status>: <body>", 429 rate limit.
  ["openai 429 rate limit", '429: {"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}'],
  // openai-responses.js:55 — prefixed "OpenAI API error (<status>): <message>".
  ["openai responses 503", "OpenAI API error (503): Service Unavailable"],
  // openai-completions.js:370 — 500 internal server error body.
  ["openai 500 server error", '500: {"error":{"message":"The server had an error while processing your request","type":"server_error"}}'],
  // google-generative-ai.js:214 — errorMessage = formatProviderError(...); the
  // "<status>: <body>" shape from error-body.js for a Google 429 rate limit
  // (a transient throttle, NOT a quota-exhaustion body).
  ["google 429 (formatProviderError <status>: <body>)", '429: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"The service is temporarily rate limited, please retry."}}'],
  // retry.js "ResourceExhausted" — gRPC providers e.g. NVIDIA NIM (no HTTP number).
  ["grpc ResourceExhausted (nvidia nim)", "14 ResourceExhausted: model server queue is full"],
  // anthropic-messages.js:555 — SDK APIError message, 529 carries overloaded_error.
  ["anthropic 529 overloaded", '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  // anthropic-messages.js:555 — SDK APIError message, 429 rate_limit_error.
  ["anthropic 429 rate_limit_error", '429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'],
  // anthropic-messages.js:275 — mid-stream SSE error event data (bare, no status).
  ["anthropic sse overloaded (no status)", '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'],
  // anthropic-messages.js:296 — premature stream end.
  ["anthropic stream ended before message_stop", "Anthropic stream ended before message_stop"],
  // openai-completions.js:357 — premature stream end.
  ["openai stream ended without finish_reason", "Stream ended without finish_reason"],
  // openai-responses-shared.js:445 — mid-stream error code event.
  ["openai responses error code", "Error Code rate_limit_exceeded: Rate limit reached"],
  // retry.js "upstream.?connect" + "reset before headers" — Codex raw-fetch
  // transport failure text (#733), matched by codex's own isRetryableError
  // regex (openai-codex-responses.js:56) and pi's retry.js.
  ["codex upstream connect / reset before headers", "upstream connect error or disconnect/reset before headers"],
  // retry.js "provider.?returned.?error" — OpenRouter wrapper text (#2264).
  ["openrouter provider returned error", "Provider returned error"],
  // retry.js "524" — Cloudflare origin timeout in front of a provider.
  ["cloudflare 524 timeout", "524: <html><body>error code: 524 (A timeout occurred)</body></html>"],
  // retry.js "http2 request did not get a response" — Bedrock/Smithy HTTP2 (#3594).
  ["bedrock http2 no response", "http2 request did not get a response"],
  // retry.js explicit retry-guidance (#6019) — OpenAI Responses / Bedrock stream.
  ["retry guidance you can retry", "The server had an error processing your request. You can retry your request."],
  // retry.js transport patterns pi covers but our old connection regex did not.
  ["undici socket hang up", "socket hang up"],
  ["undici terminated", "terminated"],
  ["connection lost", "connection lost"],
  ["other side closed", "other side closed"],
  ["bare request timed out", "Request timed out."],
  ["websocket closed", "WebSocket closed before response.completed"],
  // retry.js bare text signals with no HTTP number — the largest gap in the old
  // digit-only table (these used to surface raw to the user instead of failing over).
  ["bare overloaded", "The engine is currently overloaded, please try again later"],
  ["bare rate limit exceeded", "rate limit exceeded"],
  ["bare too many requests", "Too Many Requests"],
  ["bare service unavailable", "Service Unavailable"],
  ["bare internal error", "internal error"],
  ["retry delay cap", "Exceeded max retry delay"],
];

describe("classifyProviderError — transient → retry-then-failover (grounded in pi-ai retry.js)", () => {
  test.each(TRANSIENT)("%s", (_label, message) => {
    expect(classifyProviderError(message)).toBe("retry-then-failover");
  });
});

// ── ACCOUNT LIMITS → "failover-only" ──────────────────────────────────
// retry.js NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN. A same-provider retry is
// futile (the account/billing state won't clear), but a DIFFERENT provider may
// serve the turn — so these are failover-eligible, NOT a hard rethrow.
const ACCOUNT_LIMITS: Array<[label: string, message: string]> = [
  // THE headline case: OpenAI 429 insufficient_quota (billing). Old regex →
  // fully retryable (matched "429"); this classifier → failover-only.
  ["openai 429 insufficient_quota", '429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'],
  ["quota exceeded", "Your quota exceeded the allowed limit"],
  ["out of budget", "Request rejected: out of budget"],
  ["openrouter billing", "402: {\"error\":{\"message\":\"Insufficient credits. Add funds via billing.\"}}"],
  // opencode-go zen API subscription limits returned as 429 JSON error types.
  ["opencode GoUsageLimitError 429", '429: {"type":"GoUsageLimitError","message":"Monthly usage limit reached, enable available balance usage"}'],
  ["opencode FreeUsageLimitError", "FreeUsageLimitError: free tier limit hit"],
  // Adversarial (validator-proven): account-limit bodies that ALSO carry a
  // "529" or a connection token. These MUST stay failover-only — the
  // account-limit check runs BEFORE the bare-529 / connection supplements, so a
  // hard billing state is never misrouted to a same-provider retry.
  ["adversarial insufficient_quota + 529 retry-after", 'error: {"type":"insufficient_quota","message":"You exceeded your quota"}; retry after 529 seconds'],
  ["adversarial monthly-limit + 529 credits + billing", "Monthly usage limit reached: used 529/1000 credits; billing suspended"],
  ["adversarial billing + 529 plan cap", "billing error - plan cap 529/mo exceeded"],
  ["adversarial out-of-budget + 529 code", "Request rejected: out of budget (code 529)"],
  ["adversarial insufficient_quota + ECONNREFUSED", "insufficient_quota; connect ECONNREFUSED 10.0.0.1:443"],
];

describe("classifyProviderError — account limits → failover-only (excluded from same-provider retry)", () => {
  test.each(ACCOUNT_LIMITS)("%s", (_label, message) => {
    expect(classifyProviderError(message)).toBe("failover-only");
  });

  test("regression: 429 insufficient_quota is failover-only, not retry-then-failover", () => {
    // Proves the string carries the '429' the old table keyed on, so the
    // account-limit branch is winning — not a missing digit. The single-bit
    // predecessor collapsed this to a no-failover rethrow; the three-way split
    // preserves cross-provider failover for a billing-exhausted provider.
    const msg = ACCOUNT_LIMITS[0]![1];
    expect(msg).toContain("429");
    expect(msg).toContain("insufficient_quota");
    expect(classifyProviderError(msg)).toBe("failover-only");
  });
});

// ── SUPPLEMENT 1: connection-error shapes pi's word patterns miss ─────
// Bare errno codes / Bun fetch hints — caught by isProviderConnectionError
// (providers/provider-error.ts), NOT by pi-ai's retry.js. These exercise the
// supplement-1 branch (pi returns false, connection detector returns true).
const CONNECTION_SHAPES: Array<[label: string, message: string]> = [
  ["node ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:11434"],
  ["node ENOTFOUND", "getaddrinfo ENOTFOUND ollama"],
  ["bun typo-in-url hint", "Was there a typo in the url or port?"],
  ["bun unable to connect", "Unable to connect. Is the computer able to access the url?"],
];

describe("classifyProviderError — connection shapes → retry-then-failover (supplement 1, pi-ai misses these)", () => {
  test.each(CONNECTION_SHAPES)("%s", (_label, message) => {
    expect(classifyProviderError(message)).toBe("retry-then-failover");
  });
});

// ── SUPPLEMENT 2: Anthropic bare 529 (pi omits 529 from its numeric set) ──
describe("classifyProviderError — bare 529 → retry-then-failover (supplement 2)", () => {
  test("body-less 529 with no 'overloaded' text", () => {
    // pi-ai's numeric list is 429/500/502/503/504/524 — NOT 529 — and there is
    // no "overloaded" text here, so only the 529 marker catches it.
    expect(classifyProviderError("Anthropic API returned status 529")).toBe("retry-then-failover");
  });
});

// ── NEGATIVES → "rethrow" (surface unchanged, no retry, no failover) ──
const RETHROW: Array<[label: string, message: string]> = [
  // error-body.js "<status>: <body>" for 4xx caller faults.
  ["400 bad request", '400: {"error":{"message":"messages: array must not be empty"}}'],
  ["401 unauthorized", '401: {"error":{"message":"Incorrect API key provided"}}'],
  ["403 forbidden", "403: Forbidden"],
  ["404 model not found", "404: model not found: gemma4:31b"],
  ["422 unprocessable", "422: Unprocessable Entity"],
  // openai-responses.js:108 / google-generative-ai.js:201 — bare unknown error.
  ["unknown error occurred", "An unknown error occurred"],
  // anthropic/openai/google — user/abort cancellation, never an availability failure.
  ["request was aborted", "Request was aborted"],
  // openai-completions.js:354 fallback — note pi does NOT classify this literal
  // as retryable ("returned an error" ≠ "provider.?returned.?error"); kept as a
  // documented boundary (identical to the pre-hardening result).
  ["provider returned an error stop reason", "Provider returned an error stop reason"],
  ["arbitrary tool bug", "tool crashed while formatting output"],
  ["content filter", "Content was blocked by the safety filter"],
];

describe("classifyProviderError — negatives → rethrow (surface unchanged)", () => {
  test("empty / null / undefined → rethrow", () => {
    expect(classifyProviderError(undefined)).toBe("rethrow");
    expect(classifyProviderError(null)).toBe("rethrow");
    expect(classifyProviderError("")).toBe("rethrow");
  });

  test.each(RETHROW)("%s", (_label, message) => {
    expect(classifyProviderError(message)).toBe("rethrow");
  });
});
