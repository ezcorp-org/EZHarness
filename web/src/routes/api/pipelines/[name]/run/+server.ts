import { json } from "@sveltejs/kit";
import { getPipelineExecutor, getPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const pipeline = getPipelines().find((p) => p.name === params.name);
  if (!pipeline) return json({ error: "Pipeline not found" }, { status: 404 });

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const { projectId, ...input } = body;
    const pipelineExec = getPipelineExecutor();
    const run = await pipelineExec.runPipeline(
      pipeline,
      input,
      typeof projectId === "string" ? projectId : undefined,
    );
    return json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, { status: 400 });
  }
};
