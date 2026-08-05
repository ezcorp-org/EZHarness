import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveWorkflowOr } from "$lib/server/workflow-access";
import { dryRunWorkflow } from "$server/runtime/workflow-dry-run";
import { validateWorkflow } from "$server/runtime/workflow-validator";
import { workflowBodySchema } from "../../schema";
import type { RequestHandler } from "./$types";
import type { WorkflowDefinition } from "$server/types";

// `input` is the workflow's own input map, so it must pass through
// verbatim (`.loose()`, same rationale as the run route). `definition` is
// the OPTIONAL unsaved draft the editor is holding — dry-running what is
// on screen is the entire point, and requiring a save first would make
// the feature useless for the edit-check-edit loop it exists to serve.
const dryRunBodySchema = z
  .object({
    input: z.record(z.string(), z.unknown()).optional(),
    projectId: z.string().optional(),
    definition: workflowBodySchema.optional(),
  })
  .strict();

/**
 * Simulate a run: evaluate `transform` and `gate` steps for real, stand a
 * stub in for everything else, and touch nothing outside this process.
 *
 * Authorized for `run`, not `read` — a dry run consumes no LLM and writes
 * no row, but it does execute the caller's graph logic, and letting
 * someone simulate a workflow they may not run would be an odd place to
 * draw the line. The `run` check is also what C3 will narrow.
 *
 * Zero side effects is structural, not conventional: see
 * `src/runtime/workflow-dry-run.ts` for the three guarantees.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = dryRunBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid request body");
  const { input = {}, projectId, definition: draft } = parsed.data;

  const resolved = await resolveWorkflowOr(user, params.name, "run", projectId ?? null);
  if (resolved instanceof Response) return resolved;

  // A draft replaces the saved graph but NOT the authorization: the
  // caller still had to be allowed to run the workflow they are editing.
  const definition = (
    draft ? { ...draft, name: draft.name ?? params.name, description: draft.description ?? "" } : resolved.entry.definition
  ) as WorkflowDefinition;

  // The same shared validator the create/update routes use — a draft that
  // could not be saved should not be dry-runnable either, or the editor
  // would report a green dry run for a graph the save then rejects.
  const errors = validateWorkflow(definition);
  if (errors.length > 0) return errorJson(400, errors[0]!);

  return json(await dryRunWorkflow(definition, input));
};
