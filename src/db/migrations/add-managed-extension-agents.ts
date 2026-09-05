import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS managed_by_extension_id TEXT`);
  const { EZ_FACTORY_AGENTS } = await import("../../extensions/ez-factory-agents");
  for (const agent of EZ_FACTORY_AGENTS) {
    await database.execute(sql`UPDATE agent_configs SET managed_by_extension_id = 'legacy:ez-factory'
      WHERE id = ${agent.id} AND name = ${agent.name} AND prompt = ${agent.prompt}
      AND output_format = 'json' AND user_id IS NULL AND managed_by_extension_id IS NULL`);
  }
}
