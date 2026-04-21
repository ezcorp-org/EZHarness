import { json } from "@sveltejs/kit";
import * as pipelineQueries from "$server/db/queries/pipelines";
import { getPipelines, reloadPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

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
  const body = await request.json();
  if (!body.name || !Array.isArray(body.steps) || body.steps.length === 0) {
    return json({ error: "name and steps required" }, { status: 400 });
  }

  const pipeline = await pipelineQueries.createPipeline(body);
  await reloadPipelines();

  return json(pipeline, { status: 201 });
};
