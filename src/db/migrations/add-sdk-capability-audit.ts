/**
 * Phase 50 — Audit Foundation migration
 *
 * Lands the data-layer pieces of the v1.3 audit foundation in a single
 * idempotent bump:
 *
 *   1. `sdk_capability_calls` — high-volume per-call audit for Phase 51
 *      capability handlers (`ctx.llm`, `ctx.memory`, `ctx.lessons`,
 *      `ctx.schedule`, `ctx.events`). NOT NULL on `on_behalf_of`
 *      enforces the provenance contract at schema level — no row can
 *      be inserted without a verified user attribution. Per-capability
 *      retention thresholds are swept hourly by
 *      `src/startup/background-timers.ts` reading
 *      `global:sdk{Llm,Memory,Lessons,Schedule}RetentionDays`
 *      settings (defaults 90/30/30/90).
 *
 *   2. `lessons_audit_log` — mirrors the existing `memory_audit_log`
 *      shape exactly. Captures full before/after body + frontmatter
 *      on every lesson mutation. Forever retention (small table,
 *      debugging gold). Cascade delete with the parent lesson row.
 *
 *   3. `lessons.author_extension_id` — additive nullable text column,
 *      FK extensions(id) ON DELETE SET NULL. Lands HERE so Phase 51's
 *      `ctx.lessons` handler doesn't need its own migration.
 *
 * All three changes use `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
 * for idempotency (re-running migrate.ts on an existing DB is a no-op).
 *
 * Related research: `.planning/research/PITFALLS.md` Pitfall #2 (audit
 * write failure aborting the call) — addressed via the
 * `recordCapabilityCall` wrapper landing in Phase 50.6, NOT via the
 * schema. This migration only provides the table; the dual-write
 * boundary is in the application layer.
 *
 * The actual SQL is appended to `src/db/migrate.ts` (the codebase's
 * convention is one consolidated migrate function with idempotent
 * blocks; this file exists for documentation and parallels
 * `add-lessons.ts`).
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  // sdk_capability_calls
  //
  // FK note: `on_behalf_of` is NOT NULL with ON DELETE RESTRICT.
  // The ALTER block further down upgrades any existing dev databases
  // that were created with the previous (inconsistent) ON DELETE
  // SET NULL spec. Fresh installs land with RESTRICT directly.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS sdk_capability_calls (
      id TEXT PRIMARY KEY,
      extension_id TEXT NOT NULL REFERENCES extensions(id) ON DELETE CASCADE,
      on_behalf_of TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      parent_call_id TEXT,
      capability TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      before JSONB,
      after JSONB,
      success BOOLEAN NOT NULL,
      duration_ms INTEGER NOT NULL,
      error_code TEXT,
      error_message TEXT,
      tokens_used INTEGER,
      cost_usd REAL,
      provider TEXT,
      model TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_ext_created ON sdk_capability_calls(extension_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_conv_created ON sdk_capability_calls(conversation_id, created_at DESC) WHERE conversation_id IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_user_capability_created ON sdk_capability_calls(on_behalf_of, capability, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_sdk_cap_created ON sdk_capability_calls(created_at DESC)`);

  // lessons_audit_log
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lessons_audit_log (
      id SERIAL PRIMARY KEY,
      lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      previous_body TEXT,
      new_body TEXT,
      previous_frontmatter JSONB,
      new_frontmatter JSONB,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_audit_lesson_created ON lessons_audit_log(lesson_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_audit_actor_ext_created ON lessons_audit_log(actor_extension_id, created_at DESC)`);

  // lessons.author_extension_id
  await db.execute(sql`
    ALTER TABLE lessons
      ADD COLUMN IF NOT EXISTS author_extension_id TEXT REFERENCES extensions(id) ON DELETE SET NULL
  `);

  // Defensive FK upgrade for sdk_capability_calls.on_behalf_of
  // (validator CR-2): the previous spec declared ON DELETE SET NULL,
  // which is inconsistent with the NOT NULL column constraint —
  // user-delete would FK-violate. We move to ON DELETE RESTRICT.
  //
  // This block is idempotent: drops the constraint if it exists under
  // its Postgres-default name, then re-adds with the new semantics.
  // Fresh installs hit the new shape directly via the CREATE TABLE
  // above; this ALTER is a no-op if the constraint name doesn't
  // exist (e.g. the table was just freshly created).
  await db.execute(sql`
    ALTER TABLE sdk_capability_calls
      DROP CONSTRAINT IF EXISTS sdk_capability_calls_on_behalf_of_fkey
  `);
  await db.execute(sql`
    ALTER TABLE sdk_capability_calls
      ADD CONSTRAINT sdk_capability_calls_on_behalf_of_fkey
      FOREIGN KEY (on_behalf_of) REFERENCES users(id) ON DELETE RESTRICT
  `);
}
