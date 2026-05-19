import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createListing,
  getListingById,
  getListingBySlug,
  browseMarketplace,
  updateListingStatus,
  incrementInstallCount,
  getListingsByAuthor,
  getFeaturedListings,
} from "../db/queries/marketplace";
import {
  createVersion,
  getVersion,
  getLatestVersion,
  listVersions,
} from "../db/queries/marketplace-versions";
import {
  upsertRating,
  getUserRating,
  createFlag,
  resolveFlag,
  listFlags,
} from "../db/queries/marketplace-ratings";
import { getDb } from "../db/connection";
import { users, marketplaceListings, marketplaceVersions } from "../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionManifestV2 } from "../extensions/types";

let testUserId: string;
let testUser2Id: string;
let adminUserId: string;

function makeManifest(overrides?: Partial<ExtensionManifestV2>): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "Test Agent",
    description: "A test agent",
    version: "1.0.0",
    author: { name: "Tester" },
    agent: {
      prompt: "You are helpful.",
      category: "Productivity",
      capabilities: ["llm"],
    },
    permissions: {},
    tags: ["test"],
    ...overrides,
  };
}

beforeAll(async () => {
  await setupTestDb();
  testUserId = crypto.randomUUID();
  testUser2Id = crypto.randomUUID();
  adminUserId = crypto.randomUUID();
  await getDb().insert(users).values([
    { id: testUserId, email: "q1@test.com", passwordHash: "h", name: "User 1", role: "member" },
    { id: testUser2Id, email: "q2@test.com", passwordHash: "h", name: "User 2", role: "member" },
    { id: adminUserId, email: "admin@test.com", passwordHash: "h", name: "Admin", role: "admin" },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

// ── Listings ──────────────────────────────────────────────────────

describe("Listings", () => {
  test("1. createListing generates unique slug from name", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "My Cool Agent",
      description: "Does cool things",
      category: "Productivity",
      tags: ["cool"],
      latestVersion: "1.0.0",
    });

    expect(listing.id).toBeDefined();
    expect(listing.slug).toBe("my-cool-agent");
    expect(listing.name).toBe("My Cool Agent");
    expect(listing.authorId).toBe(testUserId);
    expect(listing.status).toBe("active");
    expect(listing.installCount).toBe(0);
  });

  test("2. createListing with duplicate slug (same name) throws unique constraint error", async () => {
    await createListing({
      authorId: testUserId,
      name: "Duplicate Name Agent",
      description: "First",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    await expect(
      createListing({
        authorId: testUser2Id,
        name: "Duplicate Name Agent",
        description: "Second",
        category: "Development",
        tags: [],
        latestVersion: "1.0.0",
      }),
    ).rejects.toThrow();
  });

  test("3. getListingById returns undefined for non-existent id", async () => {
    const result = await getListingById(crypto.randomUUID());
    expect(result).toBeUndefined();
  });

  test("4. getListingById excludes listings with status 'removed'", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Removed Listing ById",
      description: "Will be removed",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    await updateListingStatus(listing.id, "removed");
    const result = await getListingById(listing.id);
    expect(result).toBeUndefined();
  });

  test("5. getListingBySlug works and excludes removed", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Slug Lookup Test",
      description: "Find by slug",
      category: "Development",
      tags: [],
      latestVersion: "1.0.0",
    });

    const found = await getListingBySlug("slug-lookup-test");
    expect(found).toBeDefined();
    expect(found!.id).toBe(listing.id);

    await updateListingStatus(listing.id, "removed");
    const gone = await getListingBySlug("slug-lookup-test");
    expect(gone).toBeUndefined();
  });

  test("6. getListingBySlug returns undefined for non-existent slug", async () => {
    const result = await getListingBySlug("no-such-slug-anywhere");
    expect(result).toBeUndefined();
  });

  test("7. updateListingStatus changes from active -> flagged -> removed -> active", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Status Cycle Agent",
      description: "Test status transitions",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    expect(listing.status).toBe("active");

    await updateListingStatus(listing.id, "flagged");
    const [flagged] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(flagged!.status).toBe("flagged");

    await updateListingStatus(listing.id, "removed");
    const [removed] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(removed!.status).toBe("removed");

    await updateListingStatus(listing.id, "active");
    const [restored] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listing.id));
    expect(restored!.status).toBe("active");
  });

  test("8. incrementInstallCount increments atomically (call multiple times)", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Install Count Agent",
      description: "Count installs",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    expect(listing.installCount).toBe(0);

    await incrementInstallCount(listing.id);
    await incrementInstallCount(listing.id);
    await incrementInstallCount(listing.id);

    const updated = await getListingById(listing.id);
    expect(updated!.installCount).toBe(3);
  });

  test("9. getListingsByAuthor returns only that author's listings, ordered newest first", async () => {
    const authorId = crypto.randomUUID();
    await getDb().insert(users).values({
      id: authorId,
      email: `author-${authorId.slice(0, 8)}@test.com`,
      passwordHash: "h",
      name: "Author",
      role: "member",
    });

    const first = await createListing({
      authorId,
      name: `Author First ${authorId.slice(0, 6)}`,
      description: "First listing",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));

    const second = await createListing({
      authorId,
      name: `Author Second ${authorId.slice(0, 6)}`,
      description: "Second listing",
      category: "Development",
      tags: [],
      latestVersion: "1.0.0",
    });

    const listings = await getListingsByAuthor(authorId);
    expect(listings).toHaveLength(2);
    expect(listings[0]!.id).toBe(second.id);
    expect(listings[1]!.id).toBe(first.id);
  });

  test("10. getListingsByAuthor returns empty array for unknown author", async () => {
    const listings = await getListingsByAuthor(crypto.randomUUID());
    expect(listings).toEqual([]);
  });
});

