import { json } from "@sveltejs/kit";
import { listPendingWorkflowApprovalsForUser } from "$server/db/queries/workflow-approvals";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

/**
 * The approvals inbox: pending decisions this caller may act on.
 *
 * Scoped by the QUERY, not here — an approval has no owner of its own, so
 * the scoping is a join against the run's `user_id` and belongs with the
 * SQL. The unscoped `listPendingWorkflowApprovals` exists for the expiry
 * sweep and must never back a per-user surface: an approval's prompt
 * routinely names what is about to be done and to what.
 *
 * `read` scope, not `chat`: this lists decisions, it does not make any.
 * Answering goes through POST /api/workflows/approvals/:id.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const pending = await listPendingWorkflowApprovalsForUser(user.id, user.role === "admin");
  return json({
    approvals: pending.map((p) => ({
      id: p.approval.id,
      workflowRunId: p.workflowRunId,
      workflowName: p.workflowName,
      stepName: p.approval.stepName,
      prompt: p.approval.prompt,
      choices: p.approval.choices,
      requireItemConsent: p.approval.requireItemConsent,
      itemIds: p.approval.itemIds,
      formSchema: p.approval.formSchema,
      expiresAt: p.approval.expiresAt,
      createdAt: p.approval.createdAt,
    })),
  });
};
