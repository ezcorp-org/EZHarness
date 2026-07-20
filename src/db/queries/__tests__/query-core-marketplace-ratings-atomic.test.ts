/**
 * query-core db-audit fix: upsertRating must upsert against the
 * UNIQUE(listing_id, user_id) index (a double-click first-rating can't 500 the
 * loser with an unhandled unique violation), and the rating write + denorm
 * count recompute must be one transaction. createFlag / resolveFlag share the
 * same non-atomic recompute pattern and are now transactional too.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";

mockDbConnection();

const { upsertRating, getUserRating, createFlag, resolveFlag } = await import(
  "../marketplace-ratings"
);
const { createListing } = await import("../marketplace");
const { createUser } = await import("../users");
const { getDb } = await import("../../connection");
const { eq } = await import("drizzle-orm");
const { marketplaceListings, marketplaceRatings } = await import("../../schema");

async function seedListing(authorId: string) {
  return createListing({
    authorId,
    name: `ext-${crypto.randomUUID().slice(0, 6)}`,
    description: "desc",
    category: "agents",
    tags: [],
    latestVersion: "1.0.0",
  });
}

async function listingCounts(id: string) {
  const [row] = await getDb()
    .select()
    .from(marketplaceListings)
    .where(eq(marketplaceListings.id, id));
  return { total: row!.ratingTotal, positive: row!.ratingPositive };
}

describe("upsertRating atomic + race-safe", () => {
  let authorId: string;
  let userId: string;

  beforeEach(async () => {
    await setupTestDb();
    authorId = (await createUser({ email: "author@t.com", passwordHash: "h", name: "A" })).id;
    userId = (await createUser({ email: "rater@t.com", passwordHash: "h", name: "R" })).id;
  });
  afterAll(async () => await closeTestDb());

  test("concurrent double-click of a first rating does not throw a unique violation", async () => {
    const listing = await seedListing(authorId);

    // Old select-then-insert: both callers see no row, both INSERT, loser
    // throws 23505. onConflictDoUpdate makes this a race-free upsert.
    await Promise.all([
      upsertRating(listing.id, userId, true),
      upsertRating(listing.id, userId, true),
    ]);

    // Exactly ONE rating row for the (listing,user) pair — no duplicate.
    const rows = await getDb()
      .select()
      .from(marketplaceRatings)
      .where(eq(marketplaceRatings.listingId, listing.id));
    expect(rows).toHaveLength(1);

    // Denormalized counts reflect the single rating.
    expect(await listingCounts(listing.id)).toEqual({ total: 1, positive: 1 });
  });

  test("re-rating updates the existing row and recomputes counts atomically", async () => {
    const listing = await seedListing(authorId);
    await upsertRating(listing.id, userId, true);
    await upsertRating(listing.id, userId, false); // flip via ON CONFLICT

    expect((await getUserRating(listing.id, userId))!.thumbsUp).toBe(false);
    expect(await listingCounts(listing.id)).toEqual({ total: 1, positive: 0 });
  });

  test("createFlag transaction recomputes flagCount + status together", async () => {
    const listing = await seedListing(authorId);
    await createFlag(listing.id, userId, "spam", "spam");

    const [row] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(row!.flagCount).toBe(1);
    expect(row!.status).toBe("flagged");
  });

  test("resolveFlag transaction restores active + zeroes flagCount", async () => {
    const listing = await seedListing(authorId);
    const flag = await createFlag(listing.id, userId, "r", "other");
    await resolveFlag(flag.id, authorId, "dismissed");

    const [row] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(row!.status).toBe("active");
    expect(row!.flagCount).toBe(0);
  });

  test("resolveFlag on a missing flag resolves as a no-op (early return inside tx)", async () => {
    expect(await resolveFlag("no-such-flag", authorId, "dismissed")).toBeUndefined();
  });
});
