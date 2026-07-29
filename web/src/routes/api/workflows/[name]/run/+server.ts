import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getWorkflowExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveWorkflowOr } from "$lib/server/workflow-access";
import type { RequestHandler } from "./$types";

// Boundary validation. POST splits `projectId` off the body; every other
// field flows verbatim to the workflow executor as user-supplied input.
// `.loose()` is genuinely needed here because the input shape is driven
// by the workflow definition, not this handler — extras must flow
// through, not be stripped. (`.passthrough()` is deprecated in Zod v4.)
const postBodySchema = z.object({
  projectId: z.string().optional(),
}).loose();

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  try {
    const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Invalid request body");
    }
    const { projectId, ...input } = parsed.data;
    // Authorized for RUN specifically — not for read, and not by the
    // route. `run` is asked as its own question so C3 can narrow it
    // without touching this handler. Every row that existed before C6 is
    // `system`, which authorizes exactly the callers this endpoint
    // authorized before the ladder: any `chat` caller.
    const resolved = resolveWorkflowOr(
      user,
      params.name,
      "run",
      typeof projectId === "string" ? projectId : null,
      "Workflow not found",
    );
    if (resolved instanceof Response) return resolved;

    const workflowExec = getWorkflowExecutor();
    const run = await workflowExec.runWorkflow(
      resolved.entry.definition,
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
