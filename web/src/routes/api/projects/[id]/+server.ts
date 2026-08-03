import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

/**
 * Authorization model for projects: ROLE-based, because nothing else is
 * expressible today.
 *
 * `projects` (`src/db/schema.ts:24-32`) has no owner column — no `userId`,
 * no `createdBy` — and there is no `project_members` table. Nothing records
 * who created a project, so "let the owner mutate it" cannot be written.
 * `src/runtime/workflow-scope.ts:173-181` documents the same conclusion from
 * the other direction: the platform "has no project-membership model", and
 * `GET /api/projects` (`../+server.ts:25`) returns every project to every
 * authenticated caller unfiltered.
 *
 * Until a membership/ownership model lands this is a PRODUCT GAP, not a
 * design. PUT and DELETE previously ran with no authorization at all past
 * `requireAuth`, so any authenticated principal could destroy any project by
 * id — or silently repoint its `path`, which drives filesystem scoping. The
 * narrowest safe rule that is expressible now is: mutating an instance-global
 * object is an admin action.
 *
 * Consequence to weigh when the model lands: a non-admin can no longer rename
 * or delete a project from the project-settings page
 * (`web/src/routes/(app)/project/[id]/settings/+page.svelte`). That is a
 * deliberate narrowing, not an oversight — the alternative is leaving every
 * project destroyable by every account.
 *
 * 403, not the 404 used by the sec-H3 routes: those collapse denial into
 * "not found" to avoid an id-existence oracle. Projects have no existence to
 * hide — GET and the list route are deliberately unfiltered and unchanged
 * here — so a 404 would be theatre and would misreport a project that plainly
 * exists.
 */
function requireAdmin(user: { role: string }): Response | null {
  return user.role === "admin" ? null : errorJson(403, "Forbidden");
}

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
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;
  const parsed = updateProjectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "Invalid request body");
  }
  const updated = await projectQueries.updateProject(params.id, parsed.data);
  if (!updated) return errorJson(404, "Not found");
  return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const adminErr = requireAdmin(user);
  if (adminErr) return adminErr;
  const deleted = await projectQueries.deleteProject(params.id);
  if (!deleted) return errorJson(404, "Not found");
  return json({ ok: true });
};
