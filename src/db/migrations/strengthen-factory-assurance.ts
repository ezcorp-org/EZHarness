import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/** Bind historic acceptance facts to their exact execution and never trust mutable evidence bytes. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS run_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS node_instance_id TEXT`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS candidate_generation BIGINT`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS execution_epoch BIGINT`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions ADD COLUMN IF NOT EXISTS cancellation_epoch BIGINT`);
  await database.execute(sql`ALTER TABLE factory_acceptance_decisions DROP CONSTRAINT IF EXISTS factory_acceptance_decisions_tenant_id_project_id_contract_id_contract_revision_candidate_digest_key`);
  await database.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_acceptance_decisions_candidate ON factory_acceptance_decisions (tenant_id, project_id, contract_id, contract_revision, run_id, node_instance_id, candidate_generation, candidate_digest)`);
}
