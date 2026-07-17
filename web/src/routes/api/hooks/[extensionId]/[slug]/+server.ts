/**
 * Public inbound webhook trigger — `POST /api/hooks/:extensionId/:slug`
 * (Loops EZ Mode Phase 4). Registered `scope: public` (auth is the per-hook
 * token, NOT a session). This is a public attack surface; the ordering and
 * fail-closed posture below are load-bearing.
 *
 * `:extensionId` is the extension NAME (URL-safe; matches the extension_secrets
 * FK + the /api/extensions/:name convention). Contract:
 *   - 404 for a foreign/unknown extension, an unknown slug, a disabled hook, or
 *     no grant — ENUMERATION-SAFE: all four converge on the same 404 body and
 *     run the same constant-time dummy compare so they're indistinguishable.
 *   - 401 for absent/invalid auth on a KNOWN hook (Bearer token OR
 *     X-Hub-Signature-256 HMAC; constant-time compare; per-hook secret so a
 *     token for hook A never authenticates hook B).
 *   - 413 for an oversize body (256 KB) — checked on Content-Length AND on the
 *     actual bytes (a lying Content-Length cannot bypass).
 *   - 429 for a per-hook burst rate-limit OR an exhausted per-hook daily fire
 *     budget (a leaked token must not burn unbounded spend).
 *   - 202 on accept: the delivery is PERSISTED (durable queue) + audited, then
 *     best-effort drained. Every accept/reject is audited with a reason; the
 *     secret and payload are NEVER logged.
 */
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { getEnabledWebhook, insertDelivery, countDeliveriesSince, startOfUtcDay } from "$server/extensions/webhook-store";
import { getWebhookSecret } from "$server/extensions/webhook-secret";
import { verifyWebhookAuth, parseBearer, constantTimeEqual } from "$server/extensions/webhook-auth";
import { WEBHOOK_SLUG_RE } from "$server/extensions/manifest";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { getSetting } from "$server/db/queries/settings";
import { drainDelivery } from "$server/extensions/webhook-delivery-daemon";

/** Max accepted body size — 256 KB. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
/** Default per-hook daily fire budget (overridable via the `webhooks:daily_budget`
 *  setting). Caps spend a leaked-but-valid token can trigger. */
export const DEFAULT_WEBHOOK_DAILY_BUDGET = 1000;

// Per-hook burst limiter: 60 accepted-or-rejected requests / 60s. Keyed by
// `<extensionName>:<slug>` so a leaked token spamming ONE hook is throttled
// (and a token brute-force against a known hook is rate-limited before the
// constant-time auth compare). In-memory, process-local — the same posture as
// the login limiter; distributed rate-limiting is out of scope.
const limiter = new RateLimiter(60, 60_000);

/** @internal test-only — reset the per-hook burst limiter between tests. */
export function __resetWebhookLimiterForTests(): void {
  limiter.reset();
}

/** A stable dummy secret for the enumeration-safe path: an unknown hook (or a
 *  hook with no minted secret) still runs one constant-time compare so its
 *  response timing matches a real bad-auth path. */
const DUMMY_SECRET = "ezhook_0000000000000000000000000000000000000000000000000000000000";

async function auditReject(extensionName: string, slug: string, reason: string): Promise<void> {
  await insertAuditEntry(null, EXT_AUDIT_ACTIONS.SDK_WEBHOOK_REJECTED, extensionName, {
    slug,
    reason,
  }).catch(() => {});
}

