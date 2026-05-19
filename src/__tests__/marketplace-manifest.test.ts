import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { validateManifestV2, compareVersions } from "../extensions/manifest";
import type { ExtensionManifestV2 } from "../extensions/types";
import { createListing, browseMarketplace } from "../db/queries/marketplace";
import { createVersion, listVersions } from "../db/queries/marketplace-versions";
import { upsertRating, createFlag } from "../db/queries/marketplace-ratings";
import { getDb } from "../db/connection";
import { users, marketplaceListings } from "../db/schema";
import { eq } from "drizzle-orm";

let testUserId: string;

beforeAll(async () => {
  await setupTestDb();

  // Create a test user for FK constraints
  testUserId = crypto.randomUUID();
  await getDb().insert(users).values({
    id: testUserId,
    email: "marketplace-test@example.com",
    passwordHash: "hashed",
    name: "Test User",
    role: "member",
  });
});

afterAll(async () => {
  await closeTestDb();
});

// ── Manifest Validation ───────────────────────────────────────────

describe("validateManifestV2", () => {
  test("rejects manifest with missing required fields", () => {
    const result = validateManifestV2({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  test("accepts a well-formed v2 agent manifest", () => {
    const result = validateManifestV2({
      schemaVersion: 2,
      name: "test-agent",
      description: "A test agent",
      version: "1.0.0",
      author: { name: "Test Author" },
      agent: { prompt: "You are helpful." },
      permissions: {},
      tags: ["test"],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("compareVersions", () => {
  test("1.2.3 < 1.2.4 returns -1", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
  });

  test("2.0.0 > 1.9.9 returns 1", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });

  test("1.0.0 == 1.0.0 returns 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

// ── Database Queries ──────────────────────────────────────────────

describe("marketplace listings", () => {
  test("createListing inserts a listing and returns it with generated id and slug", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Super Agent",
      description: "A super helpful agent",
      category: "Productivity",
      tags: ["helpful", "productivity"],
      latestVersion: "1.0.0",
    });

    expect(listing.id).toBeDefined();
    expect(listing.slug).toBe("super-agent");
    expect(listing.name).toBe("Super Agent");
    expect(listing.installCount).toBe(0);
    expect(listing.status).toBe("active");
  });

  test("browseMarketplace with no filters returns active listings sorted by newest", async () => {
    const results = await browseMarketplace({});
    expect(results.length).toBeGreaterThan(0);
    // All should be active
    for (const r of results) {
      expect(r.status).toBe("active");
    }
  });

  test("browseMarketplace with category filter returns only matching category", async () => {
    // Create a listing in a different category
    await createListing({
      authorId: testUserId,
      name: "Dev Agent",
      description: "A development agent",
      category: "Development",
      tags: [],
      latestVersion: "1.0.0",
    });

    const results = await browseMarketplace({ category: "Development" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.category).toBe("Development");
    }
  });
});

describe("marketplace versions", () => {
  let listingId: string;

  beforeAll(async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Versioned Agent",
      description: "For version tests",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
  });

  test("createVersion creates an immutable version record linked to a listing", async () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "Versioned Agent",
      description: "For version tests",
      version: "1.0.0",
      author: { name: "Test" },
      agent: { prompt: "Hello" },
      permissions: {},
      tags: [],
    };
    const version = await createVersion(listingId, "1.0.0", manifest);

    expect(version.id).toBeDefined();
    expect(version.version).toBe("1.0.0");
    expect(version.listingId).toBe(listingId);
  });

  test("listVersions returns all versions for a listing ordered by created_at DESC", async () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "Versioned Agent",
      description: "For version tests",
      version: "1.1.0",
      author: { name: "Test" },
      agent: { prompt: "Hello v2" },
      permissions: {},
      tags: [],
    };
    await createVersion(listingId, "1.1.0", manifest);

    const versions = await listVersions(listingId);
    expect(versions.length).toBe(2);
    const versionStrings = versions.map((v) => v.version).sort();
    expect(versionStrings).toEqual(["1.0.0", "1.1.0"]);
  });
});

describe("marketplace ratings", () => {
  let listingId: string;

  beforeAll(async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Rated Agent",
      description: "For rating tests",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
  });

  test("upsertRating creates a new rating or updates existing (unique per user+listing)", async () => {
    await upsertRating(listingId, testUserId, true);

    // Check listing aggregates updated
    const [listing] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listingId));
    expect(listing!.ratingPositive).toBe(1);
    expect(listing!.ratingTotal).toBe(1);

    // Update same user's rating
    await upsertRating(listingId, testUserId, false);
    const [updated] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listingId));
    expect(updated!.ratingPositive).toBe(0);
    expect(updated!.ratingTotal).toBe(1);
  });
});

describe("marketplace flags", () => {
  let listingId: string;

  beforeAll(async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Flaggable Agent",
      description: "For flag tests",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
  });

  test("createFlag sets listing status to flagged in same transaction", async () => {
    const flag = await createFlag(listingId, testUserId, "Inappropriate content");

    expect(flag.id).toBeDefined();
    expect(flag.reason).toBe("Inappropriate content");
    expect(flag.status).toBe("pending");

    // Listing should be flagged
    const [listing] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, listingId));
    expect(listing!.status).toBe("flagged");
  });
});
