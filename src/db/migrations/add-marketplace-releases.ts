import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE marketplace_versions ADD COLUMN IF NOT EXISTS release JSONB`);
}
