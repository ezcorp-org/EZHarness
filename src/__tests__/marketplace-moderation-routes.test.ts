/**
 * Marketplace Moderation Route Integration Tests
 *
 * Tests the moderation-specific SvelteKit route handlers:
 * POST /api/marketplace/[id]/flag (flag listing)
 * GET /api/marketplace/flags (admin pending flags)
 * GET/PATCH /api/marketplace/[id]/flags (admin flag history & resolve)
 * DELETE /api/marketplace/[id]/delete (admin hard-delete)
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// Import route handlers
import { POST as flagPOST } from "../../web/src/routes/api/marketplace/[id]/flag/+server";
import { GET as pendingFlagsGET } from "../../web/src/routes/api/marketplace/flags/+server";
import { GET as flagHistoryGET, PATCH as flagResolvePATCH } from "../../web/src/routes/api/marketplace/[id]/flags/+server";
import { DELETE as hardDELETE } from "../../web/src/routes/api/marketplace/[id]/delete/+server";

// DB helpers for setup
import { getDb } from "../db/connection";
import { users, marketplaceListings } from "../db/schema";
import { createFlag } from "../db/queries/marketplace-ratings";
import { createListing } from "../db/queries/marketplace";
import { listAuditLog } from "../db/queries/audit-log";

const AUTHOR: AuthUser = { id: "modrt-author-001", email: "author@modrt.test", name: "Route Author", role: "member" };
const MEMBER: AuthUser = { id: "modrt-member-001", email: "member@modrt.test", name: "Route Member", role: "member" };
const ADMIN: AuthUser = { id: "modrt-admin-001", email: "admin@modrt.test", name: "Route Admin", role: "admin" };

async function createTestListing(name: string) {
  return createListing({
    authorId: AUTHOR.id,
    name,
    description: `${name} desc`,
    category: "Productivity",
    tags: ["test"],
    latestVersion: "1.0.0",
  });
}

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: AUTHOR.id, email: AUTHOR.email, passwordHash: "h", name: AUTHOR.name, role: "member" },
    { id: MEMBER.id, email: MEMBER.email, passwordHash: "h", name: MEMBER.name, role: "member" },
    { id: ADMIN.id, email: ADMIN.email, passwordHash: "h", name: ADMIN.name, role: "admin" },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

// ── POST /api/marketplace/[id]/flag ─────────────────────────────────

describe("POST /api/marketplace/[id]/flag", () => {
  let flagListingId: string;

  beforeAll(async () => {
    const listing = await createTestListing("Flag Mod Test Listing");
    flagListingId = listing.id;
  });

  test("requires authentication (no user in locals)", () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "Spam" },
    });
    expect(() => flagPOST(event)).toThrow();
  });

  test("returns 400 if reason is missing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: {},
      user: MEMBER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("reason");
  });

  test("returns 400 if reason is empty string", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "" },
      user: MEMBER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("reason");
  });

  test("returns 400 if reason is not a string", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: 123 },
      user: MEMBER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("reason");
  });

  test("accepts valid flag with category", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "This is spam", category: "spam" },
      user: MEMBER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("defaults category to 'other' when invalid category provided", async () => {
    const listing2 = await createTestListing("Flag Cat Default Listing");
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listing2.id}/flag`,
      params: { id: listing2.id },
      body: { reason: "Bad content", category: "nonexistent-category" },
      user: MEMBER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
    // Verify the flag was created with "other" category by checking history
    const histEvent = createMockEvent({
      url: `http://localhost/api/marketplace/${listing2.id}/flags`,
      params: { id: listing2.id },
      user: ADMIN,
    });
    const histRes = await flagHistoryGET(histEvent);
    const histData = await jsonFromResponse(histRes);
    expect(histData.flags.length).toBe(1);
    expect(histData.flags[0].category).toBe("other");
  });

  test("returns 429 when user exceeds 5 flags per hour", async () => {
    // Create 5 flags directly via query for a rate-limit test user
    const rateLimitUserId = "modrt-ratelimit-001";
    await getDb().insert(users).values({
      id: rateLimitUserId, email: "ratelimit@modrt.test", passwordHash: "h", name: "Rate Limiter", role: "member",
    });

    const rateLimitListing = await createTestListing("Rate Limit Test Listing");
    for (let i = 0; i < 5; i++) {
      await createFlag(rateLimitListing.id, rateLimitUserId, `Flag reason ${i}`, "spam");
    }

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${rateLimitListing.id}/flag`,
      params: { id: rateLimitListing.id },
      body: { reason: "One too many" },
      user: { id: rateLimitUserId, email: "ratelimit@modrt.test", name: "Rate Limiter", role: "member" },
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(429);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("Rate limit");
  });
});

// ── Flag threshold behavior ─────────────────────────────────────────

describe("createFlag threshold", () => {
  test("listing becomes flagged on first flag (threshold is 1)", async () => {
    const { eq } = require("drizzle-orm");
    const db = getDb();

    // Create dedicated users for threshold test
    const thresholdUsers = [
      { id: "modrt-thresh-001", email: "thresh1@modrt.test", passwordHash: "h", name: "Thresh1", role: "member" as const },
      { id: "modrt-thresh-002", email: "thresh2@modrt.test", passwordHash: "h", name: "Thresh2", role: "member" as const },
      { id: "modrt-thresh-003", email: "thresh3@modrt.test", passwordHash: "h", name: "Thresh3", role: "member" as const },
    ];
    await db.insert(users).values(thresholdUsers);

    const listing = await createTestListing("Threshold Test Listing");

    // Flag 1: listing should now be flagged (threshold is 1)
    await createFlag(listing.id, thresholdUsers[0]!.id, "reason 1", "spam");
    let [row] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(row!.status).toBe("flagged");

    // Flag 2: listing remains flagged
    await createFlag(listing.id, thresholdUsers[1]!.id, "reason 2", "spam");
    [row] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(row!.status).toBe("flagged");

    // Flag 3: listing still flagged
    await createFlag(listing.id, thresholdUsers[2]!.id, "reason 3", "spam");
    [row] = await db.select().from(marketplaceListings).where(eq(marketplaceListings.id, listing.id));
    expect(row!.status).toBe("flagged");
  });
});

// ── GET /api/marketplace/flags (admin pending flags) ────────────────

describe("GET /api/marketplace/flags", () => {
  test("returns 403 for non-admin user", () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/flags",
      user: MEMBER,
    });
    expect(() => pendingFlagsGET(event)).toThrow();
  });

  test("returns pending flags array for admin", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/flags",
      user: ADMIN,
    });
    const res = await pendingFlagsGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.flags).toBeInstanceOf(Array);
    expect(data.flags.length).toBeGreaterThan(0);
  });

  test("returns enriched flags with listing info (name, slug)", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/flags",
      user: ADMIN,
    });
    const res = await pendingFlagsGET(event);
    const data = await jsonFromResponse(res);
    const withListing = data.flags.find((f: any) => f.listing !== null);
    expect(withListing).toBeDefined();
    expect(withListing.listing.name).toBeDefined();
    expect(withListing.listing.slug).toBeDefined();
    expect(withListing.listing.id).toBeDefined();
  });
});

// ── GET/PATCH /api/marketplace/[id]/flags (admin flag history & resolve) ──

describe("GET/PATCH /api/marketplace/[id]/flags", () => {
  let resolveListingId: string;
  let flagIdToDismiss: string;
  let flagIdToRemove: string;

  beforeAll(async () => {
    const listing = await createTestListing("Resolve Test Listing");
    resolveListingId = listing.id;
    const flag1 = await createFlag(resolveListingId, MEMBER.id, "Flag to dismiss", "spam");
    flagIdToDismiss = flag1.id;
    const flag2 = await createFlag(resolveListingId, AUTHOR.id, "Flag to remove", "malicious");
    flagIdToRemove = flag2.id;
  });

  test("GET returns flag history for listing", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${resolveListingId}/flags`,
      params: { id: resolveListingId },
      user: ADMIN,
    });
    const res = await flagHistoryGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.flags).toBeInstanceOf(Array);
    expect(data.flags.length).toBe(2);
  });

  test("PATCH returns 400 for missing flagId", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${resolveListingId}/flags`,
      params: { id: resolveListingId },
      body: { action: "dismissed" },
      user: ADMIN,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("flagId");
  });

  test("PATCH returns 400 for invalid action", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${resolveListingId}/flags`,
      params: { id: resolveListingId },
      body: { flagId: flagIdToDismiss, action: "invalid-action" },
      user: ADMIN,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(400);
  });

  test("PATCH dismisses flag successfully", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${resolveListingId}/flags`,
      params: { id: resolveListingId },
      body: { flagId: flagIdToDismiss, action: "dismissed" },
      user: ADMIN,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("PATCH removes flag and sets listing to removed", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${resolveListingId}/flags`,
      params: { id: resolveListingId },
      body: { flagId: flagIdToRemove, action: "removed" },
      user: ADMIN,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);

    // Verify listing status is now "removed"
    const [listing] = await getDb()
      .select()
      .from(marketplaceListings)
      .where(require("drizzle-orm").eq(marketplaceListings.id, resolveListingId));
    expect(listing!.status).toBe("removed");
  });

  test("PATCH creates audit log entry", async () => {
    const auditListing = await createTestListing("Audit Flag Listing");
    const flag = await createFlag(auditListing.id, MEMBER.id, "Audit test flag", "other");

    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${auditListing.id}/flags`,
      params: { id: auditListing.id },
      body: { flagId: flag.id, action: "dismissed" },
      user: ADMIN,
    });
    await flagResolvePATCH(event);

    const logs = await listAuditLog({ action: "marketplace:flag:dismissed" });
    const entry = logs.find((l) => l.target === auditListing.id);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(ADMIN.id);
  });
});

// ── DELETE /api/marketplace/[id]/delete (admin hard-delete) ─────────

describe("DELETE /api/marketplace/[id]/delete", () => {
  let deleteListingId: string;

  beforeAll(async () => {
    const listing = await createTestListing("Hard Delete Listing");
    deleteListingId = listing.id;
  });

  test("returns 403 for non-admin", () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${deleteListingId}/delete`,
      params: { id: deleteListingId },
      user: MEMBER,
    });
    expect(() => hardDELETE(event)).toThrow();
  });

  test("hard-deletes listing for admin, returns 200", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${deleteListingId}/delete`,
      params: { id: deleteListingId },
      user: ADMIN,
    });
    const res = await hardDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);

    // Verify listing is gone
    const { eq } = require("drizzle-orm");
    const rows = await getDb()
      .select()
      .from(marketplaceListings)
      .where(eq(marketplaceListings.id, deleteListingId));
    expect(rows.length).toBe(0);
  });

  test("returns 404 for non-existent listing", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${crypto.randomUUID()}/delete`,
      params: { id: crypto.randomUUID() },
      user: ADMIN,
    });
    const res = await hardDELETE(event);
    expect(res.status).toBe(404);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("not found");
  });

  test("creates audit log entry on delete", async () => {
    const listing = await createTestListing("Audit Delete Listing");
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${listing.id}/delete`,
      params: { id: listing.id },
      user: ADMIN,
    });
    await hardDELETE(event);

    const logs = await listAuditLog({ action: "marketplace:delete" });
    const entry = logs.find((l) => l.target === listing.id);
    expect(entry).toBeDefined();
    expect(entry!.userId).toBe(ADMIN.id);
  });
});
