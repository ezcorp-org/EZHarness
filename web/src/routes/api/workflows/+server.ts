import { json } from "@sveltejs/kit";
import * as workflowQueries from "$server/db/queries/workflows";
import { reloadWorkflows } from "$lib/server/context";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { denyVisibilityOr, listVisibleWorkflows, validateWorkflowForCaller } from "$lib/server/workflow-access";
import type { RequestHandler } from "./$types";
import type { WorkflowDefinition } from "$server/types";
import { workflowBodySchema } from "./schema";

// Boundary validation. POST forwards the parsed body to createWorkflow
// (which reads name/description/inputSchema/steps). The shared
// `workflowBodySchema` only pins shape; the shared `validateWorkflow`
// enforces the semantic rules and drives the 400 message.

/**
 * List workflows the caller may see.
 *
 * **Behaviour change, documented in the registry entry:** this used to
 * return the whole merged cache to any `read`-scoped caller. It is now
 * filtered by the same ladder the single-workflow routes use, so a
 * script holding a `read` key sees `system` workflows plus whatever its
 * principal owns — a shorter array than before, never a different shape.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  // The ladder decides WHICH workflows this caller may see, and stamps
  // each with its own `canEdit` answer so the UI can hide Edit/Delete on
  // the ones it would only get a 403/404 for (YAML + extension assets, and
  // other users' rows). One pass, one rule — the flag is the ladder's
  // verdict, never a second predicate that could drift from it.
  return json(await listVisibleWorkflows(user, url.searchParams.get("projectId")));
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parsed = workflowBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "name and steps required");
  }
  const body = parsed.data;
  if (!body.name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return errorJson(400, "name and steps required");
  }

  // Definition-time validation (duplicate names, unknown deps, kind/field
  // mismatches, loop-on-gate, loop+retries, non-integer maxIterations).
  const errors = await validateWorkflowForCaller(user, body as WorkflowDefinition);
  if (errors.length > 0) {
    return errorJson(400, errors[0]!);
  }

  // A visibility is the author's to choose, but not every value is:
  // `system` is admin-only. One shared adapter over the ladder's rule, so
  // create and update cannot disagree about who may assign what.
  const visibilityDenial = denyVisibilityOr(user, body.visibility);
  if (visibilityDenial) return visibilityDenial;

  let workflow: workflowQueries.DbWorkflow;
  try {
    // The authenticated creator IS the owner. C6 deliberately left
    // `userId` null here, on the reasoning that ownership should never
    // arrive as a side effect of an ordinary create; the product owner has
    // since ruled the other way, and this is that ruling.
    //
    // `visibility` still DEFAULTS to `system` (`createWorkflow` applies
    // it), which is the pre-C6 behaviour and is not this route's to
    // alter. The stamp is what makes that default usable: the ladder's
    // `edit` rung asks OWNERSHIP before it asks the tier, so the author
    // of a default-visibility row can edit and delete it, while a
    // non-owner still gets `requires-admin` and a legacy row with no
    // owner stays admin-only. The stamp used to be inert on this path —
    // the tier answered first and refused everyone but an admin, so a
    // non-admin's own workflow was uneditable the moment it was created.
    // The rung itself is in `src/runtime/workflow-scope.ts`, which this
    // route reaches only through `$lib/server/workflow-access` — naming
    // the ladder's own functions here is a grep-contract violation, not
    // a style preference (`workflow-route-ladder.server.test.ts`).
    //
    // Choosing `system` is still admin-only, and is refused above by
    // `denyVisibilityOr` — the tier a create DEFAULTS to and the tier a
    // caller may NAME are different questions.
    workflow = await workflowQueries.createWorkflow(body as WorkflowDefinition, {
      userId: user.id,
      visibility: body.visibility,
    });
  } catch (err) {
    // `name` is globally unique on purpose (ownership authorizes, it does
    // not namespace), so a duplicate is an ordinary, expected outcome —
    // a 409 with the offending name, not the 500 the bare index produced.
    if (err instanceof workflowQueries.WorkflowNameConflictError) {
      return errorJson(409, err.message, { name: err.workflowName });
    }
    throw err;
  }
  // Version 1. Minted here rather than inside `createWorkflow` so the
  // query layer stays a plain writer and every version in the table was
  // written by the same function.
  await ensureWorkflowVersion(workflow, user.id);
  await reloadWorkflows();

  return json(workflow, { status: 201 });
};
