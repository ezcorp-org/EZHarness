/**
 * POST /api/briefing/run-now — trigger an immediate briefing run for
 * the authenticated user (Phase 1 exit criterion: curl run-now → a
 * briefing conversation with real mined content appears for the right
 * user).
 *
 * Security posture (spec §9): authenticated; own-config only (the run
 * is keyed by the session user — no parameter to traverse);
 * rate-limited to 1 request per 5 minutes per user.
 *
 * The trigger body lives in `$lib/server/briefing-run-now.ts` so this
 * route and the Hub briefing tab's "Run now" action share ONE
 * implementation and ONE rate bucket (Extension Pages Hub spec §1.3) —
 * this module only maps the trigger result to HTTP. `__rateLimiter` /
 * `__testHooks` are re-exported for existing test imports.
 */
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { triggerBriefingRunNow } from "$lib/server/briefing-run-now";

export { __rateLimiter, __testHooks } from "$lib/server/briefing-run-now";

export const POST: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const result = await triggerBriefingRunNow(user.id);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      return errorJson(503, "Briefing runtime is not available yet — try again shortly");
    }
    return errorJson(
      429,
      "Briefing was already run recently — try again later",
      { retryAfter: result.retryAfter },
      { "Retry-After": String(result.retryAfter ?? 1) },
    );
  }

  return json({ started: true }, { status: 202 });
};
