/**
 * Daily Briefing migration (Phase 1 — engine)
 *
 * Adds `briefing_configs` — the per-user Daily Briefing configuration
 * table consumed by the BriefingDaemon (src/runtime/briefing/daemon.ts)
 * and the /api/briefing/* routes.
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - briefing_configs (user_id PK FK CASCADE → users, enabled, cron,
 *     timezone, project_id FK SET NULL → projects, instructions,
 *     watchlist jsonb, model, provider, last_fire_at, last_fire_status,
 *     consecutive_errors, next_fire_at, created_at, updated_at)
 *   - Index on (enabled, next_fire_at) — the daemon's claim scan.
 *
 * Invariants (enforced at the query/daemon layer, not the DB):
 *   - `next_fire_at` IS the claim queue: the daemon claims due rows
 *     via SELECT … FOR UPDATE SKIP LOCKED and advances `next_fire_at`
 *     to the next cron slot BEFORE dispatching (at-most-once delivery,
 *     mirroring extension_schedules).
 *   - `consecutive_errors >= 5` auto-disables the config (the daemon
 *     flips `enabled` to false and posts a one-time notification
 *     conversation).
 *   - `cron` is validated by `parseCron` (src/extensions/cron.ts),
 *     including its 5-minute minimum-interval gate; `timezone` is
 *     validated via Intl at the API layer.
 *
 * This migration is applied automatically via src/db/migrate.ts. This
 * file exists for documentation and parallels add-feature-index.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS briefing_configs (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      cron TEXT NOT NULL DEFAULT '0 7 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      instructions TEXT NOT NULL DEFAULT '',
      watchlist JSONB NOT NULL DEFAULT '[]',
      model TEXT,
      provider TEXT,
      last_fire_at TIMESTAMP WITH TIME ZONE,
      last_fire_status TEXT,
      consecutive_errors INTEGER NOT NULL DEFAULT 0,
      next_fire_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_briefing_ready ON briefing_configs(enabled, next_fire_at)`);
}
