import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** One immutable import authority record; snapshots refer to that import. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE github_personal_pr_imports ADD COLUMN IF NOT EXISTS workspace_authority JSONB`);
}
