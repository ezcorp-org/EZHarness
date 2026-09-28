import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

export const FACTORY_USAGE_BASIS_CHECK = "factory_usage_settlements_basis_check";

/**
 * W09h R4: a no-operations settlement may also name the basis "no-operations: nothing launched, all zero".
 *
 * W03e's only basis, "no-operations: compute at reserved bound", is true for a guest that ran and reported
 * nothing: its compute is unmeasured, so it is charged at the bound. It is false for an attempt stopped
 * before compute admission (and, after W09h, a dispatch the pool refused): nothing launched, so compute is a
 * known zero like cost and tokens. The record's basis must be true, so this adds the second basis.
 *
 * Additive: the allowed set gains one member and loses none, and the source rule is unchanged. A CHECK cannot
 * be altered in place, and re-adding one on every boot churns its catalog entry, so the check is replaced only
 * while the one-basis form is still installed.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${FACTORY_USAGE_BASIS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%nothing launched, all zero%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(FACTORY_USAGE_BASIS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${FACTORY_USAGE_BASIS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(FACTORY_USAGE_BASIS_CHECK)}
          CHECK ((source = 'no-operations') = (basis IS NOT NULL)
            AND (basis IS NULL OR basis IN ('no-operations: compute at reserved bound', 'no-operations: nothing launched, all zero')));
      END IF;
    END $$`);
}
