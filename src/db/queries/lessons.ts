import { and, eq, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { lessons, type Lesson, type NewLesson } from "../schema";

/**
 * Per-user-per-project lesson queries.
 *
 * Drives the `%[lesson:slug]` mention sigil. The visibility ladder
 * (`user` → `project` → `global`) is purely a query-layer concern —
 * the DB enforces only slug uniqueness via partial indexes (declared
 * in src/db/migrations/add-lessons.ts). All "most-specific scope wins"
 * logic lives here.
 *
 * Lookup precedence: a user's own row beats a project-shared row,
 * which beats a global row. Two callers exercise this:
 *   - getLessonBySlug — single-row lookup, ORDER BY priority + LIMIT 1
 *   - listVisibleLessons — full visible-set listing, dedupe by slug
 *     keeping the highest-priority row
 *
 * See tasks/lessons-keeper-v1.md for the full design.
 */

/**
 * Insert a lesson row. Throws on the partial-unique-index collision
 * (slug already taken at this visibility scope). Callers handle the
 * collision; this module is mechanical CRUD only.
 */
export async function createLesson(input: NewLesson): Promise<Lesson> {
  if (!input.projectId) throw new Error("projectId is required");
  if (!input.ownerId) throw new Error("ownerId is required");
  if (!input.slug) throw new Error("slug is required");
  if (!input.title) throw new Error("title is required");
  if (input.body === undefined || input.body === null) {
    throw new Error("body is required");
  }
  const rows = (await getDb().insert(lessons).values(input).returning()) as Lesson[];
  return rows[0]!;
}

/**
 * Look up a single lesson by slug, applying visibility precedence.
 *
 * Resolution order (most-specific wins):
 *   1. user-scoped row owned by this user in this project
 *   2. project-scoped row in this project
 *   3. global row in this project (v2 surface; included for forward-
 *      compat — global rows still live in the per-project table for v1)
 *
 * Single SQL query: ORDER BY a derived priority column + LIMIT 1.
 * Returns undefined when no row matches at any scope (silent no-op
 * for the mention expander, mirroring `@[file:…]` for missing files).
 */
export async function getLessonBySlug(
  projectId: string,
  ownerId: string,
  slug: string,
): Promise<Lesson | undefined> {
  if (!projectId || !ownerId || !slug) return undefined;
  const db = getDb();
  const rows = (await db
    .select()
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        eq(lessons.slug, slug),
        or(
          and(eq(lessons.visibility, "user"), eq(lessons.ownerId, ownerId)),
          eq(lessons.visibility, "project"),
          eq(lessons.visibility, "global"),
        ),
      ),
    )
    .orderBy(
      // CASE expression returns 0/1/2 so user beats project beats global.
      sql`CASE ${lessons.visibility} WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END`,
    )
    .limit(1)) as Lesson[];
  return rows[0];
}

/**
 * List every lesson visible to (projectId, ownerId), deduped by slug
 * with most-specific scope winning. Returned in priority order:
 * user-owned first, then project-shared, then global.
 *
 * Implementation: a single SELECT with the same priority CASE used in
 * getLessonBySlug, then a TS-side dedupe pass keyed by slug. PGlite
 * supports `DISTINCT ON` but the post-filter in TS is simpler, equally
 * cheap at this row scale, and keeps the SQL portable across PGlite +
 * external Postgres without driver-specific quirks.
 */
export async function listVisibleLessons(
  projectId: string,
  ownerId: string,
): Promise<Lesson[]> {
  if (!projectId || !ownerId) return [];
  const db = getDb();
  const rows = (await db
    .select()
    .from(lessons)
    .where(
      and(
        eq(lessons.projectId, projectId),
        or(
          and(eq(lessons.visibility, "user"), eq(lessons.ownerId, ownerId)),
          eq(lessons.visibility, "project"),
          eq(lessons.visibility, "global"),
        ),
      ),
    )
    .orderBy(
      sql`CASE ${lessons.visibility} WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END`,
      lessons.slug,
    )) as Lesson[];

  // Dedupe by slug — first occurrence wins because rows are already
  // ordered by visibility-priority.
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(r);
  }
  return out;
}

/**
 * Search visible lessons by ILIKE on title + slug, scoped to
 * (projectId, ownerId). Powers the `%`-trigger mention popover via
 * the `/api/mentions/search?type=lesson` endpoint added in Phase 2.
 *
 * Ordering matches the popover ranking spec from the plan:
 *   1. lastFiredAt DESC NULLS LAST (most-recently-fired first)
 *   2. firedCount DESC (most-frequently-fired next)
 *
 * Slug-dedupe with visibility precedence is applied before the limit
 * cut so the user never sees a project/global row when their own
 * user-scoped row exists at the same slug.
 *
 * Default `limit` is 10 to match `MAX_RESULTS` in the search endpoint.
 */
export async function searchLessons(
  projectId: string,
  ownerId: string,
  query: string,
  limit = 10,
): Promise<Lesson[]> {
  if (!projectId || !ownerId) return [];
  if (limit <= 0) return [];
  const db = getDb();
  const q = (query ?? "").trim();
  // Empty query → return the visibility-deduped recently-used set,
  // matching how `/` and `$` mention popovers behave on bare-trigger.
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

  const conditions = [
    eq(lessons.projectId, projectId),
    or(
      and(eq(lessons.visibility, "user"), eq(lessons.ownerId, ownerId)),
      eq(lessons.visibility, "project"),
      eq(lessons.visibility, "global"),
    ),
  ];
  if (q.length > 0) {
    // ILIKE on title OR slug. The escape character is the default `\`
    // (PG14+ treats it as the LIKE escape unless overridden).
    conditions.push(
      or(
        sql`${lessons.title} ILIKE ${pattern}`,
        sql`${lessons.slug} ILIKE ${pattern}`,
      )!,
    );
  }

  const rows = (await db
    .select()
    .from(lessons)
    .where(and(...conditions))
    .orderBy(
      sql`CASE ${lessons.visibility} WHEN 'user' THEN 0 WHEN 'project' THEN 1 ELSE 2 END`,
      sql`${lessons.lastFiredAt} DESC NULLS LAST`,
      sql`${lessons.firedCount} DESC`,
    )) as Lesson[];

  // Visibility-dedupe by slug (most-specific wins — first occurrence
  // is highest priority because of the CASE ordering above), then cut
  // to limit. Doing the cut AFTER dedupe means a paired user+project
  // row at the same slug doesn't waste a result slot.
  const seen = new Set<string>();
  const out: Lesson[] = [];
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Atomically bump fired_count + last_fired_at. Single UPDATE — no
 * read-modify-write race. Returns nothing; the mention expander treats
 * a missing row as a silent no-op (the matching getLessonBySlug call
 * has already returned undefined in that case).
 */
export async function incrementFiredCount(lessonId: string): Promise<void> {
  if (!lessonId) return;
  await getDb()
    .update(lessons)
    .set({
      firedCount: sql`${lessons.firedCount} + 1`,
      lastFiredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(lessons.id, lessonId));
}

/**
 * Atomically bump dismissed_count. Same shape as incrementFiredCount
 * but does NOT touch lastFiredAt — a dismissal is the inverse signal
 * and must not promote the row in the recency-ranked search results.
 *
 * v1.5 wires the popover dismissal UI through this; v1 just keeps the
 * column primed so the data is collected from day one.
 */
export async function incrementDismissedCount(lessonId: string): Promise<void> {
  if (!lessonId) return;
  await getDb()
    .update(lessons)
    .set({
      dismissedCount: sql`${lessons.dismissedCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(lessons.id, lessonId));
}
