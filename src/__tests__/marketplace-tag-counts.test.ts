/**
 * Phase 49.3 — `getMarketplaceTagCounts()` aggregation tests against
 * a real PGlite instance. Mirrors `marketplace-queries-deep.test.ts`
 * setup so the query exercises the same `jsonb_array_elements_text`
 * code path it'll run in production.
 *
 * Coverage:
 *   - Empty marketplace → empty array (not error).
 *   - Tags from multiple listings are summed correctly.
 *   - Tags appearing in `removed` / `flagged` listings are excluded.
 *   - Sort order is `count DESC, tag ASC` (stable + predictable).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import {
  createListing,
  updateListingStatus,
  getMarketplaceTagCounts,
} from "../db/queries/marketplace";
import { getDb } from "../db/connection";
import { users, marketplaceListings } from "../db/schema";

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  userId = crypto.randomUUID();
  await getDb().insert(users).values({
    id: userId,
    email: "tagcount@test.com",
    passwordHash: "h",
    name: "User",
    role: "member",
  });
});

afterAll(async () => {
  await closeTestDb();
});

async function clearListings() {
  // Each test wants a clean slate so the assertions don't depend on
  // previous test residue (PGlite persists between tests inside the
  // same `describe`).
  await getDb().delete(marketplaceListings);
}

describe("getMarketplaceTagCounts", () => {
  test("empty marketplace → empty array", async () => {
    await clearListings();
    const result = await getMarketplaceTagCounts();
    expect(result).toEqual([]);
  });

  test("aggregates tags across multiple active listings", async () => {
    await clearListings();
    await createListing({
      authorId: userId,
      name: "Listing One",
      description: "desc",
      category: "Productivity",
      tags: ["research", "writing"],
      latestVersion: "1.0.0",
    });
    await createListing({
      authorId: userId,
      name: "Listing Two",
      description: "desc",
      category: "Development",
      tags: ["research", "code"],
      latestVersion: "1.0.0",
    });
    await createListing({
      authorId: userId,
      name: "Listing Three",
      description: "desc",
      category: "Other",
      tags: ["research"],
      latestVersion: "1.0.0",
    });

    const result = await getMarketplaceTagCounts();
    // research appears in 3 listings, writing in 1, code in 1.
    expect(result).toEqual([
      { tag: "research", count: 3 },
      // count=1 ties → tag asc
      { tag: "code", count: 1 },
      { tag: "writing", count: 1 },
    ]);
  });

  test("excludes tags from removed / flagged listings", async () => {
    await clearListings();
    const live = await createListing({
      authorId: userId,
      name: "Live Listing",
      description: "desc",
      category: "Productivity",
      tags: ["alpha"],
      latestVersion: "1.0.0",
    });
    const removed = await createListing({
      authorId: userId,
      name: "Removed Listing",
      description: "desc",
      category: "Productivity",
      tags: ["alpha", "removed-only"],
      latestVersion: "1.0.0",
    });
    const flagged = await createListing({
      authorId: userId,
      name: "Flagged Listing",
      description: "desc",
      category: "Productivity",
      tags: ["alpha", "flagged-only"],
      latestVersion: "1.0.0",
    });
    await updateListingStatus(removed.id, "removed");
    await updateListingStatus(flagged.id, "flagged");

    const result = await getMarketplaceTagCounts();
    // Only the live listing contributes — its single "alpha" tag.
    expect(result).toEqual([{ tag: "alpha", count: 1 }]);
    expect(live.id).toBeDefined(); // referenced so lint stays quiet
  });

  test("count tie → tag asc", async () => {
    await clearListings();
    await createListing({
      authorId: userId,
      name: "L1",
      description: "d",
      category: "Productivity",
      tags: ["zeta"],
      latestVersion: "1.0.0",
    });
    await createListing({
      authorId: userId,
      name: "L2",
      description: "d",
      category: "Productivity",
      tags: ["alpha"],
      latestVersion: "1.0.0",
    });
    await createListing({
      authorId: userId,
      name: "L3",
      description: "d",
      category: "Productivity",
      tags: ["mike"],
      latestVersion: "1.0.0",
    });
    const result = await getMarketplaceTagCounts();
    expect(result.map((r) => r.tag)).toEqual(["alpha", "mike", "zeta"]);
  });
});
