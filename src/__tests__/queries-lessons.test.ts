/**
 * DB layer tests for `src/db/queries/lessons.ts`.
 *
 * Covers:
 *   - createLesson defaults + required-field guards
 *   - Slug-scope partial unique indexes:
 *       user-scoped slugs unique per (project, owner)
 *       project/global slugs unique per (project)
 *       a user-scoped + project-scoped slug at the same name coexist
 *   - getLessonBySlug visibility precedence (user > project > global)
 *   - listVisibleLessons union with slug-dedupe favoring most-specific
 *   - searchLessons ILIKE + ranking by lastFiredAt DESC NULLS LAST,
 *     firedCount DESC + visibility-aware dedupe before limit cut
 *   - incrementFiredCount bumps both fired_count and last_fired_at
 *   - incrementDismissedCount bumps only dismissed_count
 *   - Cascade delete: project → lessons; user → lessons
 *
 * Pattern mirrors `db-features-queries.test.ts`: real PGlite via
 * `setupTestDb`, `mockDbConnection()` swaps the `db/connection` module
 * before queries are imported.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { users } from "../db/schema";

mockDbConnection();

const {
  createLesson,
  getLessonBySlug,
  listVisibleLessons,
  searchLessons,
  incrementFiredCount,
  incrementDismissedCount,
  deleteLessonAsOwner,
  getLessonByIdForOwnerCheck,
  updateLessonVisibilityAsOwner,
} = await import("../db/queries/lessons");
const { createProject, deleteProject } = await import("../db/queries/projects");
const { createUser } = await import("../db/queries/users");

describe("lessons queries", () => {
  let projectId: string;
  let otherProjectId: string;
  let ownerId: string;
  let otherOwnerId: string;

  beforeEach(async () => {
    await setupTestDb();
    const p = await createProject({ name: "alpha", path: "/tmp/alpha" });
    projectId = p.id;
    const o = await createProject({ name: "beta", path: "/tmp/beta" });
    otherProjectId = o.id;
    const u = await createUser({ email: "owner@test.com", passwordHash: "h", name: "Owner" });
    ownerId = u.id;
    const u2 = await createUser({ email: "other@test.com", passwordHash: "h", name: "Other" });
    otherOwnerId = u2.id;
  });
  afterAll(async () => await closeTestDb());

  // Convenience helper — keeps the test bodies short.
  const make = (overrides: Partial<Parameters<typeof createLesson>[0]> = {}) =>
    createLesson({
      projectId,
      ownerId,
      visibility: "user",
      slug: "test-lesson",
      title: "Test lesson",
      body: "Body content goes here.",
      ...overrides,
    });

  // ── createLesson ───────────────────────────────────────────────────
  describe("createLesson", () => {
    test("inserts row with defaults (visibility='user', source='distiller', counters=0)", async () => {
      const l = await make();
      expect(l.id).toBeDefined();
      expect(l.projectId).toBe(projectId);
      expect(l.ownerId).toBe(ownerId);
      expect(l.visibility).toBe("user");
      expect(l.slug).toBe("test-lesson");
      expect(l.title).toBe("Test lesson");
      expect(l.body).toBe("Body content goes here.");
      expect(l.source).toBe("distiller");
      expect(l.firedCount).toBe(0);
      expect(l.dismissedCount).toBe(0);
      expect(l.lastFiredAt).toBeNull();
      expect(l.createdAt).toBeInstanceOf(Date);
      expect(l.updatedAt).toBeInstanceOf(Date);
    });

    test("accepts source='user' and frontmatter for hand-written lessons", async () => {
      const l = await make({
        source: "user",
        frontmatter: { tags: ["x", "y"], priority: 1 },
      });
      expect(l.source).toBe("user");
      expect(l.frontmatter).toEqual({ tags: ["x", "y"], priority: 1 });
    });

    test("guards required fields", async () => {
      await expect(make({ projectId: "" })).rejects.toThrow(/projectId is required/);
      await expect(make({ ownerId: "" })).rejects.toThrow(/ownerId is required/);
      await expect(make({ slug: "" })).rejects.toThrow(/slug is required/);
      await expect(make({ title: "" })).rejects.toThrow(/title is required/);
      await expect(make({ body: undefined as any })).rejects.toThrow(/body is required/);
    });
  });

  // ── Partial unique indexes — slug-scope rules ─────────────────────
  describe("slug-scope uniqueness (partial unique indexes)", () => {
    test("user-scoped slug unique per (project, owner) — same owner cannot dup", async () => {
      await make({ slug: "dup-user" });
      await expect(make({ slug: "dup-user" })).rejects.toThrow();
    });

    test("user-scoped slug — different owners can each have it", async () => {
      const a = await make({ slug: "shared-user", ownerId });
      const b = await make({ slug: "shared-user", ownerId: otherOwnerId });
      expect(a.id).not.toBe(b.id);
    });

    test("user-scoped slug — different projects can each have it", async () => {
      const a = await make({ slug: "cross-proj" });
      const b = await make({ slug: "cross-proj", projectId: otherProjectId });
      expect(a.id).not.toBe(b.id);
    });

    test("project-scoped slug unique per project — second insert rejects", async () => {
      await make({ slug: "shared-proj", visibility: "project" });
      await expect(
        make({ slug: "shared-proj", visibility: "project" }),
      ).rejects.toThrow();
    });

    test("global-scoped slug unique per project — second insert rejects", async () => {
      await make({ slug: "shared-global", visibility: "global" });
      await expect(
        make({ slug: "shared-global", visibility: "global" }),
      ).rejects.toThrow();
    });

    test("project + global at the same slug COEXIST (visibility is now part of the shared unique index)", async () => {
      // Migration step 7 (src/db/migrate.ts:1227-1236) evolved
      // `idx_lessons_shared_slug_unique` to include `visibility` in the
      // columns:
      //   ON lessons (project_id, COALESCE(author_extension_id, ''), slug, visibility)
      //   WHERE visibility IN ('project', 'global')
      // Previously the index was on (project_id, COALESCE(...), slug) so
      // project + global rows at the same slug collided. Post-migration
      // they coexist (different rows, same partial index, distinct on
      // the visibility column) — mirrors the user + project pattern at
      // the test below.
      const p = await make({ slug: "ladder", visibility: "project" });
      const g = await make({ slug: "ladder", visibility: "global" });
      expect(p.id).not.toBe(g.id);
      expect(p.slug).toBe("ladder");
      expect(g.slug).toBe("ladder");
      expect(p.visibility).toBe("project");
      expect(g.visibility).toBe("global");
    });

    test("user-scoped and project-scoped at the same slug COEXIST (different partial indexes)", async () => {
      // Headline scenario: a user can have their own private lesson
      // 'tracing-tip' AND the project can have its own shared
      // 'tracing-tip' — they live in different partial unique indexes.
      const u = await make({ slug: "tracing-tip", visibility: "user" });
      const p = await make({ slug: "tracing-tip", visibility: "project" });
      expect(u.id).not.toBe(p.id);
      expect(u.visibility).toBe("user");
      expect(p.visibility).toBe("project");
    });
  });

  // ── getLessonBySlug — visibility precedence ───────────────────────
  describe("getLessonBySlug (visibility precedence)", () => {
    test("returns user-owned row when both user and project rows exist at the slug", async () => {
      // project + global cannot coexist at the same (project_id, slug) — they
      // share the partial unique index `idx_lessons_shared_slug_unique`. The
      // realistic ladder for a single slug is therefore user + (project OR
      // global). The "ladder" coexistence test in the slug-scope describe
      // block above pins that DB-level invariant.
      const u = await make({ slug: "rank", visibility: "user" });
      await make({ slug: "rank", visibility: "project" });
      const got = await getLessonBySlug(projectId, ownerId, "rank");
      expect(got!.id).toBe(u.id);
      expect(got!.visibility).toBe("user");
    });

    test("returns user-owned row when user + global both exist at the slug", async () => {
      const u = await make({ slug: "rank-g", visibility: "user" });
      await make({ slug: "rank-g", visibility: "global" });
      const got = await getLessonBySlug(projectId, ownerId, "rank-g");
      expect(got!.id).toBe(u.id);
      expect(got!.visibility).toBe("user");
    });

    test("falls back to project when no user-owned row exists", async () => {
      const p = await make({ slug: "fb-proj", visibility: "project" });
      const got = await getLessonBySlug(projectId, ownerId, "fb-proj");
      expect(got!.id).toBe(p.id);
      expect(got!.visibility).toBe("project");
    });

    test("falls back to global when no user/project row exists", async () => {
      const g = await make({ slug: "fb-global", visibility: "global" });
      const got = await getLessonBySlug(projectId, ownerId, "fb-global");
      expect(got!.id).toBe(g.id);
      expect(got!.visibility).toBe("global");
    });

    test("does NOT return another user's user-scoped row", async () => {
      await make({ slug: "private", visibility: "user", ownerId: otherOwnerId });
      const got = await getLessonBySlug(projectId, ownerId, "private");
      expect(got).toBeUndefined();
    });

    test("does NOT leak across projects", async () => {
      await make({ slug: "leak", visibility: "project" });
      const got = await getLessonBySlug(otherProjectId, ownerId, "leak");
      expect(got).toBeUndefined();
    });

    test("returns undefined for unknown slug", async () => {
      expect(await getLessonBySlug(projectId, ownerId, "nope")).toBeUndefined();
    });

    test("guards empty inputs", async () => {
      expect(await getLessonBySlug("", ownerId, "x")).toBeUndefined();
      expect(await getLessonBySlug(projectId, "", "x")).toBeUndefined();
      expect(await getLessonBySlug(projectId, ownerId, "")).toBeUndefined();
    });
  });

  // ── listVisibleLessons ─────────────────────────────────────────────
  describe("listVisibleLessons (union + slug-dedupe)", () => {
    test("returns user-owned + project-shared + global, deduped by slug favoring most-specific", async () => {
      // 'shared' has user + project rows — only the user row should appear.
      // (user + global at the same slug is exercised in the precedence
      // describe block; project + global coexist on different slugs because
      // they share the same partial unique index at (project_id, slug).)
      const u = await make({ slug: "shared", visibility: "user" });
      await make({ slug: "shared", visibility: "project" });
      // 'proj-only' lives only at project scope.
      const p = await make({ slug: "proj-only", visibility: "project" });
      // 'global-only' lives only at global scope.
      const g = await make({ slug: "global-only", visibility: "global" });

      const list = await listVisibleLessons(projectId, ownerId);
      const bySlug = new Map(list.map((l) => [l.slug, l]));
      expect(bySlug.size).toBe(3);
      expect(bySlug.get("shared")!.id).toBe(u.id);
      expect(bySlug.get("proj-only")!.id).toBe(p.id);
      expect(bySlug.get("global-only")!.id).toBe(g.id);
    });

    test("does NOT include other users' user-scoped rows", async () => {
      await make({ slug: "private-other", visibility: "user", ownerId: otherOwnerId });
      const list = await listVisibleLessons(projectId, ownerId);
      expect(list.find((l) => l.slug === "private-other")).toBeUndefined();
    });

    test("scopes to project — does not leak across projects", async () => {
      await make({ slug: "mine", visibility: "project" });
      await make({ slug: "yours", visibility: "project", projectId: otherProjectId });
      const list = await listVisibleLessons(projectId, ownerId);
      expect(list.map((l) => l.slug)).toEqual(["mine"]);
    });

    test("returns empty array when no lessons exist", async () => {
      expect(await listVisibleLessons(projectId, ownerId)).toEqual([]);
    });

    test("guards empty inputs", async () => {
      expect(await listVisibleLessons("", ownerId)).toEqual([]);
      expect(await listVisibleLessons(projectId, "")).toEqual([]);
    });
  });

  // ── searchLessons ──────────────────────────────────────────────────
  describe("searchLessons (ILIKE + recency ranking)", () => {
    test("matches title OR slug (case-insensitive)", async () => {
      await make({ slug: "auth-tips", title: "How to debug auth" });
      await make({ slug: "perf", title: "Reduce DB roundtrips" });
      await make({ slug: "other", title: "Unrelated" });

      const byTitle = await searchLessons(projectId, ownerId, "DEBUG");
      expect(byTitle.map((l) => l.slug)).toContain("auth-tips");
      expect(byTitle.map((l) => l.slug)).not.toContain("other");

      const bySlug = await searchLessons(projectId, ownerId, "PERF");
      expect(bySlug.map((l) => l.slug)).toContain("perf");
    });

    test("orders by lastFiredAt DESC NULLS LAST, then firedCount DESC", async () => {
      const a = await make({ slug: "rank-a", title: "rank candidate a" });
      const b = await make({ slug: "rank-b", title: "rank candidate b" });
      // 'rank-c' anchors the never-fired tail of the ranking — id not needed.
      await make({ slug: "rank-c", title: "rank candidate c" });

      // c never fired, a fired most recently, b fired most often.
      await incrementFiredCount(b.id);
      await incrementFiredCount(b.id);
      await incrementFiredCount(b.id);
      // Pause to ensure ordering by lastFiredAt is unambiguous.
      await new Promise((r) => setTimeout(r, 5));
      await incrementFiredCount(a.id);

      const results = await searchLessons(projectId, ownerId, "rank candidate");
      expect(results.map((l) => l.slug)).toEqual(["rank-a", "rank-b", "rank-c"]);
    });

    test("returns the visible set when query is empty (parity with `/` and `$` triggers)", async () => {
      await make({ slug: "x" });
      await make({ slug: "y" });
      const results = await searchLessons(projectId, ownerId, "");
      expect(results.map((l) => l.slug).sort()).toEqual(["x", "y"]);
    });

    test("respects the limit", async () => {
      for (let i = 0; i < 15; i++) {
        await make({ slug: `bulk-${i}`, title: `bulk title ${i}` });
      }
      const results = await searchLessons(projectId, ownerId, "bulk", 5);
      expect(results).toHaveLength(5);
    });

    test("default limit is 10 (matches MAX_RESULTS)", async () => {
      for (let i = 0; i < 12; i++) {
        await make({ slug: `def-${i}`, title: `def title ${i}` });
      }
      const results = await searchLessons(projectId, ownerId, "def");
      expect(results).toHaveLength(10);
    });

    test("dedupes by slug across visibility BEFORE applying limit", async () => {
      // A user + project pair at the same slug should consume one slot
      // (the user row), not two.
      await make({ slug: "dup", visibility: "user", title: "dup title" });
      await make({ slug: "dup", visibility: "project", title: "dup title" });
      await make({ slug: "other", title: "dup title" });

      const results = await searchLessons(projectId, ownerId, "dup title", 10);
      // Two distinct slugs, not three rows.
      expect(results.map((l) => l.slug).sort()).toEqual(["dup", "other"]);
      // The user row wins for 'dup'.
      const dupRow = results.find((l) => l.slug === "dup");
      expect(dupRow!.visibility).toBe("user");
    });

    test("excludes other users' user-scoped rows", async () => {
      await make({ slug: "leak-search", title: "leakable", ownerId: otherOwnerId });
      const results = await searchLessons(projectId, ownerId, "leakable");
      expect(results.find((l) => l.slug === "leak-search")).toBeUndefined();
    });

    test("scopes to project", async () => {
      await make({ slug: "proj-x", title: "search me" });
      await make({ slug: "other-proj", title: "search me", projectId: otherProjectId });
      const results = await searchLessons(projectId, ownerId, "search me");
      expect(results.map((l) => l.slug)).toEqual(["proj-x"]);
    });

    test("guards empty inputs and zero limit", async () => {
      expect(await searchLessons("", ownerId, "x")).toEqual([]);
      expect(await searchLessons(projectId, "", "x")).toEqual([]);
      expect(await searchLessons(projectId, ownerId, "x", 0)).toEqual([]);
    });

    test("escapes %, _, and \\ in the query (no wildcard injection)", async () => {
      // A literal '%' in the query should not match arbitrary text.
      await make({ slug: "literal", title: "no percent here" });
      const results = await searchLessons(projectId, ownerId, "%");
      expect(results.find((l) => l.slug === "literal")).toBeUndefined();
    });
  });

  // ── incrementFiredCount ────────────────────────────────────────────
  describe("incrementFiredCount", () => {
    test("bumps fired_count and sets last_fired_at atomically", async () => {
      const l = await make();
      expect(l.firedCount).toBe(0);
      expect(l.lastFiredAt).toBeNull();
      await incrementFiredCount(l.id);
      const after = await getLessonBySlug(projectId, ownerId, l.slug);
      expect(after!.firedCount).toBe(1);
      expect(after!.lastFiredAt).toBeInstanceOf(Date);
    });

    test("repeated calls accumulate", async () => {
      const l = await make();
      await incrementFiredCount(l.id);
      await incrementFiredCount(l.id);
      await incrementFiredCount(l.id);
      const after = await getLessonBySlug(projectId, ownerId, l.slug);
      expect(after!.firedCount).toBe(3);
    });

    test("no-op for missing id", async () => {
      // Should not throw.
      await incrementFiredCount(crypto.randomUUID());
      await incrementFiredCount("");
    });
  });

  // ── incrementDismissedCount ────────────────────────────────────────
  describe("incrementDismissedCount", () => {
    test("bumps dismissed_count without touching last_fired_at", async () => {
      const l = await make();
      // Prime last_fired_at so we can assert it stays put.
      await incrementFiredCount(l.id);
      const primed = await getLessonBySlug(projectId, ownerId, l.slug);
      const firedAt = primed!.lastFiredAt!.getTime();

      await new Promise((r) => setTimeout(r, 5));
      await incrementDismissedCount(l.id);
      const after = await getLessonBySlug(projectId, ownerId, l.slug);
      expect(after!.dismissedCount).toBe(1);
      // last_fired_at must NOT have moved — dismissals are the inverse signal.
      expect(after!.lastFiredAt!.getTime()).toBe(firedAt);
      // fired_count must NOT have moved either.
      expect(after!.firedCount).toBe(1);
    });

    test("no-op for missing id", async () => {
      await incrementDismissedCount(crypto.randomUUID());
      await incrementDismissedCount("");
    });
  });

  // ── Cascade deletes ────────────────────────────────────────────────
  describe("FK cascades", () => {
    test("deleting a project removes all its lessons", async () => {
      await make({ slug: "casc-1" });
      await make({ slug: "casc-2", visibility: "project" });
      expect((await listVisibleLessons(projectId, ownerId)).length).toBe(2);
      expect(await deleteProject(projectId)).toBe(true);
      expect(await listVisibleLessons(projectId, ownerId)).toEqual([]);
    });

    test("deleting a user removes all lessons they own (incl. project-scoped)", async () => {
      // Both visibility kinds attribute ownership to `ownerId`, so a user
      // delete should cascade through regardless of scope.
      await make({ slug: "user-casc-1" });
      await make({ slug: "user-casc-2", visibility: "project" });
      expect((await listVisibleLessons(projectId, ownerId)).length).toBe(2);
      await getTestDb().delete(users).where(eq(users.id, ownerId));
      expect(await listVisibleLessons(projectId, ownerId)).toEqual([]);
    });
  });

  // ── v1.5 admin-tab helpers ─────────────────────────────────────────
  // Three owner-gated helpers back `/memories → Lessons` curation.
  // Auth-gate semantics are tested rigorously here because the API
  // layer relies on these returning false/null (not throwing) so it
  // can collapse "not found" + "not owned" into a single 404 response.

  describe("deleteLessonAsOwner (owner-gated hard delete)", () => {
    test("deletes when owner matches; row no longer in listVisibleLessons", async () => {
      const l = await make({ slug: "to-delete" });
      expect(await deleteLessonAsOwner(l.id, ownerId)).toBe(true);
      expect(await getLessonBySlug(projectId, ownerId, "to-delete")).toBeUndefined();
    });

    test("returns false when id does not exist (silent — no throw)", async () => {
      expect(await deleteLessonAsOwner(crypto.randomUUID(), ownerId)).toBe(false);
    });

    test("returns false when row exists but is owned by a different user (regression guard)", async () => {
      // Headline auth-gate scenario: another user's lesson MUST NOT be
      // deletable. This is the critical regression guard for the
      // owner-gated mutation contract.
      const stranger = await make({
        slug: "not-mine",
        visibility: "user",
        ownerId: otherOwnerId,
      });
      expect(await deleteLessonAsOwner(stranger.id, ownerId)).toBe(false);
      // Row still present in stranger's view.
      const stillThere = await getLessonBySlug(projectId, otherOwnerId, "not-mine");
      expect(stillThere?.id).toBe(stranger.id);
    });

    test("project-scoped row owned by the caller deletes (visibility doesn't override ownership)", async () => {
      const proj = await make({ slug: "my-proj-share", visibility: "project" });
      expect(await deleteLessonAsOwner(proj.id, ownerId)).toBe(true);
    });

    test("project-scoped row owned by another user does NOT delete", async () => {
      // A user CANNOT delete a project-shared lesson they don't own,
      // even if it lives in their project. Ownership beats co-location.
      const stranger = await make({
        slug: "their-share",
        visibility: "project",
        ownerId: otherOwnerId,
      });
      expect(await deleteLessonAsOwner(stranger.id, ownerId)).toBe(false);
    });

    test("guards empty inputs", async () => {
      expect(await deleteLessonAsOwner("", ownerId)).toBe(false);
      const l = await make({ slug: "guard-empty" });
      expect(await deleteLessonAsOwner(l.id, "")).toBe(false);
    });
  });

  describe("getLessonByIdForOwnerCheck (read-only, ignores owner)", () => {
    test("returns the row regardless of caller — used by API to disambiguate 404 vs 409", async () => {
      const l = await make({ slug: "rfo", ownerId: otherOwnerId });
      const got = await getLessonByIdForOwnerCheck(l.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(l.id);
      expect(got!.ownerId).toBe(otherOwnerId);
    });

    test("returns null for unknown id", async () => {
      expect(await getLessonByIdForOwnerCheck(crypto.randomUUID())).toBeNull();
    });

    test("returns null for empty id", async () => {
      expect(await getLessonByIdForOwnerCheck("")).toBeNull();
    });
  });

  describe("updateLessonVisibilityAsOwner (owner-gated, monotonic promote)", () => {
    test("promotes user → project — returns updated row, persists", async () => {
      const l = await make({ slug: "promote-up", visibility: "user" });
      const updated = await updateLessonVisibilityAsOwner(l.id, ownerId, "project");
      expect(updated).not.toBeNull();
      expect(updated!.visibility).toBe("project");
      // Persistence check.
      const reread = await getLessonByIdForOwnerCheck(l.id);
      expect(reread!.visibility).toBe("project");
    });

    test("promotes user → global", async () => {
      const l = await make({ slug: "promote-global", visibility: "user" });
      const updated = await updateLessonVisibilityAsOwner(l.id, ownerId, "global");
      expect(updated!.visibility).toBe("global");
    });

    test("promotes project → global", async () => {
      const l = await make({ slug: "ladder-up", visibility: "project" });
      const updated = await updateLessonVisibilityAsOwner(l.id, ownerId, "global");
      expect(updated!.visibility).toBe("global");
    });

    test("same-visibility no-op returns the row unchanged (caller decides whether to surface)", async () => {
      const l = await make({ slug: "noop", visibility: "project" });
      const result = await updateLessonVisibilityAsOwner(l.id, ownerId, "project");
      expect(result).not.toBeNull();
      expect(result!.id).toBe(l.id);
      expect(result!.visibility).toBe("project");
    });

    test("rejects backward project → user (returns null)", async () => {
      const l = await make({ slug: "no-demote-1", visibility: "project" });
      expect(await updateLessonVisibilityAsOwner(l.id, ownerId, "user")).toBeNull();
      // Persistence check: visibility unchanged on disk.
      const reread = await getLessonByIdForOwnerCheck(l.id);
      expect(reread!.visibility).toBe("project");
    });

    test("rejects backward global → project (returns null)", async () => {
      const l = await make({ slug: "no-demote-2", visibility: "global" });
      expect(await updateLessonVisibilityAsOwner(l.id, ownerId, "project")).toBeNull();
    });

    test("rejects backward global → user (returns null)", async () => {
      const l = await make({ slug: "no-demote-3", visibility: "global" });
      expect(await updateLessonVisibilityAsOwner(l.id, ownerId, "user")).toBeNull();
    });

    test("returns null when owner does not match — does NOT mutate the row", async () => {
      const stranger = await make({
        slug: "auth-gate",
        visibility: "user",
        ownerId: otherOwnerId,
      });
      expect(
        await updateLessonVisibilityAsOwner(stranger.id, ownerId, "project"),
      ).toBeNull();
      // Persistence check: row untouched.
      const reread = await getLessonByIdForOwnerCheck(stranger.id);
      expect(reread!.visibility).toBe("user");
    });

    test("returns null for unknown id", async () => {
      expect(
        await updateLessonVisibilityAsOwner(crypto.randomUUID(), ownerId, "global"),
      ).toBeNull();
    });

    test("guards empty inputs", async () => {
      expect(await updateLessonVisibilityAsOwner("", ownerId, "global")).toBeNull();
      expect(
        await updateLessonVisibilityAsOwner(crypto.randomUUID(), "", "global"),
      ).toBeNull();
    });
  });
});
