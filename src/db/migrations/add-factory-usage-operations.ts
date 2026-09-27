import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const SOURCE_CHECK = "factory_usage_settlements_source_check";
const NO_OPERATIONS_CHECK = "factory_usage_settlements_no_operations_check";
const BASIS_CHECK = "factory_usage_settlements_basis_check";

// Literal copies of the two bases in src/factory/usage-settlement.ts: a migration is a frozen snapshot.
const PROVIDER_ERROR_BASIS = "provider-error: model usage measured, compute at reserved bound";
const OPERATIONS_BASIS = "operations: model usage measured, compute at reserved bound";

/**
 * W03f: a stop whose journal settled every operation with measured usage.
 *
 * An attempt that did not complete is settled from its journal at the stop,
 * never from the usage its guest claimed. When every journaled operation
 * completed or failed with measured usage (a provider's error answer reports
 * what it consumed, zero before any token), the model cost is that sum and
 * compute is the reserved bound. That settlement is source `operations`: like
 * W03e's `no-operations` it carries the signed stop receipt that proves it
 * and names its basis, and unlike it the known cost may be above zero. It
 * never carries a provider receipt or a held cost.
 *
 * The three CHECKs W03e installed are replaced only while their narrower form
 * is installed (the quoted literal 'operations' is absent), so a boot after
 * this one changes nothing. Nothing existing is rewritten: every stored row
 * satisfies the wider CHECKs.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%''operations''%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(SOURCE_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(SOURCE_CHECK)}
          CHECK (source IN ('stop','reconciliation','no-operations','operations'));
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${NO_OPERATIONS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%''operations''%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(NO_OPERATIONS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${NO_OPERATIONS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(NO_OPERATIONS_CHECK)}
          CHECK ((source IN ('no-operations','operations')) = (stop_receipt_digest IS NOT NULL)
            AND (source NOT IN ('no-operations','operations') OR (unknown_cost_micros IS NULL AND provider_receipt_digest IS NULL))
            AND (source <> 'no-operations' OR known_cost_micros = '0'));
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${BASIS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%''operations''%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(BASIS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${BASIS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(BASIS_CHECK)}
          CHECK ((source IN ('no-operations','operations')) = (basis IS NOT NULL)
            AND (basis IS NULL
              OR (source = 'no-operations' AND basis = 'no-operations: compute at reserved bound')
              OR (source = 'operations' AND basis IN (${sql.raw(`'${PROVIDER_ERROR_BASIS}'`)}, ${sql.raw(`'${OPERATIONS_BASIS}'`)}))));
      END IF;
    END $$`);
}
