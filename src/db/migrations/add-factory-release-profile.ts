import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * The asynchronous release profile seal, plus the git destination binding W07 needs.
 *
 * Both sets of columns land together because they are two facts about the same row and one
 * spliced migration is cheaper to reason about than two. The profile seal lets the final product
 * transaction re-derive its input and refuse a result that no longer matches. The git columns bind
 * the exact ref an operation may push, inside the broker-only namespace.
 *
 * The freeze also names `state = 'pending' OR profile_result_digest IS NOT NULL`. It is NOT added
 * here, and deliberately so: nothing writes the seal yet, so the landed release path claims
 * `pending -> executing` with all three columns NULL and every dispatch would fail closed. W07
 * adds that check in the same change that makes its adapter resolve the profile.
 */
const CHECKS: readonly { readonly name: string; readonly body: string }[] = [
  { name: "factory_release_operations_profile_input_digest_check", body: "profile_input_digest IS NULL OR profile_input_digest ~ '^sha256:[0-9a-f]{64}$'" },
  { name: "factory_release_operations_profile_result_digest_check", body: "profile_result_digest IS NULL OR profile_result_digest ~ '^sha256:[0-9a-f]{64}$'" },
  { name: "factory_release_operations_profile_seal_check", body: "(profile_result_digest IS NULL) = (profile_input_digest IS NULL) AND (profile_result_digest IS NULL) = (profile_resolved_at_ms IS NULL)" },
  { name: "factory_release_operations_profile_resolved_at_check", body: "profile_resolved_at_ms IS NULL OR profile_resolved_at_ms > 0" },
  { name: "factory_release_operations_destination_ref_check", body: "destination_ref IS NULL OR destination_ref LIKE 'refs/heads/ezcorp-factory/%'" },
  { name: "factory_release_operations_destination_branch_check", body: "(destination_ref IS NULL) = (destination_branch IS NULL)" },
];

export async function up(database: MigrationDb): Promise<void> {
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_input_digest TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_result_digest TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS profile_resolved_at_ms BIGINT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS destination_ref TEXT`);
  await database.execute(sql`ALTER TABLE factory_release_operations ADD COLUMN IF NOT EXISTS destination_branch TEXT`);
  // A CHECK cannot be altered in place, and re-adding one on every boot churns its catalog entry
  // and revalidates the table, so each is installed only when its exact name is absent.
  for (const item of CHECKS) {
    await database.execute(sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' AND conname=${sql.raw(`'${item.name}'`)}) THEN
        ALTER TABLE factory_release_operations ADD CONSTRAINT ${sql.raw(item.name)} CHECK (${sql.raw(item.body)});
      END IF;
    END $$`);
  }
}
