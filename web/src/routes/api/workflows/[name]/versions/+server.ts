import { json } from "@sveltejs/kit";
import { getWorkflowByName } from "$server/db/queries/workflows";
import { listWorkflowVersions } from "$server/db/queries/workflow-versions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveWorkflowOr } from "$lib/server/workflow-access";
import type { RequestHandler } from "./$types";

/**
 * Version history for a workflow.
 *
 * Gated on `read` through the same resolver as everything else — history
 * is as sensitive as the definition it describes, and an unauthorized
 * caller gets the same 404 rather than a list that confirms the workflow
 * exists.
 *
 * A YAML or extension workflow has no row and therefore no versions;
 * it returns an empty array rather than a 404, because "this workflow has
 * no version history" is a true and useful answer, not a missing resource.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const resolved = resolveWorkflowOr(user, params.name, "read");
  if (resolved instanceof Response) return resolved;

  const dbWorkflow = await getWorkflowByName(params.name);
  if (!dbWorkflow) return json([]);

  const versions = await listWorkflowVersions(dbWorkflow.id);
  // `steps` is deliberately omitted from the LIST projection — a history
  // panel renders labels, and shipping every snapshot's full graph would
  // make the response grow without bound as a workflow is edited.
  return json(
    versions.map((v) => ({
      id: v.id,
      version: v.version,
      name: v.name,
      description: v.description,
      stepsHash: v.stepsHash,
      stepCount: v.steps.length,
      createdByUserId: v.createdByUserId,
      createdAt: v.createdAt,
    })),
  );
};
