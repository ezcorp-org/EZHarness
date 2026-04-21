import type { RequestHandler } from "./$types";
import { json } from "@sveltejs/kit";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import {
  getSystemHealth,
  getActivityFeed,
  getErrorSummary,
} from "$server/db/queries/analytics";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  try {
    requireRole(locals, "admin");

    const [health, activityFeed, errorSummary] = await Promise.all([
      getSystemHealth(),
      getActivityFeed(),
      getErrorSummary(),
    ]);

    return json({ health, activityFeed, errorSummary });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
};
