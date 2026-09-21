import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

const RECEIPT_CHECK = "factory_usage_settlements_receipt_check";

/**
 * A stored provider receipt digest is the C02 form: bare 64-character
 * lowercase hex.
 *
 * Coordinator ruling, 2026-09-20. `add-factory-usage-settlements` required a
 * `sha256:` prefix, while the SDK's result validator, the generated schema,
 * and the Python validator all require the bare form for an operation's
 * `providerReceiptDigest`, and the journal requires a terminal result to
 * mirror its own rows exactly. A row that could settle a cost could therefore
 * not pass the terminal check, and one that could pass it could not settle.
 *
 * Nothing is rewritten. No row can hold the prefixed form: the column has only
 * ever accepted it under the old CHECK, and this migration refuses to relax
 * the constraint while such a row exists, so a database carrying one fails
 * loudly here instead of silently keeping two vocabularies.
 */
export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`DO $$
    DECLARE stale bigint;
    BEGIN
      IF to_regclass('factory_usage_settlements') IS NULL THEN RETURN; END IF;
      SELECT count(*) INTO stale FROM factory_usage_settlements
        WHERE provider_receipt_digest IS NOT NULL AND provider_receipt_digest !~ '^[0-9a-f]{64}$';
      IF stale > 0 THEN
        RAISE EXCEPTION 'factory_usage_settlements holds % provider receipt digests that are not the C02 bare form', stale;
      END IF;
      -- A CHECK cannot be altered in place, and re-adding one on every boot
      -- churns its catalog entry, so this runs only while the old form is still
      -- installed.
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c'
        AND conname = ${sql.raw(`'${RECEIPT_CHECK}'`)} AND pg_get_constraintdef(oid) LIKE '%sha256:%') THEN
        ALTER TABLE factory_usage_settlements DROP CONSTRAINT ${sql.raw(RECEIPT_CHECK)};
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_usage_settlements'::regclass AND contype = 'c' AND conname = ${sql.raw(`'${RECEIPT_CHECK}'`)}) THEN
        ALTER TABLE factory_usage_settlements ADD CONSTRAINT ${sql.raw(RECEIPT_CHECK)}
          CHECK (provider_receipt_digest IS NULL OR provider_receipt_digest ~ '^[0-9a-f]{64}$');
      END IF;
    END $$`);
}
