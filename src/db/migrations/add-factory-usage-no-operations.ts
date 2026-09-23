import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const SOURCE_CHECK = "factory_usage_settlements_source_check";
const STOP_RECEIPT_CHECK = "factory_usage_settlements_stop_receipt_check";
const NO_OPERATIONS_CHECK = "factory_usage_settlements_no_operations_check";

/**
 * A stopped attempt that journaled no operation settles zero usage as a fact.
 *
 * C02 journals every model and tool operation before its possible effect, so a
 * signed physical stop plus an empty journal proves no provider was charged.
 * Before this, such an attempt stayed `uncertain` forever: reconciliation only
 * resolves a hold from an operation's provider receipt, and there was none.
 *
 * The settlement is typed `no-operations` and carries the signed stop receipt
 * digest that proves it. The CHECKs make the shape exact: that source, and only
 * that source, carries a stop receipt, and it can only ever be a known zero with
 * nothing held and no provider receipt. Nothing existing is rewritten.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_usage_settlements ADD COLUMN IF NOT EXISTS stop_receipt_digest TEXT`);
  await database.execute(sql`DO $$
    BEGIN
      -- A CHECK cannot be altered in place, and re-adding one on every boot
      -- churns its catalog entry, so the source check is replaced only while
      -- the two-member form is still installed.
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)} AND pg_get_constraintdef(oid) NOT LIKE '%no-operations%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(SOURCE_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${SOURCE_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(SOURCE_CHECK)}
          CHECK (source IN ('stop','reconciliation','no-operations'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${STOP_RECEIPT_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(STOP_RECEIPT_CHECK)}
          CHECK (stop_receipt_digest IS NULL OR stop_receipt_digest ~ '^sha256:[0-9a-f]{64}$');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${NO_OPERATIONS_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(NO_OPERATIONS_CHECK)}
          CHECK ((source = 'no-operations') = (stop_receipt_digest IS NOT NULL)
            AND (source <> 'no-operations' OR (known_cost_micros = '0' AND unknown_cost_micros IS NULL AND provider_receipt_digest IS NULL)));
      END IF;
    END $$`);
}
