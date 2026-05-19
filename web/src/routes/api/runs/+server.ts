import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const projectId = url.searchParams.get("projectId") ?? undefined;
  return json(await executor.listRuns(projectId));
};
