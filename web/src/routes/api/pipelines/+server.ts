import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as pipelineQueries from "$server/db/queries/pipelines";
import { getPipelines, reloadPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import type { PipelineDefinition } from "$server/types";

// Boundary validation. POST forwards the parsed body directly to
// createPipeline (which reads name/description/inputSchema/steps).
// Schema only pins shape — the existing emptiness check still drives
// the "name and steps required" 400 message verbatim.
const pipelineStepSchema = z.object({
  name: z.string().optional(),
  agent: z.string().optional(),
  input: z.record(z.string(), z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
}).strict();

const postBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(pipelineStepSchema).optional(),
}).strict();

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  return json(getPipelines());
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

  const pipeline = await pipelineQueries.createPipeline(body as PipelineDefinition);
  await reloadPipelines();

  return json(pipeline, { status: 201 });
};
