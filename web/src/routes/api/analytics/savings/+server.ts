import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getSavingsForUser } from "$server/db/queries/savings-analytics";

/**
 * GET /api/analytics/savings — the calling user's prompt-cache + routing
 * savings estimate (global, across every project). Thin handler: parse +
 * guard here, ALL math/aggregation in $server/db/queries/savings-analytics.
 *
 * Always scoped to the authenticated user's OWN rows — there is no way to
 * request another user's report from this route.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    const user = requireAuth(locals);

    // Clamp days to [1, 365]; non-numeric / 0 fall back to the 30-day default
    // (same idiom as /api/admin/analytics).
    const days = Math.min(
      Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );

    const report = await getSavingsForUser(user.id, days);
    return json(report);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
