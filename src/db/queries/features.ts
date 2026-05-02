import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import {
  features,
  featureFiles,
  type Feature,
  type FeatureFile,
  type NewFeature,
} from "../schema";

/**
 * Project-scoped Feature Index queries.
 *
 * Two-table junction (`features` → `feature_files`) backing the
 * `$[feature:name]` mention sigil. The `source` columns on both tables
 * are LOAD-BEARING — see docs/plans/2026-05-01-feature-index-design.md.
 *
 * Hybrid ownership invariants enforced here (NOT at the DB level):
 *   - replaceAgentFiles() only deletes/reinserts `source = 'scan'` rows.
 *     User-pinned (`source = 'user'`) feature_files survive every scan.
 *   - The REST PATCH layer is responsible for flipping
 *     `features.source` from 'agent' → 'user' on rename/edit (so the
 *     next scan won't clobber user-renamed features). That flip lives
 *     in the endpoint, not here, because this module is the lower-level
 *     CRUD primitive.
 */

export interface FeatureWithFileCount extends Feature {
  fileCount: number;
}

export interface FeatureWithFiles extends Feature {
  files: FeatureFile[];
}

/**
 * List every feature for the project, with a file count per feature.
 * Ordered by name for stable UI rendering.
 */
export async function listFeatures(projectId: string): Promise<FeatureWithFileCount[]> {
  if (!projectId) return [];
  const db = getDb();
  const rows = (await db
    .select()
    .from(features)
    .where(eq(features.projectId, projectId))) as Feature[];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const fileRows = (await db
    .select({ featureId: featureFiles.featureId })
    .from(featureFiles)
    .where(inArray(featureFiles.featureId, ids))) as Array<{ featureId: string }>;

  const counts = new Map<string, number>();
  for (const r of fileRows) {
    counts.set(r.featureId, (counts.get(r.featureId) ?? 0) + 1);
  }
  return rows
    .map((row) => ({ ...row, fileCount: counts.get(row.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Look up a single feature by (project, name) and return its files.
 * Used by the `$[feature:<name>]` server-side expansion. Returns
 * undefined when the feature doesn't exist — callers MUST treat this
 * as a silent no-op (mirroring `@[file:…]` for deleted files).
 */
export async function getFeature(
  projectId: string,
  name: string,
): Promise<FeatureWithFiles | undefined> {
  if (!projectId || !name) return undefined;
  const db = getDb();
  const rows = (await db
    .select()
    .from(features)
    .where(and(eq(features.projectId, projectId), eq(features.name, name)))) as Feature[];
  const feature = rows[0];
  if (!feature) return undefined;

  const files = (await db
    .select()
    .from(featureFiles)
    .where(eq(featureFiles.featureId, feature.id))) as FeatureFile[];
  files.sort((a, b) => a.relpath.localeCompare(b.relpath));
  return { ...feature, files };
}

/**
 * Look up a single feature by (projectId, featureId) and return its
 * files. Used by the per-feature GET endpoint backing the settings
 * UI's row-expand fetch. The `(projectId, featureId)` pair scopes the
 * lookup so a caller with one project's id can't read a different
 * project's feature by guessing its uuid.
 */
export async function getFeatureById(
  projectId: string,
  featureId: string,
): Promise<FeatureWithFiles | undefined> {
  if (!projectId || !featureId) return undefined;
  const db = getDb();
  const rows = (await db
    .select()
    .from(features)
    .where(
      and(eq(features.projectId, projectId), eq(features.id, featureId)),
    )) as Feature[];
  const feature = rows[0];
  if (!feature) return undefined;

  const files = (await db
    .select()
    .from(featureFiles)
    .where(eq(featureFiles.featureId, feature.id))) as FeatureFile[];
  files.sort((a, b) => a.relpath.localeCompare(b.relpath));
  return { ...feature, files };
}

export interface CreateFeatureInput {
  projectId: string;
  name: string;
  description?: string;
  /** 'user' for user-created (default) or 'agent' for scan-discovered. */
  source?: "user" | "agent";
}

export async function createFeature(input: CreateFeatureInput): Promise<Feature> {
  if (!input.projectId) throw new Error("projectId is required");
  if (!input.name) throw new Error("name is required");
  const now = new Date();
  const row: NewFeature = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? "",
    source: input.source ?? "user",
    createdAt: now,
    updatedAt: now,
  };
  const inserted = (await getDb()
    .insert(features)
    .values(row)
    .returning()) as Feature[];
  return inserted[0]!;
}

export interface UpdateFeatureInput {
  name?: string;
  description?: string;
  /** Pass 'user' to flip ownership (the REST PATCH does this on agent rows). */
  source?: "user" | "agent";
}

/**
 * Patch a feature row by id. Returns the updated row (or undefined if
 * no row matched).
 *
 * NOTE: this function does not auto-flip `source`. The REST PATCH
 * endpoint decides when to flip 'agent' → 'user' (on rename/edit) and
 * passes `source: 'user'` explicitly. Keeping the policy at the
 * endpoint preserves a clean separation: this module is mechanical
 * CRUD, not policy.
 */
export async function updateFeature(
  featureId: string,
  patch: UpdateFeatureInput,
): Promise<Feature | undefined> {
  if (!featureId) return undefined;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.description !== undefined) updates.description = patch.description;
  if (patch.source !== undefined) updates.source = patch.source;

  const rows = (await getDb()
    .update(features)
    .set(updates)
    .where(eq(features.id, featureId))
    .returning()) as Feature[];
  return rows[0];
}

/**
 * Delete a feature. The FK cascade drops every `feature_files` row
 * (both 'scan' and 'user'), which is the desired behavior — the user
 * has explicitly opted to remove the bucket.
 */
export async function deleteFeature(featureId: string): Promise<boolean> {
  if (!featureId) return false;
  const rows = (await getDb()
    .delete(features)
    .where(eq(features.id, featureId))
    .returning({ id: features.id })) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Replace this feature's `source = 'scan'` files with the given relpath
 * list. User-pinned (`source = 'user'`) rows are NEVER touched.
 *
 * Implementation:
 *   1. Delete all rows where (feature_id = X AND source = 'scan').
 *   2. Insert each input relpath as `source = 'scan'`, skipping any
 *      relpath that is already pinned by the user (composite-PK
 *      collision would otherwise abort the insert).
 *
 * This is the canonical hybrid-ownership primitive; the scanner calls
 * it after each rescan. It is idempotent for fixed inputs.
 */
export async function replaceAgentFiles(
  featureId: string,
  relpaths: readonly string[],
): Promise<void> {
  if (!featureId) return;
  const db = getDb();
  // Step 1: drop the previous scan results. User-pinned rows survive
  // because of the source predicate.
  await db
    .delete(featureFiles)
    .where(and(eq(featureFiles.featureId, featureId), eq(featureFiles.source, "scan")));

  if (relpaths.length === 0) return;

  // Dedupe + drop any relpath already pinned by the user — a 'user' row
  // and a 'scan' row at the same (feature_id, relpath) would collide on
  // the composite PK. We keep the user's pin; the scanner's hit on the
  // same path is redundant.
  const pinned = (await db
    .select({ relpath: featureFiles.relpath })
    .from(featureFiles)
    .where(and(eq(featureFiles.featureId, featureId), eq(featureFiles.source, "user")))) as Array<{
      relpath: string;
    }>;
  const pinnedSet = new Set(pinned.map((p) => p.relpath));

  const unique = [...new Set(relpaths)].filter((p) => !pinnedSet.has(p));
  if (unique.length === 0) return;

  const now = new Date();
  await db.insert(featureFiles).values(
    unique.map((relpath) => ({
      featureId,
      relpath,
      source: "scan" as const,
      addedAt: now,
    })),
  );
}

/**
 * Pin (or unpin) a single user-managed file on a feature. Idempotent —
 * a re-pin of the same path is a no-op via onConflictDoNothing.
 */
export async function addUserFile(featureId: string, relpath: string): Promise<void> {
  if (!featureId || !relpath) return;
  await getDb()
    .insert(featureFiles)
    .values({
      featureId,
      relpath,
      source: "user" as const,
      addedAt: new Date(),
    })
    .onConflictDoNothing();
}

export async function removeFile(featureId: string, relpath: string): Promise<boolean> {
  if (!featureId || !relpath) return false;
  const rows = (await getDb()
    .delete(featureFiles)
    .where(and(eq(featureFiles.featureId, featureId), eq(featureFiles.relpath, relpath)))
    .returning({ relpath: featureFiles.relpath })) as Array<{ relpath: string }>;
  return rows.length > 0;
}