// ── Browse ────────────────────────────────────────────────────────

describe("Browse", () => {
  let browseListingA: Awaited<ReturnType<typeof createListing>>;
  let browseListingB: Awaited<ReturnType<typeof createListing>>;
  let browseListingC: Awaited<ReturnType<typeof createListing>>;

  beforeAll(async () => {
    const browseAuthor = crypto.randomUUID();
    await getDb().insert(users).values({
      id: browseAuthor,
      email: `browse-author@test.com`,
      passwordHash: "h",
      name: "Browse Author",
      role: "member",
    });

    browseListingA = await createListing({
      authorId: browseAuthor,
      name: "Alpha Browse Agent",
      description: "Alpha agent for browsing tests",
      category: "Productivity",
      tags: ["automation", "ai"],
      latestVersion: "1.0.0",
    });

    browseListingB = await createListing({
      authorId: browseAuthor,
      name: "Beta Browse Agent",
      description: "Beta agent for data analysis",
      category: "Data & Analysis",
      tags: ["data", "ai"],
      latestVersion: "2.0.0",
    });

    browseListingC = await createListing({
      authorId: browseAuthor,
      name: "Gamma Browse Agent",
      description: "Gamma agent for writing tasks",
      category: "Writing",
      tags: ["writing"],
      latestVersion: "1.0.0",
    });

    // Give B more installs for popularity sorting
    await incrementInstallCount(browseListingB.id);
    await incrementInstallCount(browseListingB.id);
    await incrementInstallCount(browseListingB.id);
    await incrementInstallCount(browseListingA.id);

    // Give A some ratings for rating sorting
    await upsertRating(browseListingA.id, browseAuthor, true);
  });

  test("11. browseMarketplace default (no filters) returns active listings", async () => {
    const results = await browseMarketplace({});
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      expect(r.status).toBe("active");
    }
  });

  test("12. browseMarketplace excludes flagged and removed listings", async () => {
    const flaggedListing = await createListing({
      authorId: testUserId,
      name: "Flagged Browse Exclude",
      description: "Should not appear",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });
    const removedListing = await createListing({
      authorId: testUserId,
      name: "Removed Browse Exclude",
      description: "Should not appear either",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    await updateListingStatus(flaggedListing.id, "flagged");
    await updateListingStatus(removedListing.id, "removed");

    const results = await browseMarketplace({});
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(flaggedListing.id);
    expect(ids).not.toContain(removedListing.id);
  });

  test("13. browseMarketplace with category filter", async () => {
    const results = await browseMarketplace({ category: "Data & Analysis" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.category).toBe("Data & Analysis");
    }
  });

  test("14. browseMarketplace with query search (matches name)", async () => {
    const results = await browseMarketplace({ query: "Alpha Browse" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === browseListingA.id)).toBe(true);
  });

  test("15. browseMarketplace with query search (matches description)", async () => {
    const results = await browseMarketplace({ query: "data analysis" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === browseListingB.id)).toBe(true);
  });

  test("16. browseMarketplace with query search (case-insensitive)", async () => {
    const results = await browseMarketplace({ query: "GAMMA" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === browseListingC.id)).toBe(true);
  });

  test("17. browseMarketplace with tag filter (jsonb @> operator)", async () => {
    const results = await browseMarketplace({ tag: "automation" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect((r.tags as string[]).includes("automation")).toBe(true);
    }
  });

  test("18. browseMarketplace sort='popular' orders by installCount DESC", async () => {
    const results = await browseMarketplace({ sort: "popular" });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.installCount).toBeGreaterThanOrEqual(results[i]!.installCount);
    }
  });

  test("19. browseMarketplace sort='newest' orders by createdAt DESC", async () => {
    const results = await browseMarketplace({ sort: "newest" });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        results[i]!.createdAt.getTime(),
      );
    }
  });

  test("20. browseMarketplace sort='rating' orders by rating percentage DESC", async () => {
    const results = await browseMarketplace({ sort: "rating" });
    // Verify sort order: (ratingPositive * 100) / (ratingTotal + 1) DESC
    for (let i = 1; i < results.length; i++) {
      const prevScore =
        (results[i - 1]!.ratingPositive * 100) / (results[i - 1]!.ratingTotal + 1);
      const currScore = (results[i]!.ratingPositive * 100) / (results[i]!.ratingTotal + 1);
      expect(prevScore).toBeGreaterThanOrEqual(currScore);
    }
  });

  test("21. browseMarketplace with limit and offset (pagination)", async () => {
    // Use popular sort (deterministic due to distinct installCount values) for stable pagination
    const page1 = await browseMarketplace({ sort: "popular", limit: 2, offset: 0 });
    const page2 = await browseMarketplace({ sort: "popular", limit: 2, offset: 2 });

    expect(page1).toHaveLength(2);
    // page2 may have fewer, but ids should not overlap
    const page1Ids = new Set(page1.map((r) => r.id));
    for (const r of page2) {
      expect(page1Ids.has(r.id)).toBe(false);
    }
  });

  test("22. browseMarketplace with no results returns empty array", async () => {
    const results = await browseMarketplace({ query: "xyzzy_nonexistent_query_12345" });
    expect(results).toEqual([]);
  });
});

