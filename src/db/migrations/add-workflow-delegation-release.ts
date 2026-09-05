import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE workflow_delegations ADD COLUMN IF NOT EXISTS extension_release_binding TEXT`);
}
