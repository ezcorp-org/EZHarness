import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as projectQueries from "$server/db/queries/projects";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { projectPathSchema } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Boundary validation for project creation. The handler reads
// `name`/`path`/`icon`/`variables` off the body. The existing 400
// "name and path required" message is preserved verbatim — schema
// accepts empty strings so the inline emptiness check still fires
// (test asserts `body.error` contains "required").
const createProjectSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    icon: z.string().nullable().optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * The list is INSTANCE-GLOBAL and deliberately unfiltered, even though
 * `project_members` now exists.
 *
 * Filtering here is not a one-line change, it is a data-migration decision.
 * `migrate()` attributes every project that predates the membership table to
 * the FIRST ADMIN (the same rule the ownerless `conversations` / `memories`
 * backfills use), so a membership filter would hand every non-admin on an
 * upgraded instance an empty project list — the app's entry surface — while
 * looking like a tightening. The `global` project, which is a seeded
 * instance singleton every agent conversation without a project falls back
 * to, would disappear the same way.
 *
 * So mutation is narrowed to members (`[id]/+server.ts`) and reading is not.
 * The asymmetry is recorded rather than hidden, and it is pinned in
 * `src/__tests__/security/cross-tenant-deletion-projects-kb-modes.test.ts`
 * so that closing it is a deliberate act with a test to update, not a
 * silent drift.
 */
export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  return json(await projectQueries.listProjects());
};

export const POST: RequestHandler = async ({ request, locals }) => {
  const scopeErr = requireScope(locals, "write");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const parsed = createProjectSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "name and path required");
  }
  const body = parsed.data;
  if (!body.name || !body.path) {
    return errorJson(400, "name and path required");
  }
  // Emptiness is answered above with the verbatim legacy message; SHAPE is a
  // separate, more specific 400 so the form can tell the user what to fix.
  const path = projectPathSchema.safeParse(body.path);
  if (!path.success) {
    return errorJson(400, path.error.issues[0]?.message ?? "Invalid project path");
  }
  // The creator IS the project's first owner. Without this stamp the
  // membership table would have no writer on the ordinary path, `owner`
  // would be reachable only through the migration backfill, and PR #82's
  // real breakage — a member who cannot rename the project they just made —
  // would survive the model that exists to fix it.
  return json(await projectQueries.createProject(body, user.id), { status: 201 });
};