// ── Featured ──────────────────────────────────────────────────────

describe("Featured", () => {
  let featuredListing: Awaited<ReturnType<typeof createListing>>;
  let nonFeaturedListing: Awaited<ReturnType<typeof createListing>>;

  beforeAll(async () => {
    featuredListing = await createListing({
      authorId: testUserId,
      name: "Featured Star Agent",
      description: "A featured agent",
      category: "Productivity",
      tags: ["featured"],
      latestVersion: "1.0.0",
    });
    await getDb()
      .update(marketplaceListings)
      .set({ featured: true })
      .where(eq(marketplaceListings.id, featuredListing.id));

    nonFeaturedListing = await createListing({
      authorId: testUserId,
      name: "Non Featured Agent",
      description: "Not featured",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    // Give non-featured many installs to test that featured still comes first
    for (let i = 0; i < 100; i++) {
      await incrementInstallCount(nonFeaturedListing.id);
    }
  });

  test("23. getFeaturedListings prioritizes featured=true listings", async () => {
    const results = await getFeaturedListings(20);
    const featuredIdx = results.findIndex((r) => r.id === featuredListing.id);
    const nonFeaturedIdx = results.findIndex((r) => r.id === nonFeaturedListing.id);

    expect(featuredIdx).toBeGreaterThanOrEqual(0);
    expect(nonFeaturedIdx).toBeGreaterThanOrEqual(0);
    // Featured comes before non-featured despite lower install count
    expect(featuredIdx).toBeLessThan(nonFeaturedIdx);
  });

  test("24. getFeaturedListings respects limit parameter", async () => {
    const results = await getFeaturedListings(1);
    expect(results).toHaveLength(1);
  });

  test("25. getFeaturedListings only returns active listings", async () => {
    const removedFeatured = await createListing({
      authorId: testUserId,
      name: "Removed Featured Agent",
      description: "Removed but featured",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });
    await getDb()
      .update(marketplaceListings)
      .set({ featured: true, status: "removed" })
      .where(eq(marketplaceListings.id, removedFeatured.id));

    const results = await getFeaturedListings(50);
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain(removedFeatured.id);
  });
});

// ── Versions ──────────────────────────────────────────────────────

describe("Versions", () => {
  let versionListing: Awaited<ReturnType<typeof createListing>>;

  beforeAll(async () => {
    versionListing = await createListing({
      authorId: testUserId,
      name: "Version Test Agent",
      description: "Agent for version tests",
      category: "Development",
      tags: [],
      latestVersion: "0.0.0",
    });
  });

  /**
   * Force a specific createdAt on a freshly-inserted version row so the
   * "newest by created_at" ordering tests (31/33) are deterministic.
   * PGlite's `default now()` rounds to the same millisecond on back-to-
   * back inserts, making `ORDER BY created_at DESC` unstable across runs.
   */
  async function stampCreatedAt(versionId: string, createdAt: Date): Promise<void> {
    await getDb()
      .update(marketplaceVersions)
      .set({ createdAt })
      .where(eq(marketplaceVersions.id, versionId));
  }

  test("26. createVersion links to listing and updates listing.latestVersion", async () => {
    const manifest = makeManifest({ version: "1.0.0" });
    const ver = await createVersion(versionListing.id, "1.0.0", manifest);
    await stampCreatedAt(ver.id, new Date("2025-01-01T00:00:00Z"));

    expect(ver.listingId).toBe(versionListing.id);
    expect(ver.version).toBe("1.0.0");
    expect(ver.manifest).toEqual(manifest);

    const listing = await getListingById(versionListing.id);
    expect(listing!.latestVersion).toBe("1.0.0");
  });

  test("27. createVersion with changelog stores it", async () => {
    const manifest = makeManifest({ version: "1.1.0" });
    const ver = await createVersion(versionListing.id, "1.1.0", manifest, "Added new features");
    await stampCreatedAt(ver.id, new Date("2025-01-02T00:00:00Z"));

    expect(ver.changelog).toBe("Added new features");
  });

  test("28. createVersion without changelog stores null", async () => {
    const manifest = makeManifest({ version: "1.2.0" });
    const ver = await createVersion(versionListing.id, "1.2.0", manifest);
    await stampCreatedAt(ver.id, new Date("2025-01-03T00:00:00Z"));

    expect(ver.changelog).toBeNull();
  });

  test("29. getVersion returns specific version by listingId+version string", async () => {
    const ver = await getVersion(versionListing.id, "1.0.0");
    expect(ver).toBeDefined();
    expect(ver!.version).toBe("1.0.0");
    expect(ver!.listingId).toBe(versionListing.id);
  });

  test("30. getVersion returns undefined for non-existent version", async () => {
    const ver = await getVersion(versionListing.id, "99.99.99");
    expect(ver).toBeUndefined();
  });

  test("31. getLatestVersion returns most recently created version", async () => {
    // We created 1.0.0, 1.1.0, 1.2.0 above; 1.2.0 is latest by created_at
    const ver = await getLatestVersion(versionListing.id);
    expect(ver).toBeDefined();
    expect(ver!.version).toBe("1.2.0");
  });

  test("32. getLatestVersion returns undefined for listing with no versions", async () => {
    const emptyListing = await createListing({
      authorId: testUserId,
      name: "No Versions Agent",
      description: "Has no versions",
      category: "Productivity",
      tags: [],
      latestVersion: "0.0.0",
    });

    const ver = await getLatestVersion(emptyListing.id);
    expect(ver).toBeUndefined();
  });

  test("33. listVersions returns all versions newest first", async () => {
    const versions = await listVersions(versionListing.id);
    expect(versions).toHaveLength(3);
    // Newest first
    expect(versions[0]!.version).toBe("1.2.0");
    expect(versions[1]!.version).toBe("1.1.0");
    expect(versions[2]!.version).toBe("1.0.0");
  });

  test("34. listVersions returns empty array for listing with no versions", async () => {
    const emptyListing = await createListing({
      authorId: testUserId,
      name: "Empty Versions Agent",
      description: "No versions here",
      category: "Productivity",
      tags: [],
      latestVersion: "0.0.0",
    });

    const versions = await listVersions(emptyListing.id);
    expect(versions).toEqual([]);
  });
});

// ── Ratings ───────────────────────────────────────────────────────

describe("Ratings", () => {
  let ratingListing: Awaited<ReturnType<typeof createListing>>;

  beforeAll(async () => {
    ratingListing = await createListing({
      authorId: testUserId,
      name: "Rating Test Agent",
      description: "Agent for rating tests",
      category: "Development",
      tags: [],
      latestVersion: "1.0.0",
    });
  });

  test("35. upsertRating creates new rating and updates listing counts", async () => {
    await upsertRating(ratingListing.id, testUserId, true);

    const listing = await getListingById(ratingListing.id);
    expect(listing!.ratingTotal).toBe(1);
    expect(listing!.ratingPositive).toBe(1);
  });

  test("36. upsertRating updates existing rating (same user, same listing)", async () => {
    // testUserId already rated thumbsUp=true in test 35
    await upsertRating(ratingListing.id, testUserId, false);

    const listing = await getListingById(ratingListing.id);
    expect(listing!.ratingTotal).toBe(1);
    expect(listing!.ratingPositive).toBe(0);
  });

  test("37. upsertRating from multiple users accumulates correctly", async () => {
    // testUserId currently has thumbsUp=false from test 36
    await upsertRating(ratingListing.id, testUser2Id, true);

    const listing = await getListingById(ratingListing.id);
    expect(listing!.ratingTotal).toBe(2);
    expect(listing!.ratingPositive).toBe(1);
  });

  test("38. upsertRating changing from thumbsUp=true to false recalculates correctly", async () => {
    // Set testUser2 back to true, then flip to false
    await upsertRating(ratingListing.id, testUser2Id, true);
    let listing = await getListingById(ratingListing.id);
    expect(listing!.ratingPositive).toBe(1); // testUser=false, testUser2=true

    await upsertRating(ratingListing.id, testUser2Id, false);
    listing = await getListingById(ratingListing.id);
    expect(listing!.ratingTotal).toBe(2);
    expect(listing!.ratingPositive).toBe(0); // both false now
  });

  test("39. getUserRating returns the user's rating", async () => {
    const rating = await getUserRating(ratingListing.id, testUserId);
    expect(rating).toBeDefined();
    expect(rating!.thumbsUp).toBe(false);
    expect(rating!.userId).toBe(testUserId);
  });

  test("40. getUserRating returns undefined when user hasn't rated", async () => {
    const rating = await getUserRating(ratingListing.id, adminUserId);
    expect(rating).toBeUndefined();
  });
});

// ── Flags ─────────────────────────────────────────────────────────

describe("Flags", () => {
  let flagListing: Awaited<ReturnType<typeof createListing>>;

  beforeAll(async () => {
    flagListing = await createListing({
      authorId: testUserId,
      name: "Flag Test Agent",
      description: "Agent for flag tests",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });
  });

  test("41. createFlag creates flag record with status 'pending'", async () => {
    const flag = await createFlag(flagListing.id, testUser2Id, "Inappropriate content");

    expect(flag.id).toBeDefined();
    expect(flag.listingId).toBe(flagListing.id);
    expect(flag.userId).toBe(testUser2Id);
    expect(flag.reason).toBe("Inappropriate content");
    expect(flag.status).toBe("pending");
  });

  test("42. createFlag sets listing status to 'flagged'", async () => {
    const listing = await getListingById(flagListing.id);
    expect(listing!.status).toBe("flagged");
  });

  test("43. Multiple flags on same listing all recorded", async () => {
    await createFlag(flagListing.id, adminUserId, "Spam");

    const flags = await listFlags({ listingId: flagListing.id });
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });

  test("44. resolveFlag with 'dismissed' restores listing to 'active' (when no other pending flags)", async () => {
    const singleFlagListing = await createListing({
      authorId: testUserId,
      name: "Single Flag Dismiss Agent",
      description: "One flag to dismiss",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    const flag = await createFlag(singleFlagListing.id, testUser2Id, "Not really bad");
    await resolveFlag(flag.id, adminUserId, "dismissed");

    const listing = await getListingById(singleFlagListing.id);
    expect(listing!.status).toBe("active");
  });

  test("45. resolveFlag with 'dismissed' keeps listing 'flagged' (when other pending flags exist)", async () => {
    const multiFlagListing = await createListing({
      authorId: testUserId,
      name: "Multi Flag Dismiss Agent",
      description: "Multiple flags",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    const flag1 = await createFlag(multiFlagListing.id, testUser2Id, "Reason 1");
    await createFlag(multiFlagListing.id, adminUserId, "Reason 2");

    // Dismiss only flag1; flag2 still pending
    await resolveFlag(flag1.id, adminUserId, "dismissed");

    const [listing] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, multiFlagListing.id));
    expect(listing!.status).toBe("flagged");
  });

  test("46. resolveFlag with 'removed' sets listing to 'removed'", async () => {
    const removeListing = await createListing({
      authorId: testUserId,
      name: "Remove Flag Agent",
      description: "Will be removed via flag",
      category: "Productivity",
      tags: [],
      latestVersion: "1.0.0",
    });

    const flag = await createFlag(removeListing.id, testUser2Id, "Very bad");
    await resolveFlag(flag.id, adminUserId, "removed");

    const [listing] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, removeListing.id));
    expect(listing!.status).toBe("removed");
  });

  test("47. resolveFlag on non-existent flag is a no-op", async () => {
    // Should not throw
    await resolveFlag(crypto.randomUUID(), adminUserId, "dismissed");
  });

  test("48. listFlags with no filter returns all flags", async () => {
    const allFlags = await listFlags();
    expect(allFlags.length).toBeGreaterThanOrEqual(1);
  });

  test("49. listFlags with status filter returns matching", async () => {
    const pending = await listFlags({ status: "pending" });
    for (const f of pending) {
      expect(f.status).toBe("pending");
    }

    const dismissed = await listFlags({ status: "dismissed" });
    for (const f of dismissed) {
      expect(f.status).toBe("dismissed");
    }
  });

  test("50. listFlags with listingId filter returns matching", async () => {
    const flags = await listFlags({ listingId: flagListing.id });
    for (const f of flags) {
      expect(f.listingId).toBe(flagListing.id);
    }
    expect(flags.length).toBeGreaterThanOrEqual(2);
  });
});
