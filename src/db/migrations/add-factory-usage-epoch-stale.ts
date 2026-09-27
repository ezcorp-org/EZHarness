import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * W15f: an uncertain hold whose attempt belongs to an execution epoch a restore
 * has moved past.
 *
 * Usage reconciliation resolves a hold through the journal, under the run
 * fence, with the attempt's sealed authority. After a restore opens a new
 * epoch that authority can never pass the fence again, so the role used to
 * fail the hold on every pass for as long as the process lived. The role now
 * records the fact once here — the attempt, its epoch, and the installation's
 * epoch when it was seen — and the uncertain-hold scan skips the hold while the
 * installation is still at that epoch. The hold stays `uncertain`: its money is
 * still held, and the mark is the reconciliation item a person acts on.
 * Nothing existing is rewritten.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_budget_reservations ADD COLUMN IF NOT EXISTS epoch_stale_json JSONB`);
}
