import { json } from "@sveltejs/kit";
import { getExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { runAgentSchema } from "./schema";
import { validationError } from "$lib/server/security/validation";
import { checkTokenBudget } from "$lib/server/security/resource-quotas";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const budget = await checkTokenBudget(user.id);
  if (!budget.allowed) {
    return errorJson(429, "Daily token budget exceeded", { resetsAt: budget.resetsAt });
  }
  const executor = getExecutor();
  const agentName = params.name;
  try {
    const result = runAgentSchema.safeParse(await request.json());
    if (!result.success) {
      return validationError(result.error);
    }
    const { projectId, ...input } = result.data;
    // Attribute the run to the initiating user so per-user run-ownership
    // (GET/DELETE /api/runs/[id]) lets them read/cancel their own agent run.
    // Without this the run inserts user_id=NULL and is admin-only (fail-closed).
    const run = await executor.runAgent(
      agentName,
      input,
      typeof projectId === "string" ? projectId : undefined,
      user.id,
    );
    return json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(400, message);
  }
};
