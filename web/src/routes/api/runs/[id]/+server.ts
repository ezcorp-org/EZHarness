import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const run = await executor.getRun(params.id);
  if (!run) return json({ error: "Not found" }, { status: 404 });
  return json(run);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const cancelled = executor.cancelRun(params.id);
  if (!cancelled) return json({ error: "Run not found or not running" }, { status: 404 });
  return json({ ok: true });
};
