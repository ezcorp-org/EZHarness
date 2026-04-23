import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  upsertRating,
  getUserRating,
  createFlag,
  countPendingFlagsByUser,
  getFlagHistory,
  resolveFlag,
  listFlags,
} = await import("../db/queries/marketplace-ratings");
const { createListing } = await import("../db/queries/marketplace");
const { createUser } = await import("../db/queries/users");
const { getDb } = await import("../db/connection");
const { eq } = await import("drizzle-orm");
const { marketplaceListings } = await import("../db/schema");

async function seedListing(authorId: string, nameSuffix = "a") {
  const l = await createListing({
    authorId,
    name: `ext-${nameSuffix}-${crypto.randomUUID().slice(0, 6)}`,
    description: "desc",
    category: "agents",
    tags: [],
    latestVersion: "1.0.0",
  });
  return l;
}

describe("marketplace-ratings queries", () => {
  let authorId: string;
  let userId: string;

  beforeEach(async () => {
    await setupTestDb();
    authorId = (await createUser({ email: "author@test.com", passwordHash: "h", name: "A" })).id;
    userId = (await createUser({ email: "rater@test.com", passwordHash: "h", name: "R" })).id;
  });
  afterAll(async () => await closeTestDb());

  test("upsertRating inserts new rating and updates denorm counts", async () => {
    const listing = await seedListing(authorId);
    await upsertRating(listing.id, userId, true);

    const rating = await getUserRating(listing.id, userId);
    expect(rating).toBeDefined();
    expect(rating!.thumbsUp).toBe(true);

    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(updated.ratingTotal).toBe(1);
    expect(updated.ratingPositive).toBe(1);
  });

  test("upsertRating flips an existing rating without changing total", async () => {
    const listing = await seedListing(authorId);
    await upsertRating(listing.id, userId, true);
    await upsertRating(listing.id, userId, false);

    const rating = await getUserRating(listing.id, userId);
    expect(rating!.thumbsUp).toBe(false);

    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(updated.ratingTotal).toBe(1);
    expect(updated.ratingPositive).toBe(0);
  });

  test("getUserRating returns undefined when no rating exists", async () => {
    const listing = await seedListing(authorId);
    expect(await getUserRating(listing.id, userId)).toBeUndefined();
  });

  test("createFlag persists flag and auto-flags listing", async () => {
    const listing = await seedListing(authorId);
    const flag = await createFlag(listing.id, userId, "spammy", "spam");

    expect(flag.id).toBeDefined();
    expect(flag.reason).toBe("spammy");
    expect(flag.category).toBe("spam");
    expect(flag.status).toBe("pending");

    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(updated.flagCount).toBe(1);
    expect(updated.status).toBe("flagged");
  });

  test("getFlagHistory returns flags newest-first", async () => {
    const listing = await seedListing(authorId);
    await createFlag(listing.id, userId, "first", "other");
    // second flag needs a distinct user (PK isn't on (listing,user), but we keep variety)
    const u2 = await createUser({ email: "u2@test.com", passwordHash: "h", name: "U2" });
    await new Promise((r) => setTimeout(r, 5));
    await createFlag(listing.id, u2.id, "second", "other");

    const history = await getFlagHistory(listing.id);
    expect(history.length).toBe(2);
    expect(history[0]!.reason).toBe("second");
    expect(history[1]!.reason).toBe("first");
  });

  test("countPendingFlagsByUser counts user's recent flags", async () => {
    const l1 = await seedListing(authorId, "b");
    const l2 = await seedListing(authorId, "c");
    await createFlag(l1.id, userId, "r1", "other");
    await createFlag(l2.id, userId, "r2", "other");
    expect(await countPendingFlagsByUser(userId)).toBe(2);
    expect(await countPendingFlagsByUser(authorId)).toBe(0);
  });

  test("resolveFlag=dismissed restores listing to active when no pending flags remain", async () => {
    const listing = await seedListing(authorId);
    const flag = await createFlag(listing.id, userId, "r", "other");
    await resolveFlag(flag.id, authorId, "dismissed");

    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(updated!.status).toBe("active");
    expect(updated!.flagCount).toBe(0);
  });

  test("resolveFlag=removed marks listing removed", async () => {
    const listing = await seedListing(authorId);
    const flag = await createFlag(listing.id, userId, "bad", "malicious");
    await resolveFlag(flag.id, authorId, "removed");

    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(updated!.status).toBe("removed");
  });

  test("listFlags filters by status and listingId", async () => {
    const listing = await seedListing(authorId);
    const f1 = await createFlag(listing.id, userId, "r1", "other");
    await resolveFlag(f1.id, authorId, "dismissed");
    const u2 = await createUser({ email: "u2b@test.com", passwordHash: "h", name: "U2" });
    await createFlag(listing.id, u2.id, "r2", "other"); // pending

    const pending = await listFlags({ status: "pending" });
    expect(pending.length).toBe(1);
    expect(pending[0]!.reason).toBe("r2");

    const all = await listFlags({ listingId: listing.id });
    expect(all.length).toBe(2);

    const unfiltered = await listFlags();
    expect(unfiltered.length).toBe(2);
  });
});
