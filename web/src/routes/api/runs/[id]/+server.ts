import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const run = await executor.getRun(params.id);
  if (!run) return errorJson(404, "Not found");
  return json(run);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const cancelled = executor.cancelRun(params.id);
  if (!cancelled) return errorJson(404, "Run not found or not running");
  return json({ ok: true });
};
