import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Makes every artifact identifier durable only within its tenant and project scope. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$ BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid='factory_artifacts'::regclass AND c.contype='p'
      AND (SELECT array_agg(a.attname::text ORDER BY k.position)
        FROM unnest(c.conkey) WITH ORDINALITY k(number, position)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.number)
        = ARRAY['tenant_id','project_id','object_id']::text[]
    ) THEN RETURN; END IF;
    ALTER TABLE factory_artifacts DROP CONSTRAINT IF EXISTS factory_artifacts_pkey;
    ALTER TABLE factory_artifacts ADD CONSTRAINT factory_artifacts_pkey PRIMARY KEY (tenant_id, project_id, object_id);
  END $$`);
}
