import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";
import { ensureFactoryArtifactAdmissionIndex } from "./factory-artifact-admission-index";

/** Replaces the lossy integer partition slot with the compiler's exact partition identity. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_artifacts ADD COLUMN IF NOT EXISTS partition_id TEXT`);
  await ensureFactoryArtifactAdmissionIndex(database);
}
