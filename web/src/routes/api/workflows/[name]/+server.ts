import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as workflowQueries from "$server/db/queries/workflows";
import { reloadWorkflows } from "$lib/server/context";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { validateOutputTemplate } from "$server/runtime/workflow-validator";
import { validateModelOverride } from "$server/runtime/workflow-model";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { denyVisibilityOr, resolveWorkflowOr, toWire, validateWorkflowForCaller } from "$lib/server/workflow-access";
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
// Note the `.strict()` body schema has no `source` key on purpose: `source`
// is server-derived provenance served by GET, never accepted on a write.
//
// ── Why PUT and DELETE are audited ────────────────────────────────────
//
// A `system` workflow is runnable by EVERY principal on the instance,
// including the userless CLI, and its owner may now rewrite or delete it
// with no admin in the loop. Nothing else records that:
//
//   - `ensureWorkflowVersion` mints a version ONLY when the executable
//     content changes, so a description-only edit (or a rename) leaves no
//     row anywhere — that is the gap these entries close, and it has its
//     own named test.
//   - DELETE left no trace at all: the row is gone and the versions go
//     with it.
//
// Both entries are written AFTER the mutation succeeds, so the log records
// what happened rather than what was attempted — a refused write (the
// ladder's 403, or a 404) audits nothing.
//
// **An audit failure is deliberately NON-FATAL, and this route does not
// implement that itself.** `insertAuditEntry` is the single chokepoint
// (`src/db/queries/audit-log.ts`): it catches its own insert failure,
// routes it to `persistError` so an admin can see the hiccup, and
// resolves `""`. So the bare `await` below cannot abort the request. A
// local try/catch here would be a SECOND copy of that policy, and worse:
// it would silently absorb the day the chokepoint's contract changes.
// The invariant is pinned where it lives, by "a failed audit write
// resolves instead of throwing, so it can never abort its caller" in
// `src/__tests__/audit-log.test.ts`.

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const resolved = await resolveWorkflowOr(user, params.name, "read", url.searchParams.get("projectId"));
  if (resolved instanceof Response) return resolved;
  // `toWire` carries the ladder's own `canEdit`, so the detail route serves
  // exactly the shape the list does — a workflow must not gain or lose a
  // field depending on which route returned it.
  return json(toWire(resolved.entry, resolved.caller));
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
  // Same rationale, same shared function `validateWorkflow` delegates to
  // internally: a malformed `outputTemplate` must be a clean 400 here too,
  // never a silent write that renders empty forever at run time.
  if (parsed.data.outputTemplate !== undefined) {
    const templateErrors = validateOutputTemplate(parsed.data.outputTemplate);
    if (templateErrors.length > 0) return errorJson(400, templateErrors[0]!);
  }
  // Re-validate step-level rules when steps are being replaced.
  if (Array.isArray(parsed.data.steps)) {
    const errors = await validateWorkflowForCaller(user, {
      name: parsed.data.name ?? params.name,
      description: parsed.data.description ?? "",
      steps: parsed.data.steps,
    } as WorkflowDefinition);
    if (errors.length > 0) return errorJson(400, errors[0]!);
  }

  const resolved = await resolveWorkflowOr(user, params.name, "edit");
  if (resolved instanceof Response) return resolved;
  // Re-classification. Checked AFTER the `edit` gate on purpose: that gate
  // is what makes this safe to allow at all, because for `project` and
  // `private` it already demands the caller be the owner (or an admin), so
  // no caller can re-classify a workflow that is not theirs. What is left
  // for this check is the one value the edit gate does not imply —
  // promoting into `system`, which stays admin-only. Same adapter the
  // create route uses; a second rule here would be a rule to keep in sync.
  const visibilityDenial = denyVisibilityOr(user, parsed.data.visibility);
  if (visibilityDenial) return visibilityDenial;
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be updated)");

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
  // The before-values come off `dbWorkflow` (the row as it stood) so a
  // mistaken edit can be read back against what it replaced, mirroring
  // the claim route. `versionMinted: false` is the case that motivated
  // this entry: no version was cut, so this row is the only record.
  // Field NAMES, not values — the values are already in the version when
  // there is one, and dumping a whole step graph into `metadata` would
  // bury the trail it is supposed to be.
  await insertAuditEntry(user.id, "workflow.update", dbWorkflow.id, {
    workflowName: dbWorkflow.name,
    newName: updated.name,
    previousVisibility: dbWorkflow.visibility,
    previousUserId: dbWorkflow.userId,
    previousProjectId: dbWorkflow.projectId,
    fields: Object.keys(parsed.data).sort(),
    version: version.version,
    versionMinted: minted,
  });
  await reloadWorkflows();
  return json({ ...updated, version: version.version, versionMinted: minted });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const resolved = await resolveWorkflowOr(user, params.name, "edit");
  if (resolved instanceof Response) return resolved;
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be deleted)");

  await workflowQueries.deleteWorkflow(dbWorkflow.id);
  // The only surviving record of the row. `target` is the id of a row
  // that no longer exists, which is the point — it is what correlates
  // this entry with the `workflow.update` entries that preceded it.
  // `stepCount` so the entry says how much was destroyed without
  // embedding the graph.
  await insertAuditEntry(user.id, "workflow.delete", dbWorkflow.id, {
    workflowName: dbWorkflow.name,
    previousVisibility: dbWorkflow.visibility,
    previousUserId: dbWorkflow.userId,
    previousProjectId: dbWorkflow.projectId,
    stepCount: Array.isArray(dbWorkflow.steps) ? dbWorkflow.steps.length : null,
  });
  await reloadWorkflows();
  return json({ ok: true });
};
