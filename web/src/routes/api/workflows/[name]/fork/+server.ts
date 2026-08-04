import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as workflowQueries from "$server/db/queries/workflows";
import { listWorkflows } from "$server/db/queries/workflows";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { reloadWorkflows } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { resolveWorkflowOr } from "$lib/server/workflow-access";
import { pickForkName } from "$server/runtime/workflow-fork";
import type { RequestHandler } from "./$types";

// `projectId` is taken from the BODY, not from any server-side "active
// project" — there isn't one. The active project lives in the client
// store (`stores.svelte.ts`) and every route that needs it is told
// explicitly, exactly like `POST …/run`.
const forkBodySchema = z
  .object({
    projectId: z.string().optional(),
  })
  .strict();

/**
 * Clone a workflow the caller can READ into an editable, project-scoped
 * row they own.
 *
 * Authorized for `read`, not `edit`: forking a workflow you may look at
 * is the whole point — it gives you your own copy and leaves the original
 * untouched. The new row is always `visibility: "project"` with the
 * caller as `user_id`, so a fork never widens the source's audience.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = forkBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid request body");
  const projectId = parsed.data.projectId ?? null;

  const resolved = await resolveWorkflowOr(user, params.name, "read", projectId);
  if (resolved instanceof Response) return resolved;
  const source = resolved.entry.definition;

  const taken = new Set((await listWorkflows()).map((w) => w.name));
  let name: string;
  try {
    name = pickForkName(source.name, (candidate) => taken.has(candidate));
  } catch (err) {
    return errorJson(409, err instanceof Error ? err.message : String(err));
  }

  let created: workflowQueries.DbWorkflow;
  try {
    created = await workflowQueries.createWorkflow(
      {
        name,
        description: source.description,
        ...(source.inputSchema !== undefined ? { inputSchema: source.inputSchema } : {}),
        ...(source.defaultModel !== undefined ? { defaultModel: source.defaultModel } : {}),
        steps: source.steps,
      },
      {
        visibility: "project",
        projectId,
        userId: user.id,
        // The source's FULLY QUALIFIED name as a string snapshot, never an
        // FK: the source is often an extension asset with no row, and the
        // extension may be uninstalled later. A fork of a fork records its
        // immediate parent, with no chain walking.
        forkedFrom: source.name,
      },
    );
  } catch (err) {
    // The `taken` set was read before the insert, so a concurrent create
    // can still win the name. Reported as a 409 rather than a 500.
    if (err instanceof workflowQueries.WorkflowNameConflictError) {
      return errorJson(409, err.message, { name: err.workflowName });
    }
    throw err;
  }

  await ensureWorkflowVersion(created, user.id);
  await reloadWorkflows();
  return json({ name: created.name, id: created.id, forkedFrom: source.name }, { status: 201 });
};
