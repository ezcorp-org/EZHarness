import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";
import { releaseRows as rows } from "../queries/extension-releases";

/** Child workflows have no start outbox. Existing rows must be explicitly backfilled, never inferred. */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_child_runs ADD COLUMN IF NOT EXISTS started_ms BIGINT`);
  const missing = rows<{ count: number | string }>(await database.execute(sql`SELECT COUNT(*) AS count FROM factory_child_runs WHERE started_ms IS NULL`))[0];
  if (!missing || Number(missing.count) !== 0) throw new Error("factory_child_start_clock_backfill_required");
  await database.execute(sql`ALTER TABLE factory_child_runs ALTER COLUMN started_ms SET NOT NULL`);
}
