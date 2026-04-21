import { json } from "@sveltejs/kit";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  return json(await projectQueries.listProjects());
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const body = (await request.json()) as {
    name: string;
    path: string;
    icon?: string | null;
    variables?: Record<string, unknown>;
  };
  if (!body.name || !body.path) {
    return json({ error: "name and path required" }, { status: 400 });
  }
  return json(await projectQueries.createProject(body), { status: 201 });
};
