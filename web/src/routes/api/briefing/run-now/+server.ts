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
 * PLUS Boundary 3 (per-API-key tool policy). This route STARTS A RUN —
 * `triggerBriefingRunNow` → `runBriefingForUser` → `executor.streamChat` —
 * and shipped absent from `RUN_START_ROUTES`, so a `lockedModeId` policy could
 * name it at mint, and with Boundary 3 unwired. (Boundary 1 did apply: a key
 * WITH an allowlist that omits this route was always denied here.)
 * Own-config, read-only and rate-limited bound the blast radius but do not
 * close it: `tools/filter.ts` `keep()` preserves `invoke_agent`/`run_workflow`
 * through the read-only branch, so without `forceDenyOrchestration` a policied
 * key spawned agents here — mid-turn, issuing no HTTP request, where neither
 * the route allowlist nor a mode could see it.
 *
 * Boundary 2 is NOT wired, deliberately, and the route is absent from
 * `MODE_GUARDED_RUN_START_ROUTES` for it: the pipeline CREATES the
 * conversation it runs on (`run.ts` `createConversation`, which sets no
 * `mode_id`), so there is no persisted mode to check. A guard here would read
 * `null` and refuse every locked key unconditionally — a constant, not a mode
 * check. Locked keys are refused instead where the refusal is honest: at mint
 * (`validateToolPolicy`) and, for keys minted before that rule, at Boundary 1
 * (`lockedModeRunStartDenial`). Same shape as `agents/[name]/run`.
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
import { runStartToolPolicyOptions } from "$server/auth/tool-policy";

export { __rateLimiter, __testHooks } from "$lib/server/briefing-run-now";

export const POST: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Derived BEFORE the trigger runs and handed down with it, so the run this
  // request starts inherits the confinement of the credential that asked for
  // it. `{}` for a cookie session or an unpolicied key — byte-for-byte the
  // pre-policy surface.
  const result = await triggerBriefingRunNow(
    user.id,
    runStartToolPolicyOptions(locals.apiKeyToolPolicy),
  );
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
