import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import * as featureQueries from "$server/db/queries/features";
import { updateFeatureSchema } from "../schema";
import type { RequestHandler } from "./$types";

/**
 * Feature Index — per-feature PATCH + DELETE.
 *
 * PATCH /api/projects/:id/features/:featureId
 *   - rename, edit description, add/remove pinned files
 *   - **Source-flip policy:** any non-empty PATCH on an `agent`-sourced
 *     feature flips `features.source` to `'user'`. Subsequent rescans
 *     skip user-sourced features, so the rename / description edit
 *     survives. This policy is intentionally enforced HERE (not in the
 *     DB query layer) — see comment in src/db/queries/features.ts on
 *     `updateFeature`.
 *   - addFiles inserts as `source='user'` (idempotent via composite-PK
 *     onConflictDoNothing).
 *   - removeFiles deletes the row regardless of source — the user
 *     explicitly removed it. (The next scan may re-add it as `'scan'`
 *     unless the user also pinned a sibling that supersedes it.)
 *
 * DELETE /api/projects/:id/features/:featureId
 *   - deletes the feature; FK cascade drops every feature_files row
 *     (both 'scan' and 'user').
 *
 * Both handlers verify the feature belongs to the project named by
 * params.id (defense-in-depth: prevents a caller with one project's id
 * from PATCH-ing a different project's feature by guessing its uuid).
 */

async function loadFeatureScopedToProject(
  projectId: string,
  featureId: string,
): Promise<Awaited<ReturnType<typeof featureQueries.listFeatures>>[number] | undefined> {
  const features = await featureQueries.listFeatures(projectId);
  return features.find((f) => f.id === featureId);
}

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const existing = await loadFeatureScopedToProject(params.id, params.featureId);
  if (!existing) return errorJson(404, "Feature not found");

  const parsed = updateFeatureSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return validationError(parsed.error);
  const data = parsed.data;

  // Slug uniqueness check on rename — only when the name is actually
  // changing, since UNIQUE(project_id, name) allows re-saving the
  // same name as a no-op rename.
  if (data.name !== undefined && data.name !== existing.name) {
    const collision = await featureQueries.getFeature(params.id, data.name);
    if (collision) return errorJson(409, "Feature with this name already exists");
  }

  // **Source-flip policy** — flip features.source from 'agent' → 'user'
  // ONLY on rename or description edit. File-level pins are independent:
  // adding / removing a featureFiles row does NOT promote the feature
  // itself to user-owned (the per-row featureFiles.source column already
  // protects user pins from rescans; the feature-level source column
  // exists to protect rename/description edits from rescan clobber, a
  // disjoint concern).
  //
  // Per PM acceptance criterion #9 + 2026-05-01 follow-up: a file-only
  // PATCH on an agent-sourced feature MUST keep features.source='agent'
  // so a subsequent scan can refresh the description if the dir is
  // renamed in the FS.
  const isFeatureLevelEdit =
    data.name !== undefined || data.description !== undefined;
  const sourceFlip: { source?: "user" } =
    isFeatureLevelEdit && existing.source === "agent" ? { source: "user" } : {};

  if (isFeatureLevelEdit) {
    await featureQueries.updateFeature(params.featureId, {
      name: data.name,
      description: data.description,
      ...sourceFlip,
    });
  }

  if (data.addFiles && data.addFiles.length > 0) {
    for (const relpath of data.addFiles) {
      await featureQueries.addUserFile(params.featureId, relpath);
    }
  }

  if (data.removeFiles && data.removeFiles.length > 0) {
    for (const relpath of data.removeFiles) {
      await featureQueries.removeFile(params.featureId, relpath);
    }
  }

  // Re-load via getFeature so the response includes the updated file
  // list (post add/remove). This is one round trip — listFeatures
  // would over-fetch the whole project.
  const updated = await featureQueries.getFeature(
    params.id,
    data.name ?? existing.name,
  );
  if (!updated) return errorJson(500, "Feature lookup failed after update");
  return json({
    ...updated,
    fileCount: updated.files.length,
  });
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const existing = await loadFeatureScopedToProject(params.id, params.featureId);
  if (!existing) return errorJson(404, "Feature not found");

  await featureQueries.deleteFeature(params.featureId);
  return json({ ok: true });
};
