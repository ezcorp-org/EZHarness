import { json } from "@sveltejs/kit";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

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
  const body = (await request.json()) as Partial<{
    name: string;
    path: string;
    icon: string | null;
    variables: Record<string, unknown>;
  }>;
  const updated = await projectQueries.updateProject(params.id, body);
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
