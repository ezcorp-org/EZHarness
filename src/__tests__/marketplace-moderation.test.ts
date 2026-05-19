/**
 * Marketplace Moderation Integration Tests
 *
 * Tests: createFlag with category, auto-hide on any pending flag, countPendingFlagsByUser,
 * resolveFlag dismiss/remove, getFlagHistory, deleteListing, browseMarketplace excludes non-active.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

mockDbConnection();
mockServerAlias();

import { POST as flagPOST } from "../../web/src/routes/api/marketplace/[id]/flag/+server";
import { GET as pendingFlagsGET } from "../../web/src/routes/api/marketplace/flags/+server";
import { GET as flagHistoryGET, PATCH as flagResolvePATCH } from "../../web/src/routes/api/marketplace/[id]/flags/+server";
import { DELETE as hardDELETE } from "../../web/src/routes/api/marketplace/[id]/delete/+server";
import { getDb } from "../db/connection";
import { users, marketplaceListings, } from "../db/schema";
import {
  createFlag,
  countPendingFlagsByUser,
  getFlagHistory,
  resolveFlag,
} from "../db/queries/marketplace-ratings";
import {
  deleteListing,
  browseMarketplace,
  createListing,
} from "../db/queries/marketplace";
import { eq } from "drizzle-orm";

const AUTHOR: AuthUser = { id: "mod-author-001", email: "author@mod.test", name: "Mod Author", role: "member" };
const FLAGGER1: AuthUser = { id: "mod-flagger-001", email: "flagger1@mod.test", name: "Flagger 1", role: "member" };
const FLAGGER2: AuthUser = { id: "mod-flagger-002", email: "flagger2@mod.test", name: "Flagger 2", role: "member" };
const FLAGGER3: AuthUser = { id: "mod-flagger-003", email: "flagger3@mod.test", name: "Flagger 3", role: "member" };
const ROUTE_FLAGGER: AuthUser = { id: "mod-route-flagger-001", email: "routeflagger@mod.test", name: "Route Flagger", role: "member" };
const RATE_LIMIT_USER: AuthUser = { id: "mod-ratelimit-001", email: "ratelimit@mod.test", name: "Rate Limit User", role: "member" };
const ADMIN: AuthUser = { id: "mod-admin-001", email: "admin@mod.test", name: "Mod Admin", role: "admin" };

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: AUTHOR.id, email: AUTHOR.email, passwordHash: "h", name: AUTHOR.name, role: "member" },
    { id: FLAGGER1.id, email: FLAGGER1.email, passwordHash: "h", name: FLAGGER1.name, role: "member" },
    { id: FLAGGER2.id, email: FLAGGER2.email, passwordHash: "h", name: FLAGGER2.name, role: "member" },
    { id: FLAGGER3.id, email: FLAGGER3.email, passwordHash: "h", name: FLAGGER3.name, role: "member" },
    { id: ROUTE_FLAGGER.id, email: ROUTE_FLAGGER.email, passwordHash: "h", name: ROUTE_FLAGGER.name, role: "member" },
    { id: RATE_LIMIT_USER.id, email: RATE_LIMIT_USER.email, passwordHash: "h", name: RATE_LIMIT_USER.name, role: "member" },
    { id: ADMIN.id, email: ADMIN.email, passwordHash: "h", name: ADMIN.name, role: "admin" },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

async function createTestListing(name: string) {
  return createListing({
    authorId: AUTHOR.id,
    name,
    description: `${name} description`,
    category: "Productivity",
    tags: ["test"],
    latestVersion: "1.0.0",
  });
}

// ── createFlag with category ─────────────────────────────────────────

describe("createFlag", () => {
  test("stores category on flag", async () => {
    const listing = await createTestListing("Flag Category Test");
    const flag = await createFlag(listing.id, FLAGGER1.id, "spam content", "spam");
    expect(flag.category).toBe("spam");
  });

  test("defaults category to 'other'", async () => {
    const listing = await createTestListing("Flag Default Category");
    const flag = await createFlag(listing.id, FLAGGER1.id, "bad listing");
    expect(flag.category).toBe("other");
  });

  test("single flag auto-hides listing (threshold is 1)", async () => {
    const listing = await createTestListing("Flag Status Test");
    await createFlag(listing.id, FLAGGER1.id, "problematic", "misleading");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.status).toBe("flagged");
  });

  test("updates flagCount with distinct flagger count", async () => {
    const listing = await createTestListing("Flag Count Test");
    await createFlag(listing.id, FLAGGER1.id, "reason1", "spam");
    await createFlag(listing.id, FLAGGER2.id, "reason2", "spam");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.flagCount).toBe(2);
  });
});

// ── Auto-hide on any pending flag ────────────────────────────────────

describe("auto-hide threshold", () => {
  test("listing status becomes flagged (auto-hidden) when any flag is pending", async () => {
    const listing = await createTestListing("Auto Hide Test");
    await createFlag(listing.id, FLAGGER1.id, "r1", "spam");
    await createFlag(listing.id, FLAGGER2.id, "r2", "spam");
    await createFlag(listing.id, FLAGGER3.id, "r3", "spam");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.flagCount).toBe(3);
    expect(updated.status).toBe("flagged");
  });
});

// ── countPendingFlagsByUser ──────────────────────────────────────────

describe("countPendingFlagsByUser", () => {
  test("returns count of flags created in last hour", async () => {
    const listing = await createTestListing("Rate Limit Test");
    await createFlag(listing.id, FLAGGER1.id, "r1", "spam");
    const count = await countPendingFlagsByUser(FLAGGER1.id);
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

// ── resolveFlag ──────────────────────────────────────────────────────

describe("resolveFlag", () => {
  test("dismissed restores listing to active when no other pending flags", async () => {
    const listing = await createTestListing("Dismiss Test");
    const flag = await createFlag(listing.id, FLAGGER1.id, "reason", "spam");
    await resolveFlag(flag.id, ADMIN.id, "dismissed");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.status).toBe("active");
  });

  test("dismissed does NOT restore listing if status is 'removed'", async () => {
    const listing = await createTestListing("Dismiss Removed Test");
    const flag = await createFlag(listing.id, FLAGGER1.id, "reason", "spam");
    // Manually set to removed
    await getDb().update(marketplaceListings).set({ status: "removed" }).where(eq(marketplaceListings.id, listing.id));
    await resolveFlag(flag.id, ADMIN.id, "dismissed");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.status).toBe("removed");
  });

  test("removed sets listing status to removed", async () => {
    const listing = await createTestListing("Remove Test");
    const flag = await createFlag(listing.id, FLAGGER1.id, "reason", "malicious");
    await resolveFlag(flag.id, ADMIN.id, "removed");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(updated.status).toBe("removed");
  });

  test("recalculates flagCount after resolving", async () => {
    const listing = await createTestListing("Recalc Count Test");
    const flag1 = await createFlag(listing.id, FLAGGER1.id, "r1", "spam");
    await createFlag(listing.id, FLAGGER2.id, "r2", "spam");
    await resolveFlag(flag1.id, ADMIN.id, "dismissed");
    const [updated] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    // Only flagger2's pending flag remains
    expect(updated.flagCount).toBe(1);
  });
});

// ── getFlagHistory ───────────────────────────────────────────────────

describe("getFlagHistory", () => {
  test("returns all flags including dismissed ones", async () => {
    const listing = await createTestListing("History Test");
    const flag1 = await createFlag(listing.id, FLAGGER1.id, "r1", "spam");
    await createFlag(listing.id, FLAGGER2.id, "r2", "misleading");
    await resolveFlag(flag1.id, ADMIN.id, "dismissed");
    const history = await getFlagHistory(listing.id);
    expect(history.length).toBe(2);
    const statuses = history.map((f) => f.status);
    expect(statuses).toContain("dismissed");
    expect(statuses).toContain("pending");
  });
});

// ── deleteListing ────────────────────────────────────────────────────

describe("deleteListing", () => {
  test("hard-deletes listing and returns true", async () => {
    const listing = await createTestListing("Delete Test");
    const result = await deleteListing(listing.id);
    expect(result).toBe(true);
    const [gone] = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(gone).toBeUndefined();
  });

  test("returns false for non-existent listing", async () => {
    const result = await deleteListing("non-existent-id");
    expect(result).toBe(false);
  });
});

// ── browseMarketplace excludes non-active ────────────────────────────

describe("browseMarketplace", () => {
  test("excludes flagged and removed listings", async () => {
    const active = await createTestListing("Browse Active");
    const flagged = await createTestListing("Browse Flagged");
    const removed = await createTestListing("Browse Removed");
    await getDb().update(marketplaceListings).set({ status: "flagged" }).where(eq(marketplaceListings.id, flagged.id));
    await getDb().update(marketplaceListings).set({ status: "removed" }).where(eq(marketplaceListings.id, removed.id));

    const results = await browseMarketplace({});
    const ids = results.map((r) => r.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(flagged.id);
    expect(ids).not.toContain(removed.id);
  });
});

// ── API Route Tests ──────────────────────────────────────────────────

describe("POST /api/marketplace/[id]/flag", () => {
  test("accepts category in body", async () => {
    const listing = await createTestListing("Route Flag Category");
    const event = createMockEvent({
      method: "POST",
      params: { id: listing.id },
      body: { reason: "spam content", category: "spam" },
      user: ROUTE_FLAGGER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
  });

  test("returns 429 after 5 flags per hour", async () => {
    // Create 5 listings and flag them all as RATE_LIMIT_USER
    for (let i = 0; i < 5; i++) {
      const listing = await createTestListing(`Rate Limit Route ${i}`);
      await createFlag(listing.id, RATE_LIMIT_USER.id, `reason ${i}`, "spam");
    }
    const listing6 = await createTestListing("Rate Limit Route 6");
    const event = createMockEvent({
      method: "POST",
      params: { id: listing6.id },
      body: { reason: "one more", category: "spam" },
      user: RATE_LIMIT_USER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(429);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("Rate limit exceeded");
  });
});

describe("GET /api/marketplace/flags (admin)", () => {
  test("returns 403 for non-admin", async () => {
    const event = createMockEvent({ user: FLAGGER1 });
    expect(() => pendingFlagsGET(event)).toThrow();
  });

  test("returns pending flags for admin", async () => {
    const event = createMockEvent({ user: ADMIN });
    const res = await pendingFlagsGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.flags).toBeInstanceOf(Array);
  });
});

describe("GET/PATCH /api/marketplace/[id]/flags (admin)", () => {
  test("GET returns flag history", async () => {
    const listing = await createTestListing("Flag History Route");
    await createFlag(listing.id, FLAGGER1.id, "bad", "spam");
    const event = createMockEvent({ params: { id: listing.id }, user: ADMIN });
    const res = await flagHistoryGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.flags.length).toBeGreaterThanOrEqual(1);
  });

  test("PATCH resolves flag", async () => {
    const listing = await createTestListing("Resolve Route");
    const flag = await createFlag(listing.id, FLAGGER3.id, "bad", "malicious");
    const event = createMockEvent({
      method: "PATCH",
      params: { id: listing.id },
      body: { flagId: flag.id, action: "dismissed" },
      user: ADMIN,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/marketplace/[id]/delete (admin)", () => {
  test("returns 403 for non-admin", async () => {
    const listing = await createTestListing("Delete Auth Test");
    const event = createMockEvent({ method: "DELETE", params: { id: listing.id }, user: FLAGGER1 });
    expect(() => hardDELETE(event)).toThrow();
  });

  test("hard-deletes listing for admin", async () => {
    const listing = await createTestListing("Hard Delete Route");
    const event = createMockEvent({ method: "DELETE", params: { id: listing.id }, user: ADMIN });
    const res = await hardDELETE(event);
    expect(res.status).toBe(200);
  });

  test("returns 404 for non-existent listing", async () => {
    const event = createMockEvent({ method: "DELETE", params: { id: "nonexistent" }, user: ADMIN });
    const res = await hardDELETE(event);
    expect(res.status).toBe(404);
  });
});
