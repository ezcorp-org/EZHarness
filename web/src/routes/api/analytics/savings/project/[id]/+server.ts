import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getProject } from "$server/db/queries/projects";
import { getSavingsForProject } from "$server/db/queries/savings-analytics";

/**
 * GET /api/analytics/savings/project/[id] — project-scoped savings estimate.
 *
 * Guard (fail-closed, mirrors the conversation-audit loader pattern): an
 * unknown project id 404s. Projects carry no owner column, so "membership"
 * is enforced by SCOPE, not rejection: admins see the whole project's
 * aggregate; every other caller gets ONLY their own conversations' slice of
 * the project — a member can never read another user's spend through this
 * route. Queries run sequentially (PGlite pool discipline — see
 * /api/admin/analytics).
 */
export const GET: RequestHandler = async ({ url, params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  try {
    const user = requireAuth(locals);

    const project = await getProject(params.id);
    if (!project) return errorJson(404, "Not found");

    // Clamp days to [1, 365]; non-numeric / 0 fall back to the 30-day default
    // (same idiom as /api/admin/analytics).
    const days = Math.min(
      Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1),
      365,
    );

    const report = await getSavingsForProject(
      params.id,
      days,
      user.role === "admin" ? undefined : user.id,
    );
    return json(report);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
