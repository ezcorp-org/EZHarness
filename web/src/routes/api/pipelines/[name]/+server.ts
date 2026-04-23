import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import * as pipelineQueries from "$server/db/queries/pipelines";
import { getPipelines, reloadPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

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
  const body = await request.json();
  const dbPipeline = await pipelineQueries.getPipelineByName(params.name);
  if (!dbPipeline) return errorJson(404, "Not found (only DB pipelines can be updated)");

  const updated = await pipelineQueries.updatePipeline(dbPipeline.id, body);
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
