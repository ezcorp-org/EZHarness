import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Preserve audit facts while unwrapping objects double-encoded by Bun.sql. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    DECLARE entry RECORD; decoded JSONB;
    BEGIN
      IF EXISTS (SELECT 1 FROM settings WHERE key='db:transactional-audit-json-repair:v1') THEN RETURN; END IF;
      FOR entry IN SELECT id, metadata FROM audit_log
        WHERE jsonb_typeof(metadata)='string' AND left(ltrim(metadata #>> '{}'), 1)='{'
      LOOP
        BEGIN
          decoded := (entry.metadata #>> '{}')::jsonb;
        EXCEPTION WHEN invalid_text_representation THEN CONTINUE;
        END;
        IF jsonb_typeof(decoded)='object' THEN
          UPDATE audit_log SET metadata=decoded WHERE id=entry.id AND metadata=entry.metadata;
        END IF;
      END LOOP;
      INSERT INTO settings (key,value) VALUES ('db:transactional-audit-json-repair:v1','true'::jsonb) ON CONFLICT (key) DO NOTHING;
    END $$`);
}
