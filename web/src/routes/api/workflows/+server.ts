import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as workflowQueries from "$server/db/queries/workflows";
import { getWorkflows, reloadWorkflows } from "$lib/server/context";
import { validateWorkflow } from "$server/runtime/workflow-validator";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import type { WorkflowDefinition } from "$server/types";

// Boundary validation. POST forwards the parsed body to createWorkflow
// (which reads name/description/inputSchema/steps). The zod schema only
// pins shape (loose on step interiors — the three kinds carry different
// fields); the shared `validateWorkflow` enforces the semantic rules and
// drives the 400 message.
const workflowStepSchema = z
  .object({
    name: z.string().optional(),
    kind: z.enum(["agent", "transform", "gate"]).optional(),
    agent: z.string().optional(),
    input: z.record(z.string(), z.string()).optional(),
    retries: z.number().optional(),
    output: z.record(z.string(), z.string()).optional(),
    condition: z.unknown().optional(),
    dependsOn: z.array(z.string()).optional(),
    loop: z.unknown().optional(),
  })
  .loose();

const postBodySchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    steps: z.array(workflowStepSchema).optional(),
  })
  .strict();

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  return json(getWorkflows());
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
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

  const workflow = await workflowQueries.createWorkflow(body as WorkflowDefinition);
  await reloadWorkflows();

  return json(workflow, { status: 201 });
};
