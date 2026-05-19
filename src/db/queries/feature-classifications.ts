import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "../connection";
import {
  featureClassifications,
  features,
  type FeatureClassification,
  type NewFeatureClassification,
  type SurfaceVerdicts,
} from "../schema";

/**
 * Surface-coverage audit cache.
 *
 * Each row is a verdict for a feature at a specific content snapshot
 * (`content_hash` derived in src/runtime/audit/cache.ts). Re-running the
 * audit on an unchanged feature is a pure cache hit; when content changes
 * a fresh row is inserted and `pruneStaleClassifications()` drops the old
 * one so the table stays single-row-per-feature in steady state.
 */

export async function getClassification(
  featureId: string,
  contentHash: string,
): Promise<FeatureClassification | undefined> {
  if (!featureId || !contentHash) return undefined;
  const rows = (await getDb()
    .select()
    .from(featureClassifications)
    .where(
      and(
        eq(featureClassifications.featureId, featureId),
        eq(featureClassifications.contentHash, contentHash),
      ),
    )) as FeatureClassification[];
  return rows[0];
}

export interface UpsertClassificationInput {
  featureId: string;
  contentHash: string;
  surfaces: SurfaceVerdicts;
  rationale?: string;
}

export async function upsertClassification(
  input: UpsertClassificationInput,
): Promise<FeatureClassification> {
  if (!input.featureId) throw new Error("featureId is required");
  if (!input.contentHash) throw new Error("contentHash is required");
  const db = getDb();
  const row: NewFeatureClassification = {
    featureId: input.featureId,
    contentHash: input.contentHash,
    surfaces: input.surfaces,
    rationale: input.rationale ?? "",
    classifiedAt: new Date(),
  };

  const existing = await getClassification(input.featureId, input.contentHash);
  if (existing) {
    const updated = (await db
      .update(featureClassifications)
      .set({
        surfaces: row.surfaces,
        rationale: row.rationale,
        classifiedAt: row.classifiedAt,
      })
      .where(
        and(
          eq(featureClassifications.featureId, input.featureId),
          eq(featureClassifications.contentHash, input.contentHash),
        ),
      )
      .returning()) as FeatureClassification[];
    return updated[0]!;
  }
  const inserted = (await db
    .insert(featureClassifications)
    .values(row)
    .returning()) as FeatureClassification[];
  return inserted[0]!;
}

/**
 * Drop every classification for `featureId` whose hash is NOT `keepHash`.
 * Called after a fresh classify writes the current-hash row, so the
 * table stays one-row-per-feature in steady state.
 */
export async function pruneStaleClassifications(
  featureId: string,
  keepHash: string,
): Promise<number> {
  if (!featureId || !keepHash) return 0;
  const deleted = (await getDb()
    .delete(featureClassifications)
    .where(
      and(
        eq(featureClassifications.featureId, featureId),
        ne(featureClassifications.contentHash, keepHash),
      ),
    )
    .returning()) as FeatureClassification[];
  return deleted.length;
}

/**
 * Latest classification per feature for a project. Returns at most one
 * row per feature (most recent by `classified_at`). Used by the report
 * writer to compute deltas vs the prior run.
 */
export async function listLatestClassifications(
  projectId: string,
): Promise<FeatureClassification[]> {
  if (!projectId) return [];
  const db = getDb();
  const featureRows = (await db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.projectId, projectId))) as Array<{ id: string }>;
  if (featureRows.length === 0) return [];
  const featureIds = featureRows.map((r) => r.id);
  const rows = (await db
    .select()
    .from(featureClassifications)
    .where(inArray(featureClassifications.featureId, featureIds))
    .orderBy(desc(featureClassifications.classifiedAt))) as FeatureClassification[];

  const seen = new Set<string>();
  const out: FeatureClassification[] = [];
  for (const row of rows) {
    if (seen.has(row.featureId)) continue;
    seen.add(row.featureId);
    out.push(row);
  }
  return out;
}
