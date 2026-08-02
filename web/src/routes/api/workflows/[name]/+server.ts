import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as workflowQueries from "$server/db/queries/workflows";
import { reloadWorkflows } from "$lib/server/context";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { validateWorkflow } from "$server/runtime/workflow-validator";
import { validateModelOverride } from "$server/runtime/workflow-model";
import { requireAuth } from "$server/auth/middleware";
import { canActOnWorkflow } from "$server/runtime/workflow-authz";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveWorkflowOr, toWire } from "$lib/server/workflow-access";
import { withCanManage } from "$lib/server/workflow-can-manage";
import type { RequestHandler } from "./$types";
import type { WorkflowDefinition } from "$server/types";
import { workflowBodySchema } from "../schema";

// Boundary validation for workflow update. The update is partial —
// `updateWorkflow` reads only name/description/inputSchema/steps and
// merges. The shared `workflowBodySchema` (`.strict()`) rejects unknown
// top-level fields; the 400 "Invalid request body" surfaces malformed
// bodies while existing 404 branches drive their messages downstream. When
// `steps` are supplied they are re-validated (definition-time rules).
//
// Authorization is NOT performed here. Every handler below resolves
// through `resolveWorkflowOr`, which does the lookup and the ladder
// together — see `lib/server/workflow-access.ts` for why a route
// physically cannot do this itself. That ladder is THE gate.
//
// PUT and DELETE additionally run upstream's owner-or-admin rule
// (`canActOnWorkflow`) on the resolved row. It is redundant as of this
// merge — it reads `created_by`, which nothing writes — and is collapsed
// into the ladder in the follow-up commit. Left in place here so this
// merge changes no security behaviour in either direction.
//
// Note the `.strict()` body schema has no `source` key on purpose: `source`
// is server-derived provenance served by GET, never accepted on a write.

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const resolved = resolveWorkflowOr(user, params.name, "read", url.searchParams.get("projectId"));
  if (resolved instanceof Response) return resolved;
  // The ladder decides visibility; `withCanManage` then stamps the same
  // `canManage` shape the list serves, so a workflow does not gain or lose
  // the field depending on which route returned it. `toWire` already
  // carries the ladder's own `canEdit` — the two answer the same question
  // and are collapsed in the follow-up commit.
  const [decorated] = await withCanManage([toWire(resolved.entry, resolved.caller)], user);
  return json(decorated);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parsed = workflowBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  // `defaultModel` is checked on its own rather than through
  // `validateWorkflow`, because THIS route is a partial update: a body
  // carrying only `defaultModel` has no `steps` to hand the whole-definition
  // validator, which would then reject it for the missing step list. Same
  // shared function `validateWorkflow` delegates to, so there is still
  // exactly one definition of what a model binding may say.
  if (parsed.data.defaultModel !== undefined) {
    const modelErrors = validateModelOverride(parsed.data.defaultModel, 'Workflow "defaultModel"');
    if (modelErrors.length > 0) return errorJson(400, modelErrors[0]!);
  }
  // Re-validate step-level rules when steps are being replaced.
  if (Array.isArray(parsed.data.steps)) {
    const errors = validateWorkflow({
      name: parsed.data.name ?? params.name,
      description: parsed.data.description ?? "",
      steps: parsed.data.steps,
    } as WorkflowDefinition);
    if (errors.length > 0) return errorJson(400, errors[0]!);
  }

  const resolved = resolveWorkflowOr(user, params.name, "edit");
  if (resolved instanceof Response) return resolved;
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be updated)");
  if (!canActOnWorkflow(dbWorkflow.createdBy, user)) {
    return errorJson(403, "Only the workflow's owner or an admin can update it");
  }

  let updated: workflowQueries.DbWorkflow | undefined;
  try {
    updated = await workflowQueries.updateWorkflow(
      dbWorkflow.id,
      parsed.data as Partial<WorkflowDefinition>,
    );
  } catch (err) {
    // A rename onto a taken name. Unreachable before the editor existed —
    // nothing renamed a workflow — which is why it used to surface as an
    // unhandled 500 from the unique index.
    if (err instanceof workflowQueries.WorkflowNameConflictError) {
      return errorJson(409, err.message, { name: err.workflowName });
    }
    throw err;
  }
  if (!updated) return errorJson(404, "Not found");

  // Mints a version ONLY if the executable content actually changed. A
  // description-only edit (or a rename) returns the existing version, so
  // C3's consent hash is not invalidated by prose — see
  // `ensureWorkflowVersion`.
  const { version, minted } = await ensureWorkflowVersion(updated, user.id);
  await reloadWorkflows();
  return json({ ...updated, version: version.version, versionMinted: minted });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const resolved = resolveWorkflowOr(user, params.name, "edit");
  if (resolved instanceof Response) return resolved;
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be deleted)");
  if (!canActOnWorkflow(dbWorkflow.createdBy, user)) {
    return errorJson(403, "Only the workflow's owner or an admin can delete it");
  }

  await workflowQueries.deleteWorkflow(dbWorkflow.id);
  await reloadWorkflows();
  return json({ ok: true });
};
