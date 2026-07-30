import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getWorkflowExecutor, getWorkflows } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation. POST splits `projectId` off the body; every other
// field flows verbatim to the workflow executor as user-supplied input.
// `.loose()` is genuinely needed here because the input shape is driven
// by the workflow definition, not this handler — extras must flow
// through, not be stripped. (`.passthrough()` is deprecated in Zod v4.)
const postBodySchema = z.object({
  projectId: z.string().optional(),
}).loose();

/**
 * Opt into a non-blocking run: `X-EZ-Workflow-Async: 1`.
 *
 * Absent — the default, and every existing caller — the handler is
 * byte-identical to what it was: the same inline `await runWorkflow(...)`,
 * the same returned `WorkflowRun`, the same 200. Opting IN is the only way
 * to change behaviour, which is what makes this safe to add to a route the
 * CLI, the extension trigger path and the demo e2e specs all depend on.
 *
 * Exactly `"1"`, not any truthy string: a header that silently accepted
 * `"0"` or `"false"` as async would be the sort of thing nobody notices
 * until a workflow they expected to have finished has not.
 */
function wantsAsync(request: Request): boolean {
  return request.headers.get("X-EZ-Workflow-Async") === "1";
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const workflow = getWorkflows().find((w) => w.name === params.name);
  if (!workflow) return errorJson(404, "Workflow not found");

  try {
    const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Invalid request body");
    }
    const { projectId, ...input } = parsed.data;
    const workflowExec = getWorkflowExecutor();
    const scopedProjectId = typeof projectId === "string" ? projectId : undefined;

    if (wantsAsync(request)) {
      // The id is minted HERE so the 202 can name the run. Deriving it
      // from the `workflow:start` event instead would be a race — the
      // response would have to wait for a frame it has no ordering
      // guarantee about.
      const runId = crypto.randomUUID();
      // Deliberately not awaited. Errors are swallowed into the run row by
      // the executor's own terminal handling, so the only thing that can
      // reach here is a bug — logged rather than left as an unhandled
      // rejection, which would take the process down along with every
      // other run in flight.
      void workflowExec
        .runWorkflow(workflow, input, scopedProjectId, user.id, undefined, { runId })
        .catch((err) => {
          console.error("async workflow run failed outside the executor", runId, err);
        });
      // 202 Accepted: the run is started, not finished. The caller follows
      // it on the `workflow:*` SSE frames (scoped to this user) or by
      // reading the row.
      return json({ id: runId, workflowName: workflow.name, status: "running" }, { status: 202 });
    }

    const run = await workflowExec.runWorkflow(workflow, input, scopedProjectId, user.id);
    return json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(400, message);
  }
};
