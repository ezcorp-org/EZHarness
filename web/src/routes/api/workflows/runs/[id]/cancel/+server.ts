import { json } from "@sveltejs/kit";
import { cancelParkedRun } from "$server/runtime/workflow-run-control";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary only — ownership and the terminal-state race live behind
// `cancelParkedRun`, whose CAS is what makes a double-cancel a clean 409
// rather than an overwrite of whatever really finished the run.
const STATUS: Record<string, number> = {
  "not-found": 404,
  forbidden: 403,
  "already-terminal": 409,
};

export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const result = await cancelParkedRun(params.id, {
    userId: user.id,
    isAdmin: user.role === "admin",
  });

  if (!result.ok) return errorJson(STATUS[result.code] ?? 400, result.message);
  return json({ cancelled: true });
};
