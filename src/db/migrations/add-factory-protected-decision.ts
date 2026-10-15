import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The durable rejected fact, denormalized onto the protected effect receipt.
 *
 * Before this column a failing claim was only a thrown activity error, so no rejected fact existed
 * at all and the worker retried until its timeout. `decision` records the branch an acceptance
 * command took; the authoritative record stays the sealed `receipt_json`.
 */
const CHECKS: readonly { readonly name: string; readonly body: string }[] = [
  { name: "factory_protected_command_effects_decision_check", body: "decision IS NULL OR decision IN ('accepted','rejected')" },
  { name: "factory_protected_command_effects_decision_kind_check", body: "kind = 'request-acceptance' OR decision IS NULL" },
];

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_protected_command_effects ADD COLUMN IF NOT EXISTS decision TEXT`);
  // Every receipt written before this column recorded an acceptance; a rejection had no branch.
  await database.execute(sql`UPDATE factory_protected_command_effects SET decision='accepted' WHERE decision IS NULL AND kind='request-acceptance'`);
  for (const item of CHECKS) {
    await database.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_protected_command_effects'::regclass AND contype='c' AND conname=${sql.raw(`'${item.name}'`)}) THEN
        ALTER TABLE factory_protected_command_effects ADD CONSTRAINT ${sql.raw(item.name)} CHECK (${sql.raw(item.body)});
      END IF;
    END $$`);
  }
}
