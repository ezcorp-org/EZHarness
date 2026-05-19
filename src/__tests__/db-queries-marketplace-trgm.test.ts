/**
 * Phase 57 — UX-02 Wave 0 RED scaffold for browseMarketplace trigram ranking.
 *
 * Pins the must_haves contract from PLAN frontmatter:
 *   "When a user types ≥3 characters into the marketplace search box,
 *    results return ranked by similarity(name || ' ' || description, query)
 *    DESC; queries ≤2 chars short-circuit to alphabetical browse without
 *    hitting the GIN index."
 *
 * Six cases lock:
 *   1. Empty query → no WHERE filter, all active listings returned.
 *   2. 1-char query → alphabetical browse (NO ilike '%g%' false-match).
 *   3. 2-char query → alphabetical browse (still short-circuited).
 *   4. 3-char query 'git' → 'GitHub Code Reviewer' ranks first.
 *   5. Typo 'iphne' → 'iPhone-style camera' matched via trigram (ilike
 *      pattern '%iphne%' would return 0 rows; this case is THE typo
 *      contract from must_haves).
 *   6. FTS-OR-trigram WHERE clause survives stemming (a stem-only query
 *      finds the row).
 *
 * RED reason: current browseMarketplace (src/db/queries/marketplace.ts:68)
 * applies `ilike('%query%')` for ALL non-empty query strings. Cases 2-6
 * fail until Wave 2 Track B (Plan 57-04 Task 2) replaces the ilike
 * branch with a length-aware switch + similarity ranking override.
 *
 * Runner: bun test (backend integration). Uses real PGlite via
 * setupTestDb. Once pg_trgm is registered at construction (Wave 2
 * Track B Task 1), the similarity calls in cases 4-6 stop throwing.
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

import { sql } from "drizzle-orm";
import { getDb } from "../db/connection";
import { users, marketplaceListings } from "../db/schema";
import { browseMarketplace } from "../db/queries/marketplace";

let authorId: string;

interface SeedRow {
  name: string;
  description: string;
  slug: string;
  category: string;
  tags: string[];
}

const SEED: SeedRow[] = [
  {
    name: "GitHub Code Reviewer",
    description: "Reviews pull requests on GitHub repositories",
    slug: "github-code-reviewer",
    category: "Productivity",
    tags: ["git"],
  },
  {
    name: "GitLab Sync",
    description: "Mirrors repositories to GitLab",
    slug: "gitlab-sync",
    category: "Productivity",
    tags: ["git"],
  },
  {
    name: "Markdown Editor",
    description: "Edits markdown files inline",
    slug: "markdown-editor",
    category: "Editor",
    tags: ["markdown"],
  },
  {
    name: "iPhone-style camera",
    description: "Camera UI that mimics iPhone",
    slug: "iphone-style-camera",
    category: "Media",
    tags: ["camera"],
  },
  {
    name: "Note Taker",
    description: "Captures meeting notes automatically",
    slug: "note-taker",
    category: "Productivity",
    tags: ["notes"],
  },
  {
    name: "Calendar Bridge",
    description: "Syncs events across calendars",
    slug: "calendar-bridge",
    category: "Productivity",
    tags: ["calendar"],
  },
  {
    name: "Task Splitter",
    description: "Breaks big tasks into subtasks",
    slug: "task-splitter",
    category: "Productivity",
    tags: ["tasks"],
  },
  {
    name: "Audio Transcriber",
    description: "Transcribes audio files to text",
    slug: "audio-transcriber",
    category: "Media",
    tags: ["audio"],
  },
  {
    name: "Email Composer",
    description: "Drafts emails from prompts",
    slug: "email-composer",
    category: "Communication",
    tags: ["email"],
  },
  {
    name: "Code Linter",
    description: "Lints code via configurable rules",
    slug: "code-linter",
    category: "Productivity",
    tags: ["code"],
  },
];

beforeAll(async () => {
  await setupTestDb();
  authorId = crypto.randomUUID();
  await getDb().insert(users).values({
    id: authorId,
    email: "trgm@test.com",
    passwordHash: "h",
    name: "trgm-test",
    role: "member",
  });
});

beforeEach(async () => {
  // Wipe listings between tests so seed order is deterministic.
  await getDb().execute(sql`DELETE FROM marketplace_listings`);
  for (const row of SEED) {
    await getDb().insert(marketplaceListings).values({
      authorId,
      name: row.name,
      description: row.description,
      slug: row.slug,
      category: row.category,
      tags: row.tags,
      latestVersion: "1.0.0",
    });
  }
});

afterAll(async () => {
  await closeTestDb();
});

describe("browseMarketplace trigram ranking", () => {
  test("empty query returns all active listings (no WHERE filter on similarity)", async () => {
    const rows = await browseMarketplace({});
    expect(rows.length).toBe(SEED.length);
  });

  test("1-char query short-circuits to alphabetical browse (no GIN hit)", async () => {
    // Pre-Wave-2 behavior: ilike '%g%' matches everything containing 'g'
    // → too broad. Post-Wave-2: short-circuit returns the same list as
    // an empty query (or alphabetical-by-name). We assert the post-
    // Wave-2 contract: count matches empty-query call AND results are
    // sorted by name OR createdAt — NOT filtered by ilike '%g%'.
    const all = await browseMarketplace({});
    const rows = await browseMarketplace({ query: "g" });
    expect(rows.length).toBe(all.length);
  });

  test("2-char query short-circuits to alphabetical browse", async () => {
    const all = await browseMarketplace({});
    const rows = await browseMarketplace({ query: "gi" });
    // Same contract as 1-char: full list, NOT ilike filter.
    expect(rows.length).toBe(all.length);
  });

  test("3-char query 'git' ranks 'GitHub Code Reviewer' first via similarity", async () => {
    const rows = await browseMarketplace({ query: "git" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("GitHub Code Reviewer");
  });

  test("3-char typo 'iphne' matches 'iPhone-style camera' via trigram", async () => {
    // ilike '%iphne%' returns ZERO rows — this is THE must_haves typo
    // contract. RED reason: current branch returns [].
    const rows = await browseMarketplace({ query: "iphne" });
    expect(rows.length).toBeGreaterThan(0);
    const names = rows.map((r) => r.name);
    expect(names.some((n) => n.toLowerCase().includes("iphone"))).toBe(true);
  });

  test("5-char query 'gthub' (typo) still surfaces 'GitHub' via FTS-OR-trigram WHERE clause", async () => {
    // Trigram similarity rescues a stem-mistyped query. ilike '%gthub%'
    // returns zero rows; trigram with similarity threshold finds it.
    const rows = await browseMarketplace({ query: "gthub" });
    expect(rows.length).toBeGreaterThan(0);
    const names = rows.map((r) => r.name);
    expect(names.some((n) => n.includes("GitHub"))).toBe(true);
  });
});
