import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import * as projectQueries from "$server/db/queries/projects";
import * as featureQueries from "$server/db/queries/features";
import { createFeatureSchema } from "./schema";
import type { RequestHandler } from "./$types";

/**
 * Feature Index — list + create endpoints.
 *
 * GET  /api/projects/:id/features         → list every feature for the
 *                                            project, with file counts
 * POST /api/projects/:id/features         → create a user-sourced feature
 *
 * The scan endpoint (POST .../features/scan) and per-feature
 * PATCH/DELETE endpoints live in sibling files; see the design doc §5
 * for the full surface (docs/plans/2026-05-01-feature-index-design.md).
 *
 * Auth: every endpoint requires `read` scope + an authenticated user.
 * Mutating endpoints additionally require `chat` scope (matches the
 * convention from neighboring /api/modes routes — `chat` is the
 * write-capable scope band for app-level resources).
 */

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const project = await projectQueries.getProject(params.id);
  if (!project) return errorJson(404, "Project not found");

  const features = await featureQueries.listFeatures(params.id);
  return json(features);
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const project = await projectQueries.getProject(params.id);
  if (!project) return errorJson(404, "Project not found");

  const result = createFeatureSchema.safeParse(await request.json().catch(() => ({})));
  if (!result.success) return validationError(result.error);

  // Slug uniqueness is per-project (UNIQUE(project_id, name) on the
  // table). Surface a 409 on collision so the UI can show "name
  // already taken" rather than a generic 500.
  const existing = await featureQueries.getFeature(params.id, result.data.name);
  if (existing) return errorJson(409, "Feature with this name already exists");

  const created = await featureQueries.createFeature({
    projectId: params.id,
    name: result.data.name,
    description: result.data.description,
    source: "user",
  });
  // Echo the same shape as listFeatures (with fileCount=0) so the UI
  // doesn't need to re-fetch.
  return json({ ...created, fileCount: 0 }, { status: 201 });
};
