import { json } from "@sveltejs/kit";
import { getWorkflowRunTrace } from "$server/runtime/workflow-run-trace";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

/**
 * One run's full trace: the run row, its steps, and each step's
 * iterations.
 *
 * Boundary only. `getWorkflowRunTrace` returns `undefined` for BOTH "no
 * such run" and "not yours", so this route cannot accidentally
 * distinguish them — 404 either way, and the message says nothing about
 * which. A 403 here would confirm the run exists, and a trace carries
 * `resolved_input` and `output`.
 *
 * Iterations are inlined rather than served from a separate lazy-load
 * route: a step is bounded by the loop ceiling times the retry ceiling, so
 * a few dozen rows at most, and a second round-trip to fetch them would
 * cost more than it saves.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const trace = await getWorkflowRunTrace(params.id, {
    userId: user.id,
    isAdmin: user.role === "admin",
  });
  if (!trace) return errorJson(404, "Not found");
  return json(trace);
};
