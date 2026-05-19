import { json } from "@sveltejs/kit";
import { getGlobalStats } from "$server/db/queries/observability";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const days = parseInt(url.searchParams.get("days") ?? "30", 10);
  const stats = await getGlobalStats({ days: Number.isNaN(days) ? 30 : days });
  return json(stats);
};