export const POST: RequestHandler = async ({ params, request }) => {
  const extensionName = params.extensionId;
  const slug = params.slug;

  // Malformed slug can never name a real hook — treat as unknown (enumeration-
  // safe 404). Cheap shape gate before any DB work.
  if (!WEBHOOK_SLUG_RE.test(slug)) {
    // No hook to attribute — audit under the extension name with the unknown reason.
    await auditReject(extensionName, slug, "unknown");
    return errorJson(404, "Not found");
  }

  // 413 pre-check on the declared Content-Length (reject before reading the
  // body when the sender announces an oversize payload).
  const declaredLen = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_WEBHOOK_BODY_BYTES) {
    await auditReject(extensionName, slug, "oversize");
    return errorJson(413, "Payload too large");
  }

  // Read the RAW body once (exact bytes, for HMAC + durable persistence) and
  // enforce the cap on the ACTUAL byte length — a lying Content-Length cannot
  // bypass the limit.
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    await auditReject(extensionName, slug, "oversize");
    return errorJson(413, "Payload too large");
  }
  const rawBody = new TextDecoder().decode(bodyBytes);
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? null;

  // Look up the ENABLED hook. A null result (unknown ext / unknown slug /
  // disabled / no grant) all converge here — run a dummy constant-time compare
  // so the timing matches a real auth check, then 404.
  const hook = await getEnabledWebhook(extensionName, slug);
  if (!hook) {
    constantTimeEqual(parseBearer(request.headers.get("authorization")) ?? "", DUMMY_SECRET);
    await auditReject(extensionName, slug, "unknown");
    return errorJson(404, "Not found");
  }

  // Per-hook burst rate limit — BEFORE the auth compare so a token brute-force
  // against a known hook is throttled.
  const rl = limiter.check(`${extensionName}:${slug}`);
  if (!rl.allowed) {
    await auditReject(extensionName, slug, "rate-limited");
    return errorJson(429, "Too many requests", undefined, { "Retry-After": String(rl.retryAfter ?? 60) });
  }

  // Per-hook daily fire budget — a leaked-but-valid token cannot burn unbounded
  // LLM spend. Counts persisted (accepted) deliveries today; a rejected request
  // never consumed budget.
  const budget = await resolveDailyBudget();
  const usedToday = await countDeliveriesSince(extensionName, startOfUtcDay(new Date()));
  if (usedToday >= budget) {
    await auditReject(extensionName, slug, "budget-exceeded");
    return errorJson(429, "Daily budget exhausted", undefined, { "Retry-After": "3600" });
  }

  // Authenticate: per-hook secret via Bearer OR X-Hub-Signature-256 HMAC.
  const secret = (await getWebhookSecret(extensionName, slug)) ?? DUMMY_SECRET;
  const auth = verifyWebhookAuth(
    secret,
    {
      bearer: parseBearer(request.headers.get("authorization")),
      signature: request.headers.get("x-hub-signature-256"),
    },
    rawBody,
  );
  if (!auth.ok) {
    await auditReject(extensionName, slug, "unauthorized");
    return errorJson(401, "Unauthorized");
  }

  // Accept: PERSIST the delivery (durable claim-before-dispatch queue) BEFORE
  // any dispatch, audit the accept, then best-effort drain. Malformed / non-JSON
  // bodies are accepted verbatim — the SDK wraps the raw body as untrusted input
  // and only parses when it is JSON.
  const receivedAt = new Date();
  const deliveryId = await insertDelivery({
    webhookId: hook.id,
    extensionId: extensionName,
    slug,
    contentType,
    body: rawBody,
    receivedAt,
  });
  await insertAuditEntry(null, EXT_AUDIT_ACTIONS.SDK_WEBHOOK_ACCEPTED, extensionName, {
    slug,
    deliveryId,
    auth: auth.method,
  }).catch(() => {});

  // The delivery is durably queued as `pending`; kick a best-effort immediate
  // drain to cut latency vs the daemon's next tick. A no-op (subprocess down /
  // kill switch engaged) leaves the row `pending` for the daemon to catch up —
  // never fail the accept on a drain error.
  void drainDelivery(deliveryId).catch(() => {});

  return json({ accepted: true, deliveryId }, { status: 202 });
};

/** Resolve the per-hook daily fire budget from settings (fail-open to the
 *  default on any read error — a transient DB blip must not wedge the budget
 *  gate closed and 429 every delivery). */
async function resolveDailyBudget(): Promise<number> {
  try {
    const v = await getSetting("webhooks:daily_budget");
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  } catch {
    // fall through to default
  }
  return DEFAULT_WEBHOOK_DAILY_BUDGET;
}
