import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Historic rows without a sealed snapshot are fail-closed by the assurance reader. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_acceptance_contracts ADD COLUMN IF NOT EXISTS protected_snapshot_digest TEXT CHECK (protected_snapshot_digest ~ '^sha256:[0-9a-f]{64}$')`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS contract_snapshot_digest TEXT CHECK (contract_snapshot_digest ~ '^sha256:[0-9a-f]{64}$')`);
}
