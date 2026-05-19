/**
 * Lessons-Keeper v1 migration
 *
 * Adds the per-user-per-project `lessons` table — a small registry of
 * distilled notes powering the `%[lesson:slug]` mention sigil in chat.
 * The runtime distiller (Phase 3 of the plan) writes user-scoped rows
 * after qualifying conversations; users can later promote those rows
 * up the visibility ladder (`user` → `project` → `global`).
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - lessons (id, project_id FK CASCADE, owner_id FK CASCADE,
 *     visibility ∈ {'user','project','global'}, slug, title, body,
 *     frontmatter JSONB, source ∈ {'distiller','user'}, source_sha256,
 *     fired_count, last_fired_at, dismissed_count, created_at,
 *     updated_at)
 *   - Two non-unique indexes for the hot lookup paths:
 *       idx_lessons_project_owner(project_id, owner_id)
 *       idx_lessons_visibility(project_id, visibility)
 *   - Two PARTIAL unique indexes implementing the visibility-aware
 *     slug-scope rule (PGlite supports `CREATE UNIQUE INDEX … WHERE`):
 *       idx_lessons_user_slug_unique(project_id, owner_id, slug)
 *         WHERE visibility = 'user'
 *       idx_lessons_shared_slug_unique(project_id, slug)
 *         WHERE visibility IN ('project','global')
 *     drizzle-orm has no portable partial-unique helper — we follow the
 *     same migration-only pattern that `agent_shares_agent_user_unique`
 *     uses (see migrate.ts:397).
 *
 * Visibility-precedence query semantics (NOT enforced at the DB —
 * see src/db/queries/lessons.ts):
 *   - getLessonBySlug walks user → project → global and returns the
 *     most-specific hit (single SQL query with ORDER BY priority).
 *   - listVisibleLessons unions user-owned + project-shared + global,
 *     deduped by slug favoring the most-specific scope.
 *
 * Counters semantics: `incrementFiredCount` bumps `last_fired_at` in
 * the same atomic UPDATE so the search-result ordering (by recency,
 * then frequency) stays consistent without a follow-up write.
 *
 * This migration is applied automatically via src/db/migrate.ts. This
 * file exists for documentation and parallels add-feature-index.ts.
 */
import { sql } from "drizzle-orm";

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility TEXT NOT NULL DEFAULT 'user',
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      frontmatter JSONB,
      source TEXT NOT NULL DEFAULT 'distiller',
      source_sha256 TEXT,
      fired_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at TIMESTAMP WITH TIME ZONE,
      dismissed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_project_owner ON lessons(project_id, owner_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_lessons_visibility ON lessons(project_id, visibility)`);

  // Partial unique indexes — slug uniqueness is visibility-scoped.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_user_slug_unique
      ON lessons(project_id, owner_id, slug)
      WHERE visibility = 'user'
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lessons_shared_slug_unique
      ON lessons(project_id, slug)
      WHERE visibility IN ('project', 'global')
  `);
}
