import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as workflowQueries from "$server/db/queries/workflows";
import { reloadWorkflows } from "$lib/server/context";
import { requireScope } from "$lib/server/security/api-keys";
import { requireAdmin } from "$lib/server/security/api-keys";
import { requireAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import type { RequestHandler } from "./$types";

const claimBodySchema = z
  .object({
    userId: z.string().min(1),
    projectId: z.string().nullable().optional(),
  })
  .strict();

/**
 * Assign an owner to a `system` workflow.
 *
 * ## Why this route exists
 *
 * The ownership migration makes every pre-existing row `system`, and
 * `system` is admin-only to edit. So on upgrade, a non-admin loses the
 * ability to edit workflows they created. That is the correct end state
 * but a silent capability removal, and it needs a remedy.
 *
 * The remedy is NOT to infer ownership — the obvious inference,
 * "whoever's `workflow_runs.user_id` appears against this workflow owns
 * it", is a guess, and guessing ownership is how you hand someone's
 * workflow to the wrong person. An admin states the owner explicitly
 * instead: deliberate, audited (below), and reversible by claiming again.
 *
 * Admin-gated on BOTH axes — `requireAdmin` checks the principal's role
 * (a cookie session's true role, an API key's owner-clamped role) and
 * `requireScope("admin")` checks the key's scope. Either alone is a known
 * footgun; see `requireAdmin`'s own doc.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "admin");
  if (scopeErr) return scopeErr;
  const adminErr = requireAdmin(locals);
  if (adminErr) return adminErr;
  const actor = requireAuth(locals);

  const parsed = claimBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "userId is required");

  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be claimed)");

  const claimed = await workflowQueries.claimWorkflow(
    dbWorkflow.id,
    parsed.data.userId,
    parsed.data.projectId ?? null,
  );
  if (!claimed) return errorJson(404, "Not found");

  // Audited because this is the one action that MOVES ownership. The
  // before-values are recorded alongside the after-values so a mistaken
  // claim can be read back and undone.
  await insertAuditEntry(actor.id, "workflow.claim", dbWorkflow.id, {
    workflowName: dbWorkflow.name,
    previousVisibility: dbWorkflow.visibility,
    previousUserId: dbWorkflow.userId,
    previousProjectId: dbWorkflow.projectId,
    newUserId: parsed.data.userId,
    newProjectId: parsed.data.projectId ?? null,
  });

  await reloadWorkflows();
  return json(claimed);
};
