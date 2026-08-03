/**
 * POST /api/hub/pages/[id]/actions/[action] — dispatch a named action
 * on a CORE Hub page. Extension page actions never hit this route —
 * they go through the generic extension events route
 * (`/api/extensions/[name]/events/[event]`) with the hub-source body
 * shape, keeping the manifest-event security ladder in one place.
 *
 * Security: authenticated + `chat` scope (same as every work-triggering
 * endpoint — this route IS `harness: controllable`, so an API key driving it
 * is intended), action-name regex, 404 for unknown page/action (no
 * enumeration oracle), 10 actions/min/user, body `{ payload? }` capped at
 * 2KB. Handlers may return a fresh tree — validated before serving, exactly
 * like the render route.
 *
 * PLUS one narrower gate: an action a provider lists in `sessionOnlyActions`
 * additionally requires an INTERACTIVE HUMAN SESSION. That is for actions
 * that spend a human DECISION rather than trigger work — today the
 * workflow-approvals `answer` action, which reaches `answerApproval`. Without
 * it, closing the REST answer route would merely have relocated R-4 to this
 * one: a leaked `chat` key would answer approvals through the Hub instead.
 * (This docblock used to claim the whole route was "session-authed". It was
 * not, and that mismatch is exactly how the bypass survived review.)
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth, requireSessionAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import { getHubPageProvider, HubPageActionError } from "$server/runtime/hub-pages";
import { validatePageTree, MAX_ACTION_PAYLOAD_BYTES } from "$server/extensions/page-schema";
import { parseHubPageId } from "$lib/hub";
import { logger } from "$server/logger";

const log = logger.child("api.hub.actions");

const ACTION_NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 10 actions per minute per user (across all pages). Exported for
 *  test isolation. */
export const __rateLimiter = new RateLimiter(10, 60_000);

export const POST: RequestHandler = async ({ locals, params, request }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = parseHubPageId(params.id ?? "");
  if (!parsed || parsed.kind !== "core") return errorJson(404, "Not found");

  const actionName = params.action ?? "";
  if (!ACTION_NAME_REGEX.test(actionName)) return errorJson(404, "Not found");

  const provider = getHubPageProvider(parsed.providerId);
  const handler = provider?.actions?.[actionName];
  if (!provider || !handler) return errorJson(404, "Not found");

  // Ordered AFTER the 404s so a refusal never confirms that an action
  // exists (the same discipline the checks above follow), and BEFORE the
  // rate limiter so a principal that can NEVER succeed cannot burn the
  // human's 10/min budget — which for the approvals action would mean a
  // leaked key could lock its owner out of answering their own gates.
  if (provider.sessionOnlyActions?.includes(actionName)) {
    const session = requireSessionAuth(locals);
    if (session instanceof Response) return session;
  }

  const limit = __rateLimiter.check(`hub-action:${user.id}`);
  if (!limit.allowed) {
    return errorJson(
      429,
      "Too many actions — slow down",
      { retryAfter: limit.retryAfter },
      { "Retry-After": String(limit.retryAfter ?? 1) },
    );
  }

  // Body: optional `{ payload }` plain object, ≤ 2KB serialized, with
  // SCALAR-ONLY values (string | number | boolean). The scalar rule is
  // defense-in-depth at the boundary: it mirrors `validateAction`'s
  // payload rule (page-schema.ts) so the security claim "a prompt's
  // typed value stays a sanitized scalar" holds at the edge, not only
  // because handlers happen to coerce. Nested objects/arrays inside the
  // payload are rejected outright — no core action needs them, and it
  // closes any "smuggle structured data through a prompt" vector.
  const raw = await request.json().catch(() => ({}));
  let payload: Record<string, unknown> | undefined;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).payload;
    if (candidate !== undefined) {
      if (
        candidate == null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        JSON.stringify(candidate).length > MAX_ACTION_PAYLOAD_BYTES
      ) {
        return errorJson(400, "Invalid payload");
      }
      for (const value of Object.values(candidate as Record<string, unknown>)) {
        const t = typeof value;
        if (t !== "string" && t !== "number" && t !== "boolean") {
          return errorJson(400, "Invalid payload");
        }
      }
      payload = candidate as Record<string, unknown>;
    }
  } else if (raw != null && typeof raw === "object") {
    return errorJson(400, "Invalid body");
  }

  try {
    const result = await handler({ userId: user.id }, payload);
    if (result === undefined) return json({ ok: true });

    const page = validatePageTree(result, {
      allowedEvents: Object.keys(provider.actions ?? {}),
    });
    if (!page) {
      log.warn("hub action returned an invalid tree", {
        providerId: parsed.providerId,
        action: actionName,
      });
      return json({ ok: true }); // action succeeded; client falls back to re-fetch
    }
    return json({ ok: true, page, renderedAt: Date.now() });
  } catch (err) {
    if (err instanceof HubPageActionError) {
      return errorJson(
        err.status,
        err.message,
        err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : undefined,
        err.retryAfter !== undefined ? { "Retry-After": String(err.retryAfter) } : undefined,
      );
    }
    log.warn("hub action failed", {
      providerId: parsed.providerId,
      action: actionName,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorJson(500, "Action failed");
  }
};
