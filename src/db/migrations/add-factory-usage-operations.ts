import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const SOURCE_CHECK = "factory_usage_settlements_source_check";
const NO_OPERATIONS_CHECK = "factory_usage_settlements_no_operations_check";
const BASIS_CHECK = "factory_usage_settlements_basis_check";
const RESTORE_DIGEST_CHECK = "factory_usage_settlements_restore_digest_check";

// Literal copies of the bases in src/factory/usage-settlement.ts: a migration is a frozen snapshot.
const PROVIDER_ERROR_BASIS = "provider-error: model usage measured, compute at reserved bound";
const OPERATIONS_BASIS = "operations: model usage measured, compute at reserved bound";
const RESERVED_BOUND_BASIS = "unknown: charged at reserved bound; ended by stop";
const RESERVED_BOUND_RESTORE_BASIS = "unknown: charged at reserved bound; ended by restore supersession";

/**
 * W03f: a stop settles from its journal, and an unknown only at its bound.
 *
 * `operations` is a stop whose attempt did not complete and whose every
 * journaled operation settled with measured usage: the model cost is that sum
 * (zero when a provider refused before consuming), compute is the reserved
 * bound. Like W03e's `no-operations` it carries the signed stop receipt that
 * proves it and names its basis; unlike it the known cost may be above zero.
 *
 * `reserved-bound` (coordinator ruling B) is an attempt that ended past its
 * signed deadline while an operation's cost was still unknown: settled at the
 * bound the tenant accepted. It rests on exactly one proof that the process is
 * gone, named by its basis: the signed stop (`stop_receipt_digest`) or a signed
 * restore that superseded the attempt (`restore_digest`, W15f).
 *
 * None of these carries a provider receipt or a held cost. Each CHECK W03e
 * installed is replaced only while its narrower form is installed (its
 * marker below is absent), so a boot after this one changes nothing. Nothing
 * existing is rewritten: every stored row satisfies the wider CHECKs.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_usage_settlements ADD COLUMN IF NOT EXISTS restore_digest TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%reserved-bound%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(SOURCE_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(SOURCE_CHECK)}
          CHECK (source IN ('stop','reconciliation','no-operations','operations','reserved-bound'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${RESTORE_DIGEST_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(RESTORE_DIGEST_CHECK)}
          CHECK (restore_digest IS NULL OR restore_digest ~ '^sha256:[0-9a-f]{64}$');
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${NO_OPERATIONS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%restore_digest%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(NO_OPERATIONS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${NO_OPERATIONS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(NO_OPERATIONS_CHECK)}
          CHECK ((CASE WHEN source IN ('no-operations','operations') THEN stop_receipt_digest IS NOT NULL AND restore_digest IS NULL
                       WHEN source = 'reserved-bound' THEN (stop_receipt_digest IS NULL) <> (restore_digest IS NULL)
                       ELSE stop_receipt_digest IS NULL AND restore_digest IS NULL END)
            AND (source NOT IN ('no-operations','operations','reserved-bound') OR (unknown_cost_micros IS NULL AND provider_receipt_digest IS NULL))
            AND (source <> 'no-operations' OR known_cost_micros = '0'));
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${BASIS_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%restore supersession%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(BASIS_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${BASIS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(BASIS_CHECK)}
          CHECK ((source IN ('no-operations','operations','reserved-bound')) = (basis IS NOT NULL)
            AND (basis IS NULL
              OR (source = 'no-operations' AND basis = 'no-operations: compute at reserved bound')
              OR (source = 'operations' AND basis IN (${sql.raw(`'${PROVIDER_ERROR_BASIS}'`)}, ${sql.raw(`'${OPERATIONS_BASIS}'`)}))
              OR (source = 'reserved-bound' AND stop_receipt_digest IS NOT NULL AND basis = ${sql.raw(`'${RESERVED_BOUND_BASIS}'`)})
              OR (source = 'reserved-bound' AND restore_digest IS NOT NULL AND basis = ${sql.raw(`'${RESERVED_BOUND_RESTORE_BASIS}'`)})));
      END IF;
    END $$`);
}
