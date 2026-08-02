import { json } from "@sveltejs/kit";
import { resumeParkedRun } from "$server/runtime/workflow-run-control";
import { workflowRefusalStatus } from "$server/runtime/workflow-refusal-status";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary only. Ownership, state and the consent guard all live behind
// `resumeParkedRun` — this route re-derives none of them, for the same
// reason the approvals route re-derives none of `answerApproval`'s.
//
// This is NOT an approval-answering surface: it takes no choice and cannot
// clear a pending consent gate. A run parked on an unanswered approval
// comes back `resume-failed` and stays answerable.

export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const result = await resumeParkedRun(params.id, {
    userId: user.id,
    isAdmin: user.role === "admin",
  });

  if (!result.ok) return errorJson(workflowRefusalStatus(result.code), result.message);
  return json({ run: "run" in result ? result.run : undefined });
};
