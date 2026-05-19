import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import * as pipelineQueries from "$server/db/queries/pipelines";
import { getPipelines, reloadPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";
import type { PipelineDefinition } from "$server/types";

// Boundary validation for pipeline update. The update is partial —
// `updatePipeline` reads only name/description/inputSchema/steps and
// merges. `.strict()` rejects unknown top-level fields. The 400
// "Invalid request body" surfaces malformed bodies; existing 404
// branches still drive their messages downstream.
const pipelineStepSchema = z.object({
  name: z.string().optional(),
  agent: z.string().optional(),
  input: z.record(z.string(), z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
}).strict();

const putBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(pipelineStepSchema).optional(),
}).strict();

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const pipeline = getPipelines().find((p) => p.name === params.name);
  if (!pipeline) return errorJson(404, "Not found");
  return json(pipeline);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const parsed = putBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const dbPipeline = await pipelineQueries.getPipelineByName(params.name);
  if (!dbPipeline) return errorJson(404, "Not found (only DB pipelines can be updated)");

  const updated = await pipelineQueries.updatePipeline(
    dbPipeline.id,
    parsed.data as Partial<PipelineDefinition>,
  );
  if (!updated) return errorJson(404, "Not found");

  await reloadPipelines();
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const dbPipeline = await pipelineQueries.getPipelineByName(params.name);
  if (!dbPipeline) return errorJson(404, "Not found (only DB pipelines can be deleted)");

  await pipelineQueries.deletePipeline(dbPipeline.id);
  await reloadPipelines();
  return json({ ok: true });
};
