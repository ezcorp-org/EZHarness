import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * A stop whose durable facts no longer verify is a reconciliation item, not a
 * hot loop (W01h fix round).
 *
 * The stop settlement role retried such a stop on every pass, about once a
 * second, for as long as the process lived: nothing it re-reads could change,
 * so no retry could succeed. `reconcile_json` records the refusal once (its
 * code, detail, and for a reason conflict both reasons) and takes the stop out
 * of the settlement scan. The stop stays `accepted` or `uncertain`, which is
 * the truth: it was never settled. Nothing existing is rewritten.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_task_stops ADD COLUMN IF NOT EXISTS reconcile_json TEXT`);
}
