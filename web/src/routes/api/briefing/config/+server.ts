/**
 * GET/PUT /api/briefing/config — the current user's Daily Briefing
 * configuration (Phase 1, spec §5.4's API surface; the settings UI is
 * Phase 2).
 *
 * Own-config only by construction: the row is keyed by the
 * authenticated user's id — no id parameter exists to traverse.
 *
 * GET returns the stored row, or the documented defaults when the
 * user has never configured a briefing (no row is created on read).
 * PUT validates via the pure config-validation module (cron through
 * the reused `validateCron`, IANA tz via Intl, watchlist shape) and
 * upserts — `next_fire_at` is recomputed inside the query layer.
 */
import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  getBriefingConfig,
  upsertBriefingConfig,
  BRIEFING_CONFIG_DEFAULTS,
} from "$server/db/queries/briefing-configs";
import { validateBriefingConfigInput } from "$server/runtime/briefing/config-validation";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const row = await getBriefingConfig(user.id);
  if (row) return json(row);

  // Never-configured: present the defaults without minting a row.
  return json({
    userId: user.id,
    ...BRIEFING_CONFIG_DEFAULTS,
    lastFireAt: null,
    lastFireStatus: null,
    consecutiveErrors: 0,
    nextFireAt: null,
  });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "body must be valid JSON");
  }

  const validated = validateBriefingConfigInput(body);
  if (!validated.ok) return errorJson(400, validated.error);

  try {
    const row = await upsertBriefingConfig(user.id, validated.input);
    return json(row);
  } catch (err) {
    // Defense-in-depth: the validator already gates cron/timezone, so a
    // throw here is a merged-state pathology (e.g. a legacy row whose
    // stored cron no longer parses combined with a partial update) or a
    // referential failure (projectId pointing at a deleted project).
    // Fixed strings only — never echo raw driver/parser text to the
    // client. Drizzle wraps driver errors ("Failed query: …") with the
    // PG error on `cause`, so the FK sniff checks both layers (SQLSTATE
    // 23503 = foreign_key_violation).
    const cause = err instanceof Error ? (err.cause as { message?: string; code?: string } | undefined) : undefined;
    const msg = `${err instanceof Error ? err.message : String(err)} ${cause?.message ?? ""}`;
    if (cause?.code === "23503" || /foreign key|fkey/i.test(msg)) {
      return errorJson(400, "unknown project");
    }
    return errorJson(400, "invalid briefing config");
  }
};
