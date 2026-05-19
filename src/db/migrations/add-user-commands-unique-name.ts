/**
 * user_commands UNIQUE(user_id, name) constraint.
 *
 * The `user_commands` table was originally created in migrate.ts WITH
 * the inline `UNIQUE(user_id, name)` constraint baked into the CREATE
 * TABLE. Fresh databases pick this up automatically. This migration
 * file documents the pre-flight rename + idempotent unique-index add
 * applied to upgrade existing deployments whose tables predate the
 * constraint.
 *
 * Strategy (executed inline inside migrate.ts after the CREATE TABLE):
 *   1. Scan for duplicate (user_id, name) tuples.
 *   2. For every duplicate, rename the colliding row's `name` to
 *      `${name}-2`, `${name}-3`, … (smallest free suffix per user) so
 *      no row is dropped.
 *   3. Add the unique index (`uq_user_commands_user_name`) idempotently.
 *
 * The query layer (src/db/queries/user-commands.ts → findFreeName)
 * mirrors this rename policy at write time so users authoring through
 * the new /commands UI are never blocked by a 23505 conflict — the
 * API returns the canonical saved name and the UI surfaces a toast
 * (`Saved as "review-2" — "review" already exists`).
 *
 * This migration is applied automatically via src/db/migrate.ts. This
 * file exists for documentation and parallels add-feature-index.ts /
 * add-fork-tracking.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}): Promise<void> {
  // Pre-flight: find every (user_id, name) collision and rewrite the
  // newer rows' `name` to the smallest free `${name}-N` suffix per
  // user. ROW_NUMBER orders by created_at so the oldest row keeps the
  // unsuffixed name. The suffix loop runs in SQL to keep migrate.ts
  // free of JS-side row iteration.
  await db.execute(sql`
    WITH dups AS (
      SELECT id, user_id, name,
             ROW_NUMBER() OVER (PARTITION BY user_id, name ORDER BY created_at, id) AS rn
      FROM user_commands
    )
    UPDATE user_commands uc
    SET name = uc.name || '-' || dups.rn::text
    FROM dups
    WHERE uc.id = dups.id AND dups.rn > 1
  `);

  // Idempotent: re-running is a no-op if the index already exists.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_user_commands_user_name
      ON user_commands(user_id, name)
  `);
}
