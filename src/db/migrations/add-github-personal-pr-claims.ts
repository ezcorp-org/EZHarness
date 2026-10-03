import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** A live publisher renews this lease; recovery may replace only an expired claim. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE github_personal_pr_proposals ADD COLUMN IF NOT EXISTS claim_owner TEXT`);
  await db.execute(sql`ALTER TABLE github_personal_pr_proposals ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ`);
}
