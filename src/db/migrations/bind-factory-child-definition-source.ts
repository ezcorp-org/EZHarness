import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** A retry must return the same staged source after the parent head has moved. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_child_runs ADD COLUMN IF NOT EXISTS definition_json TEXT NOT NULL DEFAULT '{}'`);
}
