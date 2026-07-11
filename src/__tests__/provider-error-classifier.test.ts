/**
 * Ground-truth tests for the provider-availability classifier
 * (src/runtime/stream-chat/provider-error-classifier.ts).
 *
 * Unlike the hand-written mock strings the failover suite drives, every string
 * here is lifted VERBATIM (with realistic interpolations) from a pi-ai 0.80.6
 * error-construction site in node_modules/@earendil-works/pi-ai/dist, so the
 * classifier is pinned to what the pinned SDK actually emits — not to a guess.
 * Each group cites the dist file it mirrors.
 *
 * The headline regression guard is the account-limit block: an OpenAI
 * `429 insufficient_quota` (billing exhaustion) must NOT be treated as a
 * retryable availability failure. The pre-hardening `/\b(?:429|5xx|529)\b/`
 * table matched the bare "429" and would have burned a same-provider retry, a
 * cross-provider failover, AND a circuit-breaker failure on a hard billing
 * state — pi-ai's own `isRetryableAssistantError` excludes it, and now so do we.
 */
import { test, expect, describe } from "bun:test";
import { classifyProviderAvailabilityError } from "../runtime/stream-chat/provider-error-classifier";

// ── PRIMARY: pi-ai isRetryableAssistantError (dist/utils/retry.js) ────
// Realistic `.message` strings produced by the provider HTTP-error path
// `formatProviderError(normalizeProviderError(error))` (dist/utils/error-body.js
// composing "<status>: <body>" / "<prefix> (<status>): <message>") and by the
// raw `throw new Error(...)` sites across dist/api/*.js.
const RETRYABLE_PRIMARY: Array<[label: string, message: string]> = [
  // openai-completions.js:370 — no-prefix "<status>: <body>", 429 rate limit.
  ["openai 429 rate limit", '429: {"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}'],
  // openai-responses.js:55 — prefixed "OpenAI API error (<status>): <message>".
  ["openai responses 503", "OpenAI API error (503): Service Unavailable"],
  // openai-completions.js:370 — 500 internal server error body.
  ["openai 500 server error", '500: {"error":{"message":"The server had an error while processing your request","type":"server_error"}}'],
  // google-generative-ai.js:214 — messageCarriesBody happy path, 429.
  ["google 429 too many requests", "[GoogleGenerativeAI Error]: got status: 429 Too Many Requests"],
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
  // openai-codex-responses.js:277 — Codex raw-fetch transport failure (#733).
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

describe("classifyProviderAvailabilityError — retryable (grounded in pi-ai retry.js)", () => {
  test.each(RETRYABLE_PRIMARY)("%s → availability failure", (_label, message) => {
    expect(classifyProviderAvailabilityError(message)).toBe(true);
  });
});

// ── PRIMARY exclusion: NON-retryable account/billing limits ───────────
// retry.js NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN is checked FIRST, so
// these are NOT availability failures even though several contain "429".
const NON_RETRYABLE_ACCOUNT_LIMITS: Array<[label: string, message: string]> = [
  // THE headline fix: OpenAI 429 insufficient_quota (billing). Old regex →
  // TRUE (matched "429"); pi + this classifier → FALSE.
  ["openai 429 insufficient_quota", '429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'],
  ["quota exceeded", "Your quota exceeded the allowed limit"],
  ["out of budget", "Request rejected: out of budget"],
  ["openrouter billing", "402: {\"error\":{\"message\":\"Insufficient credits. Add funds via billing.\"}}"],
  // opencode-go zen API subscription limits returned as 429 JSON error types.
  ["opencode GoUsageLimitError 429", '429: {"type":"GoUsageLimitError","message":"Monthly usage limit reached, enable available balance usage"}'],
  ["opencode FreeUsageLimitError", "FreeUsageLimitError: free tier limit hit"],
];

describe("classifyProviderAvailabilityError — non-retryable account limits (excluded first by retry.js)", () => {
  test.each(NON_RETRYABLE_ACCOUNT_LIMITS)("%s → NOT an availability failure", (_label, message) => {
    expect(classifyProviderAvailabilityError(message)).toBe(false);
  });

  test("regression: the 429 insufficient_quota body carries both '429' and the exclusion token", () => {
    // Proves the string really does contain the '429' the old table keyed on,
    // so the FALSE result above is the exclusion winning — not a missing digit.
    const msg = NON_RETRYABLE_ACCOUNT_LIMITS[0]![1];
    expect(msg).toContain("429");
    expect(msg).toContain("insufficient_quota");
    expect(classifyProviderAvailabilityError(msg)).toBe(false);
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

describe("classifyProviderAvailabilityError — connection shapes (supplement 1, pi-ai misses these)", () => {
  test.each(CONNECTION_SHAPES)("%s → availability failure", (_label, message) => {
    expect(classifyProviderAvailabilityError(message)).toBe(true);
  });
});

// ── SUPPLEMENT 2: Anthropic bare 529 (pi omits 529 from its numeric set) ──
describe("classifyProviderAvailabilityError — bare 529 (supplement 2)", () => {
  test("body-less 529 with no 'overloaded' text → availability failure", () => {
    // pi-ai's numeric list is 429/500/502/503/504/524 — NOT 529 — and there is
    // no "overloaded" text here, so only the 529 marker catches it.
    expect(classifyProviderAvailabilityError("Anthropic API returned status 529")).toBe(true);
  });
});

// ── NEGATIVES: benign / caller-fault errors that must NOT fail over ───
const NON_AVAILABILITY: Array<[label: string, message: string]> = [
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

describe("classifyProviderAvailabilityError — negatives (surface unchanged)", () => {
  test("empty / null / undefined → not an availability failure", () => {
    expect(classifyProviderAvailabilityError(undefined)).toBe(false);
    expect(classifyProviderAvailabilityError(null)).toBe(false);
    expect(classifyProviderAvailabilityError("")).toBe(false);
  });

  test.each(NON_AVAILABILITY)("%s → NOT an availability failure", (_label, message) => {
    expect(classifyProviderAvailabilityError(message)).toBe(false);
  });
});
