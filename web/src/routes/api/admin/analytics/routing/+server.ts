import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { getRoutingStats } from "$server/db/queries/analytics";

/**
 * Routing + cost analytics for the admin dashboard's Routing panel.
 *
 * Split out of `/api/admin/analytics` rather than folded into it: that route
 * already runs nine aggregations sequentially (see the pool-deadlock comment
 * there), and the routing panel is a separate tab that should not pay for —
 * or be blocked by — the rest of the dashboard's payload.
 *
 * Gated on the admin SCOPE **and** the admin ROLE. `requireScope` alone is
 * allow-all for cookie sessions (it only constrains API-key principals), so
 * scope-only gating would let any logged-in member read instance-wide spend.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    // Same clamp as /api/admin/analytics. The query layer clamps again
    // (sql-interval.ts), so a hostile value can never reach an INTERVAL
    // literal — this bound is about a sane payload, not safety.
    const days = Math.min(
      Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );

    return json(await getRoutingStats(days));
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
