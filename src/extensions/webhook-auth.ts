/**
 * Webhook authentication — pure, constant-time verification of an inbound
 * `POST /api/hooks/:extensionId/:slug` (Loops EZ Mode Phase 4).
 *
 * Two auth schemes, either sufficient (support BOTH — GitHub posts HMAC,
 * simpler senders post a bearer token):
 *   - `Authorization: Bearer <token>` — the token equals the per-hook secret.
 *   - `X-Hub-Signature-256: sha256=<hex>` — GitHub-style HMAC-SHA256 of the
 *     RAW request body keyed by the per-hook secret.
 *
 * SECURITY:
 *   - Comparison is CONSTANT-TIME (`timingSafeEqual` over SHA-256 digests of
 *     both sides — equal-length 32-byte buffers, so no length leak and no
 *     early-exit byte-compare timing side-channel).
 *   - The secret is per-hook, so a token/HMAC minted for hook A NEVER
 *     authenticates hook B (cross-hook replay fails: B is verified against B's
 *     secret). This module is given ONLY the target hook's secret.
 *   - Pure + side-effect-free: no logging, no I/O — the caller owns audit and
 *     never logs the secret or the raw body.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type WebhookAuthMethod = "bearer" | "hmac";

export interface WebhookAuthInput {
  /** The bearer token from the `Authorization` header (already stripped of the
   *  `Bearer ` prefix), or null/undefined when absent. */
  bearer?: string | null;
  /** The full `X-Hub-Signature-256` header value (e.g. `sha256=abc…`), or
   *  null/undefined when absent. */
  signature?: string | null;
}

export interface WebhookAuthResult {
  ok: boolean;
  method?: WebhookAuthMethod;
}

/**
 * Constant-time string equality: compare the SHA-256 digests of both inputs
 * with `timingSafeEqual`. Hashing first guarantees equal-length buffers (so
 * `timingSafeEqual` never throws on a length mismatch and the comparison time
 * is independent of where the strings first differ or how long they are).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Extract the bearer token from an `Authorization` header value. Returns null
 *  when absent or not a `Bearer` scheme. Scheme match is case-insensitive
 *  (RFC 7235); the token is returned verbatim. */
export function parseBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer[ \t]+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}

/**
 * Verify an inbound webhook against the hook's secret. Returns `{ ok: true,
 * method }` when EITHER scheme validates, else `{ ok: false }`. Both schemes
 * are attempted so a request carrying either a valid bearer OR a valid HMAC
 * authenticates; an invalid value in one header does not veto a valid value in
 * the other. When BOTH headers are absent the result is `{ ok: false }` (the
 * caller returns 401).
 */
export function verifyWebhookAuth(
  secret: string,
  input: WebhookAuthInput,
  rawBody: string,
): WebhookAuthResult {
  if (input.bearer != null && input.bearer.length > 0) {
    if (constantTimeEqual(input.bearer, secret)) {
      return { ok: true, method: "bearer" };
    }
  }
  if (input.signature != null && input.signature.length > 0) {
    const expected =
      "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    if (constantTimeEqual(input.signature, expected)) {
      return { ok: true, method: "hmac" };
    }
  }
  return { ok: false };
}

/** Compute the `X-Hub-Signature-256` header value a sender must send for
 *  `rawBody` under `secret`. Exposed so the harness-client (and tests) can post
 *  a valid HMAC without re-deriving the format. */
export function webhookSignature(secret: string, rawBody: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}
