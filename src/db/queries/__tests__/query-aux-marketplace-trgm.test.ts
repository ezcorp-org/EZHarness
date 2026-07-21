/**
 * query-aux (db-audit): browseMarketplace's ≥3-char recall arm now uses the
 * index-eligible `<%` OPERATOR (not the `word_similarity() > 0.4` function
 * call, which can never use the gin_trgm_ops index). The 0.4 recall threshold
 * is restored by pinning `pg_trgm.word_similarity_threshold` via `SET LOCAL`
 * inside a wrapping transaction.
 *
 * This suite pins the two properties the new shape must hold:
 *   1. Typo recall STILL works ("iphne" → "iPhone") — the `<%` predicate at
 *      the lowered 0.4 threshold matches what `> 0.4` used to, and the ≤2-char
 *      short-circuit (no trigram path) still returns the full list.
 *   2. The lowered threshold does NOT LEAK: `SET LOCAL` reverts at the
 *      transaction boundary, so after a browse the session default (0.6) is
 *      back. A regression to a plain `SET` would fail this.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { browseMarketplace } = await import("../marketplace");

let authorId: string;

const SEED: Array<{ name: string; description: string; slug: string; category: string }> = [
  { name: "GitHub Code Reviewer", description: "Reviews pull requests on GitHub repositories", slug: "gh-cr", category: "Productivity" },
  { name: "iPhone-style camera", description: "Camera UI that mimics iPhone", slug: "iph", category: "Media" },
  { name: "Markdown Editor", description: "Edits markdown files inline", slug: "md", category: "Editor" },
  { name: "Note Taker", description: "Captures meeting notes automatically", slug: "note", category: "Productivity" },
];

async function reseed(): Promise<void> {
  const db = getTestDb();
  const { users, marketplaceListings } = await import("../../schema");
  authorId = crypto.randomUUID();
  await db.insert(users).values({ id: authorId, email: `${authorId}@t.com`, passwordHash: "h", name: "a", role: "member" });
  for (const r of SEED) {
    await db.insert(marketplaceListings).values({
      authorId, name: r.name, description: r.description, slug: r.slug,
      category: r.category, tags: [], latestVersion: "1.0.0",
    });
  }
}

async function thresholdNow(): Promise<string> {
  const res = await getTestDb().execute(
    sql`SELECT current_setting('pg_trgm.word_similarity_threshold') AS t`,
  );
  const rows = (res as unknown as { rows?: Array<{ t: string }> }).rows
    ?? (res as unknown as Array<{ t: string }>);
  return rows[0]!.t;
}

describe("browseMarketplace — index-eligible `<%` recall arm", () => {
  beforeEach(async () => { await setupTestDb(); await reseed(); });
  afterAll(async () => { await closeTestDb(); });

  test("empty query returns all active listings (no trigram path)", async () => {
    expect((await browseMarketplace({})).length).toBe(SEED.length);
  });

  test("2-char query short-circuits (no transaction / trigram) and returns the full list", async () => {
    expect((await browseMarketplace({ query: "gi" })).length).toBe(SEED.length);
  });

  test("3-char 'git' ranks GitHub first via the preserved word_similarity ORDER BY", async () => {
    const rows = await browseMarketplace({ query: "git" });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBe("GitHub Code Reviewer");
  });

  test("typo 'iphne' matches 'iPhone' — the 0.4 threshold is applied via `<%`", async () => {
    const rows = await browseMarketplace({ query: "iphne" });
    expect(rows.some((r) => r.name.toLowerCase().includes("iphone"))).toBe(true);
  });

  test("SET LOCAL does not leak: the session threshold is back to the 0.6 default after a browse", async () => {
    // Default before any trigram query.
    expect(Number(await thresholdNow())).toBeCloseTo(0.6, 5);
    await browseMarketplace({ query: "iphne" });
    // If the query used a plain `SET` this would read 0.4 — `SET LOCAL`
    // reverts at COMMIT, so we must still see the 0.6 default.
    expect(Number(await thresholdNow())).toBeCloseTo(0.6, 5);
  });
});
