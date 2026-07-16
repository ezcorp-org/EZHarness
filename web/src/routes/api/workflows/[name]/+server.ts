import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as workflowQueries from "$server/db/queries/workflows";
import { getWorkflows, reloadWorkflows } from "$lib/server/context";
import { validateWorkflow } from "$server/runtime/workflow-validator";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";
import type { WorkflowDefinition } from "$server/types";
import { workflowBodySchema } from "../schema";

// Boundary validation for workflow update. The update is partial —
// `updateWorkflow` reads only name/description/inputSchema/steps and
// merges. The shared `workflowBodySchema` (`.strict()`) rejects unknown
// top-level fields; the 400 "Invalid request body" surfaces malformed
// bodies while existing 404 branches drive their messages downstream. When
// `steps` are supplied they are re-validated (definition-time rules).

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const workflow = getWorkflows().find((w) => w.name === params.name);
  if (!workflow) return errorJson(404, "Not found");
  return json(workflow);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const parsed = workflowBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
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
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be updated)");

  const updated = await workflowQueries.updateWorkflow(
    dbWorkflow.id,
    parsed.data as Partial<WorkflowDefinition>,
  );
  if (!updated) return errorJson(404, "Not found");

  await reloadWorkflows();
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const dbWorkflow = await workflowQueries.getWorkflowByName(params.name);
  if (!dbWorkflow) return errorJson(404, "Not found (only DB workflows can be deleted)");

  await workflowQueries.deleteWorkflow(dbWorkflow.id);
  await reloadWorkflows();
  return json({ ok: true });
};
