import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Evidence and its claimed restart run must finish in one database transaction. */
export async function up(db: MigrationDb): Promise<void> {
  await db.execute(sql`ALTER TABLE incus_qualification_runs
    DROP CONSTRAINT IF EXISTS incus_qualification_runs_state_check`);
  await db.execute(sql`ALTER TABLE incus_qualification_runs
    ADD CONSTRAINT incus_qualification_runs_state_check
    CHECK (state IN ('AWAITING_RESTART', 'CLAIMED', 'FAILED', 'COMPLETED'))`);
}
