import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getSavedContext, deleteSavedContext } from "$server/db/queries/contexts";

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const ctx = await getSavedContext(params.id);
  if (!ctx) return errorJson(404, "Context not found");
  // Enumeration-safe: a non-owner (and unowned rows for non-admins) collapse
  // to the same 404 as a missing row — mirrors /api/memories/[id].
  if (ctx.userId !== user.id && user.role !== "admin") {
    return errorJson(404, "Context not found");
  }

  await deleteSavedContext(params.id);
  return new Response(null, { status: 204 });
};
