import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation for project update. The handler accepts a
// partial of the same fields the POST handler uses. `.strict()`
// rejects unknown fields — `updateProject` only reads these four.
const updateProjectSchema = z.object({
  name: z.string().optional(),
  path: z.string().optional(),
  icon: z.string().nullable().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const project = await projectQueries.getProject(params.id);
  if (!project) return errorJson(404, "Not found");
  return json(project);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const parsed = updateProjectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const updated = await projectQueries.updateProject(params.id, parsed.data);
  if (!updated) return errorJson(404, "Not found");
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const deleted = await projectQueries.deleteProject(params.id);
  if (!deleted) return errorJson(404, "Not found");
  return json({ ok: true });
};
