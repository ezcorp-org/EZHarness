import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Makes every artifact identifier durable only within its tenant and project scope. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_pkey`);
  await database.execute(sql`ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_pkey PRIMARY KEY (tenant_id, project_id, object_id)`);
}
