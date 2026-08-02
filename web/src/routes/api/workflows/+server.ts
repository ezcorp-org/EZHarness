import { json } from "@sveltejs/kit";
import * as workflowQueries from "$server/db/queries/workflows";
import { reloadWorkflows } from "$lib/server/context";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { validateWorkflow } from "$server/runtime/workflow-validator";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { listVisibleWorkflows } from "$lib/server/workflow-access";
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
  return json(listVisibleWorkflows(user, url.searchParams.get("projectId")));
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
  const errors = validateWorkflow(body as WorkflowDefinition);
  if (errors.length > 0) {
    return errorJson(400, errors[0]!);
  }

  let workflow: workflowQueries.DbWorkflow;
  try {
    // Ownership is NOT stamped here. A workflow created through this
    // route is `system`, exactly as every row created before C6 was —
    // scoping arrives deliberately, through fork (which sets a project)
    // or the admin claim action, never as a silent side effect of an
    // ordinary create.
    //
    // This deliberately SUPERSEDES upstream's `createWorkflow(body,
    // user.id)`, which stamped the caller as author on every create. The
    // two cannot both hold: that rule makes an ordinary create
    // owner-scoped, which is the exact silent side effect C6 ruled out.
    //
    // KNOWN CONSEQUENCE: a `system` row is admin-only to EDIT
    // (`workflow-scope.ts`), so a non-admin who creates a workflow here
    // cannot subsequently edit or delete it — `canEdit` is false and the
    // page hides both affordances. That is the ladder answering
    // consistently on the button and the endpoint, not a UI bug; the way
    // to get an editable copy is Fork, which stamps ownership. Granting
    // edit on `system` to its creator would need a real creator column,
    // which is exactly what was just removed.
    workflow = await workflowQueries.createWorkflow(body as WorkflowDefinition);
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
