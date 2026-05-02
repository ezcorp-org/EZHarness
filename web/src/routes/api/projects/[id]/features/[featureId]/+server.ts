import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import * as featureQueries from "$server/db/queries/features";
import { updateFeatureSchema } from "../schema";
import type { RequestHandler } from "./$types";

/**
 * GET — read a single feature with its full file list. Used by the
 * settings UI's row-expand flow as a side-effect-free alternative to
 * the "no-op PATCH" pattern that previously triggered the source-flip
 * (audit defect D4). The PATCH source-flip predicate is also
 * defended at the endpoint level (see PATCH below) — both fixes
 * complement each other.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const feature = await featureQueries.getFeatureById(params.id, params.featureId);
  if (!feature) return errorJson(404, "Feature not found");
  return json({
    ...feature,
    fileCount: feature.files.length,
  });
};

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

// Note: PATCH and DELETE both use `getFeatureById(projectId, featureId)`
// directly. The previous `loadFeatureScopedToProject` helper called
// `listFeatures(projectId)` and scanned the result — O(N) read for an
// O(1) need. Audit defect C5 (closed alongside this refactor); the
// helper introduced for D4's GET endpoint is the right primitive for
// every per-feature scoped lookup.

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const existing = await featureQueries.getFeatureById(params.id, params.featureId);
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
  // ONLY on rename or description edit that actually changes the value.
  // File-level pins are independent: adding / removing a featureFiles row
  // does NOT promote the feature itself to user-owned (the per-row
  // featureFiles.source column already protects user pins from rescans;
  // the feature-level source column exists to protect rename/description
  // edits from rescan clobber, a disjoint concern).
  //
  // The "actually changes the value" check (audit defect D4 defense) is
  // critical: a no-op PATCH that re-asserts the existing description —
  // such as the legacy `refreshFeatureFiles` round-trip from the row-
  // expand UI flow — must NOT silently mute the feature from future
  // rescans. The settings UI now uses GET for that fetch (eliminating
  // the misuse), but this check is defense-in-depth for any future
  // caller that re-PATCHes a current value.
  //
  // Per PM acceptance criterion #9 + 2026-05-01 follow-up: a file-only
  // PATCH on an agent-sourced feature MUST keep features.source='agent'
  // so a subsequent scan can refresh the description if the dir is
  // renamed in the FS.
  const isMeaningfulNameEdit =
    data.name !== undefined && data.name !== existing.name;
  const isMeaningfulDescriptionEdit =
    data.description !== undefined && data.description !== existing.description;
  const isFeatureLevelEdit = isMeaningfulNameEdit || isMeaningfulDescriptionEdit;
  const sourceFlip: { source?: "user" } =
    isFeatureLevelEdit && existing.source === "agent" ? { source: "user" } : {};

  // Still write through if the user passed name/description equal to
  // current values: it's a no-op write but updatedAt moves, which is
  // fine. The source flip is gated on `isFeatureLevelEdit` (above), so
  // a no-op PATCH does NOT mutate ownership.
  const hasNameOrDescriptionField =
    data.name !== undefined || data.description !== undefined;
  if (hasNameOrDescriptionField) {
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

  const existing = await featureQueries.getFeatureById(params.id, params.featureId);
  if (!existing) return errorJson(404, "Feature not found");

  await featureQueries.deleteFeature(params.featureId);
  return json({ ok: true });
};
