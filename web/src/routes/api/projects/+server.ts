import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation for project creation. The handler reads
// `name`/`path`/`icon`/`variables` off the body. The existing 400
// "name and path required" message is preserved verbatim — schema
// accepts empty strings so the inline emptiness check still fires
// (test asserts `body.error` contains "required").
const createProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  icon: z.string().nullable().optional(),
  variables: z.record(z.string(), z.unknown()).optional(),
}).strict();

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
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "name and path required");
  }
  const body = parsed.data;
  if (!body.name || !body.path) {
    return errorJson(400, "name and path required");
  }
  return json(await projectQueries.createProject(body), { status: 201 });
};
