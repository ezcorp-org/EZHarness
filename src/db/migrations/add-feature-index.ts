/**
 * Feature Index migration
 *
 * Adds the project-scoped Feature Index — a named registry of file
 * buckets that powers the `$[feature:name]` mention sigil in chat.
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - features (id, project_id FK CASCADE, name, description,
 *     source ∈ {'user','agent'}, created_at, updated_at)
 *   - feature_files (feature_id FK CASCADE, relpath,
 *     source ∈ {'user','scan'}, added_at) with composite PRIMARY KEY
 *     (feature_id, relpath) — natural junction key, prevents duplicate
 *     pins on the same feature.
 *   - UNIQUE(project_id, name) on features so slug uniqueness is
 *     scoped per-project (two projects can each have a feature named
 *     "chat-attachments").
 *   - Indexes on features.project_id and feature_files.feature_id.
 *
 * Hybrid ownership invariants (enforced at the query layer, not the
 * DB — see src/db/queries/features.ts):
 *   - replaceAgentFiles(featureId, relpaths[]) only deletes + reinserts
 *     `source = 'scan'` rows. User-pinned (`source = 'user'`) rows
 *     survive every rescan.
 *   - PATCH on an `agent`-sourced feature flips `source` to `'user'`
 *     so subsequent rescans won't clobber the rename. Surfaces in the
 *     REST endpoint, not in the DB layer.
 *
 * This migration is applied automatically via src/db/migrate.ts. This
 * file exists for documentation and parallels add-fork-tracking.ts /
 * add-ez-mode-and-kind.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, name)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS feature_files (
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      relpath TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'scan',
      added_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      PRIMARY KEY (feature_id, relpath)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_feature_files_feature ON feature_files(feature_id)`);
}
