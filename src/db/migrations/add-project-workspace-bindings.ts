import { sql } from "drizzle-orm";
import type { MigrateDb } from "./types";

/** Local is the compatible default. A sandbox row is only usable after a
 * reviewed provider activates it; `unknown` is intentionally fail-closed. */
export async function up(db: MigrateDb): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS project_workspace_bindings (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      binding_id TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'unknown',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      CHECK (kind IN ('sandbox')),
      CHECK (state IN ('active', 'unknown')),
      CHECK (revision > 0),
      CHECK (binding_id IS NULL OR length(binding_id) <= 256)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_project_workspace_bindings_state ON project_workspace_bindings(state)`);
}
