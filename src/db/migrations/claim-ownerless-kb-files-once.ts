/**
 * Adopt pre-existing ownerless `knowledge_base_files` rows to the first admin —
 * ONCE, ever, and never again.
 *
 * ## What was wrong
 *
 * This statement used to sit inline in `src/db/migrate.ts`, unguarded:
 *
 *   UPDATE knowledge_base_files
 *      SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
 *    WHERE user_id IS NULL;
 *
 * and `migrate()` runs on EVERY database open (`src/db/connection.ts`), not
 * once per version — this codebase has no migration version table, so every
 * boot re-executes the whole file. The statement is idempotent in the "won't
 * crash" sense the boot migration requires, but it is not *inert*: it keeps
 * claiming rows forever.
 *
 * That made `user_id IS NULL` — the knowledge base's ONLY sharing mechanism,
 * honoured by both read surfaces (`KB-SHARED-NULL-OWNER`, see
 * `web/src/routes/api/knowledge-base/+server.ts`) — evaporate at the next
 * restart. An operator would mark a file shared, everything would work, and
 * then a routine redeploy would silently hand it to the first admin and un-share
 * it. Sharing you cannot keep is not a feature.
 *
 * ## The guard
 *
 * A marker row in `settings`. The claim runs iff that marker is absent, and the
 * absence test is a `NOT EXISTS` **inside the UPDATE's own WHERE** rather than a
 * read-then-decide in TypeScript. Two reasons:
 *
 *   - it is one statement, so there is no window in which a concurrent boot can
 *     observe "not yet claimed" and re-run the adoption; and
 *   - it needs no result-row inspection, so it behaves identically on both
 *     drivers (PGlite and `Bun.sql`), whose `execute()` return shapes differ.
 *
 * ## Ordering, and why it composes with the migration circuit breaker
 *
 * The marker is written AFTER the adoption succeeds, and only by this function.
 * That gives at-least-once, never at-most-once:
 *
 *   - `src/db/connection.ts` skips `migrate()` entirely when a prior boot of the
 *     same image failed (the circuit breaker). Skipped `migrate()` ⇒ this
 *     function never runs ⇒ no marker ⇒ the adoption is still pending, and the
 *     first healthy boot performs it. A skip can never mark the work done.
 *   - If the UPDATE throws, we return WITHOUT writing the marker, so the next
 *     boot retries. Re-running is safe: the statement only touches rows that are
 *     still `NULL`, so it can never re-attribute a row that already has an owner.
 *   - `rollbackMigration()` restores the pre-boot snapshot, which predates the
 *     marker — again leaving the work pending rather than falsely complete.
 *
 * The swallow mirrors the "no-op if no admin user exists yet" catch on the
 * inline statement this replaces: a fresh install with no admin row yet is the
 * normal case, and it must not brick the boot. Note that case does not actually
 * raise — the scalar subquery yields NULL and the UPDATE is a no-op — so the
 * catch is defence in depth, not the happy path.
 *
 * ## Scope
 *
 * `knowledge_base_files` ONLY. The sibling backfills in `migrate.ts`
 * (`conversations`, `memories`, `agent_configs`) stay as they are: none of them
 * uses a null owner to mean "shared", so re-running them costs nothing and
 * removing their re-run would change behaviour for no benefit.
 *
 * Applied from `src/db/migrate.ts`, which calls `up()` and does not re-inline
 * the SQL — mirroring `backfill-api-key-write-scope.ts`.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "./types";

/**
 * Settings key recording that the one-shot adoption has been performed.
 * Exported so tests can assert on it by identity rather than by a copied
 * string literal.
 */
export const KB_OWNERLESS_CLAIM_MARKER_KEY = "migration:kb-ownerless-claim-v1";

export async function up(db: MigrationDb): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE knowledge_base_files
         SET user_id = (SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1)
       WHERE user_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM settings WHERE key = ${KB_OWNERLESS_CLAIM_MARKER_KEY})
    `);
  } catch {
    // Left unmarked on purpose — the next boot retries (see "Ordering" above).
    return;
  }
  // `to_jsonb(now()::text)` stores a scalar JSON string on both drivers without
  // the object-vs-`::jsonb`-text binding split raw jsonb values suffer from
  // (same idiom as the jsonb-repair marker in `src/db/connection.ts`).
  await db.execute(sql`
    INSERT INTO settings (key, value)
    VALUES (${KB_OWNERLESS_CLAIM_MARKER_KEY}, to_jsonb(now()::text))
    ON CONFLICT (key) DO NOTHING
  `);
}
