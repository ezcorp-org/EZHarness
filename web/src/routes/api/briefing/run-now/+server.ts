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
 * The run itself is fire-and-forget (a briefing can take minutes of
 * LLM time): the route responds 202 and the pipeline's completion is
 * recorded on the config row exactly like a scheduled fire — including
 * the consecutive-errors auto-disable path, so a user hammering a
 * broken provider through run-now sees the same one-time disable
 * notification the daemon would post.
 */
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { RateLimiter } from "$lib/server/security/rate-limiter";
import {
  getBriefingConfig,
  recordBriefingFireResult,
  BRIEFING_CONFIG_DEFAULTS,
  type BriefingConfig,
} from "$server/db/queries/briefing-configs";
import { getBriefingRuntime } from "$server/runtime/briefing/runtime-registry";
import {
  runBriefingForUser,
  notifyBriefingAutoDisabled,
  type BriefingRunResult,
} from "$server/runtime/briefing/run";
import { logger } from "$server/logger";

const log = logger.child("api.briefing.run-now");

/** 1 run per 5 minutes per user (spec §5.4 / §9). Exported for test
 *  isolation — suites call `__rateLimiter.reset()` in beforeEach. */
export const __rateLimiter = new RateLimiter(1, 5 * 60_000);

/** Test-only seam: the most recent request's background run promise,
 *  so integration tests can await completion + bookkeeping instead of
 *  polling. Production never reads it. */
export const __testHooks: { lastRun?: Promise<BriefingRunResult | undefined> } = {};

export const POST: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // Runtime gate BEFORE the rate limiter — a boot-ordering 503 must not
  // consume the user's single slot for the window.
  if (!getBriefingRuntime()) {
    return errorJson(503, "Briefing runtime is not available yet — try again shortly");
  }

  const limit = __rateLimiter.check(`briefing-run-now:${user.id}`);
  if (!limit.allowed) {
    return errorJson(
      429,
      "Briefing was already run recently — try again later",
      { retryAfter: limit.retryAfter },
      { "Retry-After": String(limit.retryAfter ?? 1) },
    );
  }

  // No stored config is fine for run-now: operate on the defaults
  // (the project fallback chain inside the pipeline resolves a target,
  // or the run records 'skipped').
  const stored = await getBriefingConfig(user.id);
  const config: BriefingConfig =
    stored ??
    ({
      userId: user.id,
      ...BRIEFING_CONFIG_DEFAULTS,
      watchlist: [],
      lastFireAt: null,
      lastFireStatus: null,
      consecutiveErrors: 0,
      nextFireAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as BriefingConfig);

  const runPromise = (async (): Promise<BriefingRunResult | undefined> => {
    const result = await runBriefingForUser(config);
    // recordBriefingFireResult returns null when no row exists (the
    // defaults path) — benign, nothing to bookkeep.
    const outcome = await recordBriefingFireResult(user.id, result.status);
    if (outcome?.disabled) {
      await notifyBriefingAutoDisabled(config, outcome.consecutiveErrors);
    }
    return result;
  })().catch((err) => {
    log.warn("run-now briefing failed", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  __testHooks.lastRun = runPromise;

  return json({ started: true }, { status: 202 });
};
