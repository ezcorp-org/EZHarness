import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Older migration steps must retain every identity dimension already installed. */
export async function ensureFactoryArtifactAdmissionIndex(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$ DECLARE definition TEXT; BEGIN
    definition := 'CREATE UNIQUE INDEX factory_artifacts_admission_identity ON factory_artifacts (tenant_id, project_id, run_id, COALESCE(interpreter_id, ''''), kind, COALESCE(source_sequence, -1), COALESCE(page_index, -1)';
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='factory_artifacts'::regclass AND attname='partition_id' AND NOT attisdropped) THEN
      definition := definition || ', COALESCE(partition_id, '''')';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='factory_artifacts'::regclass AND attname='candidate_node_instance_id' AND NOT attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='factory_artifacts'::regclass AND attname='candidate_generation' AND NOT attisdropped) THEN
      definition := definition || ', COALESCE(candidate_node_instance_id, ''''), COALESCE(candidate_generation, -1)';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='factory_artifacts'::regclass AND attname='material_key' AND NOT attisdropped) THEN
      definition := definition || ', COALESCE(material_key, '''')';
    END IF;
    DROP INDEX IF EXISTS factory_artifacts_admission_identity;
    EXECUTE definition || ')';
  END $$`);
}
