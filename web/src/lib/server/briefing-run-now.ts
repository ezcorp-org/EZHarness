/**
 * Shared "run my briefing now" trigger — ONE implementation + ONE rate
 * bucket for both entry points:
 *
 *   - POST /api/briefing/run-now (settings button)
 *   - the Hub briefing tab's "Run now" action
 *     (`core:briefing` → actions["run-now"], wired in
 *     `$lib/server/context.ts` at provider registration)
 *
 * Extracted from the run-now route body so a user can't double-dip the
 * 1-per-5-minutes window by alternating surfaces. Lives in the web
 * layer (NOT src/runtime/briefing/) because the RateLimiter is a
 * web-layer security primitive and src/ must not import web/ — the
 * briefing hub-page provider takes this trigger via injection instead.
 *
 * The run itself stays fire-and-forget (a briefing can take minutes of
 * LLM time); completion is bookkept on the config row exactly like a
 * scheduled fire, including the consecutive-errors auto-disable path.
 */
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

const log = logger.child("briefing.run-now");

/** 1 run per 5 minutes per user (spec §5.4 / §9). Exported for test
 *  isolation — suites call `__rateLimiter.reset()` in beforeEach. */
export const __rateLimiter = new RateLimiter(1, 5 * 60_000);

/** Test-only seam: the most recent trigger's background run promise,
 *  so integration tests can await completion + bookkeeping instead of
 *  polling. Production never reads it. */
export const __testHooks: { lastRun?: Promise<BriefingRunResult | undefined> } = {};

export type TriggerBriefingRunNowResult =
  | { ok: true }
  /** Briefing runtime (executor + bus) not registered yet — boot
   *  ordering. Checked BEFORE the rate limiter so a 503 never consumes
   *  the user's single slot for the window. */
  | { ok: false; reason: "unavailable" }
  | { ok: false; reason: "rate-limited"; retryAfter?: number };

export async function triggerBriefingRunNow(
  userId: string,
): Promise<TriggerBriefingRunNowResult> {
  if (!getBriefingRuntime()) {
    return { ok: false, reason: "unavailable" };
  }

  const limit = __rateLimiter.check(`briefing-run-now:${userId}`);
  if (!limit.allowed) {
    return {
      ok: false,
      reason: "rate-limited",
      ...(limit.retryAfter !== undefined ? { retryAfter: limit.retryAfter } : {}),
    };
  }

  // No stored config is fine for run-now: operate on the defaults
  // (the project fallback chain inside the pipeline resolves a target,
  // or the run records 'skipped').
  const stored = await getBriefingConfig(userId);
  const config: BriefingConfig =
    stored ??
    ({
      userId,
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
    const outcome = await recordBriefingFireResult(userId, result.status);
    if (outcome?.disabled) {
      await notifyBriefingAutoDisabled(config, outcome.consecutiveErrors);
    }
    return result;
  })().catch((err) => {
    log.warn("run-now briefing failed", {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  });
  __testHooks.lastRun = runPromise;

  return { ok: true };
}
