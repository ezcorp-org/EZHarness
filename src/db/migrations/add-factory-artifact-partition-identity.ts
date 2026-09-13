import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Replaces the lossy integer partition slot with the compiler's exact partition identity. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_artifacts ADD COLUMN IF NOT EXISTS partition_id TEXT`);
  await database.execute(sql`DROP INDEX IF EXISTS factory_artifacts_admission_identity`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS factory_artifacts_admission_identity ON factory_artifacts (tenant_id, project_id, run_id, COALESCE(interpreter_id, ''), kind, COALESCE(source_sequence, -1), COALESCE(page_index, -1), COALESCE(partition_id, ''))`);
}
