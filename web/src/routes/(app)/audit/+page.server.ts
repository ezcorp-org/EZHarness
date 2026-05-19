import { error } from "@sveltejs/kit";
import { listGlobalAudit, globalStats, listExtensionsForFacets } from "$server/db/queries/audit-global";
import { requireAuth, requireRole } from "$server/auth/middleware";
import type { PageServerLoad } from "./$types";

/**
 * Phase 52.4 — global admin audit page loader.
 *
 * Admin-gated server-side. Non-admin reaching the route gets a 403
 * (mapped from the requireRole throw); SvelteKit's error boundary
 * renders the standard error page. We re-throw the throw with the
 * SvelteKit `error()` helper to keep the error contract uniform with
 * the rest of the app.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const user = requireAuth(locals);
  if (user.role !== "admin") throw error(403, "Admin access required");
  // Reach requireRole afterwards so the typed-throw shape is consistent
  // with other admin-only loaders. requireAuth already passed.
  requireRole(locals, "admin");

  const [feed, stats, extensionFacets] = await Promise.all([
    listGlobalAudit({ limit: 100 }),
    globalStats(24 * 60 * 60 * 1000),
    listExtensionsForFacets().catch(() => []),
  ]);

  return {
    entries: feed.entries,
    nextCursor: feed.nextCursor,
    stats,
    extensionFacets,
  };
};
