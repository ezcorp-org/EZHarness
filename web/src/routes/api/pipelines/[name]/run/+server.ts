import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getPipelineExecutor, getPipelines } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation. POST splits `projectId` off the body; every other
// field flows verbatim to the pipeline executor as user-supplied input.
// `.loose()` is genuinely needed here because the input shape is driven
// by the pipeline definition, not this handler — extras must flow
// through, not be stripped. (`.passthrough()` is deprecated in Zod v4.)
const postBodySchema = z.object({
  projectId: z.string().optional(),
}).loose();

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const pipeline = getPipelines().find((p) => p.name === params.name);
  if (!pipeline) return errorJson(404, "Pipeline not found");

  try {
    const parsed = postBodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return errorJson(400, "Invalid request body");
    }
    const { projectId, ...input } = parsed.data;
    const pipelineExec = getPipelineExecutor();
    const run = await pipelineExec.runPipeline(
      pipeline,
      input,
      typeof projectId === "string" ? projectId : undefined,
      user.id,
    );
    return json(run);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorJson(400, message);
  }
};
