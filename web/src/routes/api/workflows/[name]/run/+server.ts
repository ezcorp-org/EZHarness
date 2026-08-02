import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getWorkflowExecutor } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { canRunWorkflow } from "$server/runtime/workflow-authz";
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
    const scopedProjectId = typeof projectId === "string" ? projectId : undefined;

    // Authorize the definition the executor will ACTUALLY run — the same
    // object, not a re-lookup by name. Shared with the `run_workflow` tool
    // so the chat path and the REST path can never diverge.
    //
    // Ordered AFTER `resolveWorkflowOr` because it takes that call's
    // output. Upstream ran it before the body was parsed so a denied
    // caller could not tell a malformed body from a well-formed one; the
    // ladder cannot be asked that early — it needs `projectId`, which
    // only exists once the body is parsed — so that property is already
    // spent by the 404 above, and this ordering spends nothing further.
    const decision = await canRunWorkflow(resolved.entry, user, scopedProjectId);
    if (!decision.allowed) return errorJson(403, decision.reason);

    const workflowExec = getWorkflowExecutor();
    // C6's ownership ladder decides WHICH definition runs; the trunk's
    // async header decides whether the caller waits for it. Both apply:
    // the async branch must run the AUTHORIZED definition, not a
    // re-resolved one, or it would bypass the ladder for exactly the
    // callers that opted out of waiting.
    const definition = resolved.entry.definition;

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
        .runWorkflow(definition, input, scopedProjectId, user.id, undefined, { runId })
        .catch((err) => {
          console.error("async workflow run failed outside the executor", runId, err);
        });
      // 202 Accepted: the run is started, not finished. The caller follows
      // it on the `workflow:*` SSE frames (scoped to this user) or by
      // reading the row.
      return json({ id: runId, workflowName: definition.name, status: "running" }, { status: 202 });
    }

    const run = await workflowExec.runWorkflow(definition, input, scopedProjectId, user.id);
    return json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(400, message);
  }
};
