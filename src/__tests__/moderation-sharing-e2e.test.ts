/**
 * Cross-feature E2E Tests: Moderation + Sharing
 *
 * Tests end-to-end flows that span marketplace moderation and agent sharing.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// Route handlers
import { POST as flagPOST } from "../../web/src/routes/api/marketplace/[id]/flag/+server";
import { GET as pendingFlagsGET } from "../../web/src/routes/api/marketplace/flags/+server";
import { GET as flagHistoryGET, PATCH as flagResolvePATCH } from "../../web/src/routes/api/marketplace/[id]/flags/+server";
import { DELETE as hardDELETE } from "../../web/src/routes/api/marketplace/[id]/delete/+server";
import { GET as sharesGET, POST as sharesPOST, DELETE as sharesDELETE } from "../../web/src/routes/api/agents/[id]/share/+server";

// DB queries
import { createListing, browseMarketplace } from "../db/queries/marketplace";
import { createFlag, getFlagHistory } from "../db/queries/marketplace-ratings";
import { shareAgentWithUser, getSharedAgentsForUser, getAgentShares } from "../db/queries/agent-shares";
import { createAgentConfig } from "../db/queries/agent-configs";
import { createUser } from "../db/queries/users";

// ── Helpers ──────────────────────────────────────────────────────────

function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

function makeUser(u: { id: string; email: string; name: string; role: string }): AuthUser {
  return { id: u.id, email: u.email, name: u.name, role: u.role as "member" | "admin" };
}

async function makeTestListing(authorId: string, name: string) {
  return createListing({
    authorId,
    name,
    description: `${name} description`,
    category: "Productivity",
    tags: ["e2e"],
    latestVersion: "1.0.0",
  });
}

// ── 1. Full moderation lifecycle via routes ──────────────────────────

describe("E2E: Full moderation lifecycle via routes", () => {
  let member: AuthUser;
  let admin: AuthUser;
  let author: AuthUser;
  let listingId: string;
  let flagId: string;

  beforeAll(async () => {
    await setupTestDb();
    const a = await createUser({ email: "e2e-1-author@test.com", passwordHash: "h", name: "E2E1 Author", role: "member" });
    const m = await createUser({ email: "e2e-1-member@test.com", passwordHash: "h", name: "E2E1 Member", role: "member" });
    const ad = await createUser({ email: "e2e-1-admin@test.com", passwordHash: "h", name: "E2E1 Admin", role: "admin" });
    author = makeUser(a);
    member = makeUser(m);
    admin = makeUser(ad);
    const listing = await makeTestListing(author.id, "E2E Lifecycle Listing");
    listingId = listing.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("member flags listing via POST route", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/flag`,
      params: { id: listingId },
      body: { reason: "Looks like spam", category: "spam" },
      user: member,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("admin sees flag in pending flags list", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/flags",
      user: admin,
    });
    const res = await pendingFlagsGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    const match = data.flags.find((f: any) => f.listingId === listingId);
    expect(match).toBeDefined();
    flagId = match.id;
  });

  test("admin dismisses the flag via PATCH", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${listingId}/flags`,
      params: { id: listingId },
      body: { flagId, action: "dismissed" },
      user: admin,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("listing is still active and visible in browseMarketplace", async () => {
    const results = await browseMarketplace({});
    const found = results.find((l) => l.id === listingId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("active");
  });
});

// ── 2. Flag → Remove → Verify hidden ────────────────────────────────

describe("E2E: Flag → Remove → Verify hidden", () => {
  let member: AuthUser;
  let admin: AuthUser;
  let author: AuthUser;
  let listingId: string;
  let flagId: string;

  beforeAll(async () => {
    await setupTestDb();
    const a = await createUser({ email: "e2e-2-author@test.com", passwordHash: "h", name: "E2E2 Author", role: "member" });
    const m = await createUser({ email: "e2e-2-member@test.com", passwordHash: "h", name: "E2E2 Member", role: "member" });
    const ad = await createUser({ email: "e2e-2-admin@test.com", passwordHash: "h", name: "E2E2 Admin", role: "admin" });
    author = makeUser(a);
    member = makeUser(m);
    admin = makeUser(ad);
    const listing = await makeTestListing(author.id, "E2E Remove Listing");
    listingId = listing.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("flag the listing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/flag`,
      params: { id: listingId },
      body: { reason: "Malicious content", category: "malicious" },
      user: member,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
  });

  test("admin marks flag as removed", async () => {
    const history = await getFlagHistory(listingId);
    flagId = at(history, 0, "flag").id;

    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${listingId}/flags`,
      params: { id: listingId },
      body: { flagId, action: "removed" },
      user: admin,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
  });

  test("browseMarketplace excludes the removed listing", async () => {
    const results = await browseMarketplace({});
    const found = results.find((l) => l.id === listingId);
    expect(found).toBeUndefined();
  });

  test("admin hard-deletes the listing", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${listingId}/delete`,
      params: { id: listingId },
      user: admin,
    });
    const res = await hardDELETE(event);
    expect(res.status).toBe(200);
  });

  test("listing is completely gone from DB", async () => {
    const { getDb } = await import("../db/connection");
    const { marketplaceListings } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");
    const rows = await getDb().select().from(marketplaceListings).where(eq(marketplaceListings.id, listingId));
    expect(rows.length).toBe(0);
  });
});

// ── 3. Share → Flag shared agent's marketplace listing → Moderate ────

describe("E2E: Share → Flag shared agent's listing → Moderate", () => {
  let userA: AuthUser;
  let userB: AuthUser;
  let userC: AuthUser;
  let admin: AuthUser;
  let agentId: string;
  let listingId: string;

  beforeAll(async () => {
    await setupTestDb();
    const a = await createUser({ email: "e2e-3-usera@test.com", passwordHash: "h", name: "E2E3 UserA", role: "member" });
    const b = await createUser({ email: "e2e-3-userb@test.com", passwordHash: "h", name: "E2E3 UserB", role: "member" });
    const c = await createUser({ email: "e2e-3-userc@test.com", passwordHash: "h", name: "E2E3 UserC", role: "member" });
    const ad = await createUser({ email: "e2e-3-admin@test.com", passwordHash: "h", name: "E2E3 Admin", role: "admin" });
    userA = makeUser(a);
    userB = makeUser(b);
    userC = makeUser(c);
    admin = makeUser(ad);

    // User A creates agent and publishes to marketplace
    const agent = await createAgentConfig({
      name: "E2E3 Shared Agent",
      description: "test agent",
      prompt: "you are a test",
      userId: userA.id,
    });
    agentId = agent.id;

    const listing = await makeTestListing(userA.id, "E2E3 Agent Listing");
    listingId = listing.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("User A shares agent with User B", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: agentId },
      body: { userIds: [userB.id] },
      user: userA,
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
  });

  test("User B can see the shared agent", async () => {
    const shared = await getSharedAgentsForUser(userB.id);
    const found = shared.find((a) => a.id === agentId);
    expect(found).toBeDefined();
  });

  test("User C flags the marketplace listing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/flag`,
      params: { id: listingId },
      body: { reason: "Inappropriate content", category: "other" },
      user: userC,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
  });

  test("admin resolves the flag as dismissed", async () => {
    const history = await getFlagHistory(listingId);
    const event = createMockEvent({
      method: "PATCH",
      url: `http://localhost/api/marketplace/${listingId}/flags`,
      params: { id: listingId },
      body: { flagId: at(history, 0, "flag").id, action: "dismissed" },
      user: admin,
    });
    const res = await flagResolvePATCH(event);
    expect(res.status).toBe(200);
  });

  test("agent sharing is still intact for User B after moderation", async () => {
    const shared = await getSharedAgentsForUser(userB.id);
    const found = shared.find((a) => a.id === agentId);
    expect(found).toBeDefined();
  });
});

// ── 4. Share lifecycle ───────────────────────────────────────────────

describe("E2E: Share lifecycle", () => {
  let owner: AuthUser;
  let userB: AuthUser;
  let agentId: string;

  beforeAll(async () => {
    await setupTestDb();
    const o = await createUser({ email: "e2e-4-owner@test.com", passwordHash: "h", name: "E2E4 Owner", role: "member" });
    const b = await createUser({ email: "e2e-4-userb@test.com", passwordHash: "h", name: "E2E4 UserB", role: "member" });
    owner = makeUser(o);
    userB = makeUser(b);

    const agent = await createAgentConfig({
      name: "E2E4 Lifecycle Agent",
      description: "test",
      prompt: "test",
      userId: owner.id,
    });
    agentId = agent.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("owner shares agent with User B (read)", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: agentId },
      body: { userIds: [userB.id], permission: "read" },
      user: owner,
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
  });

  test("User B sees the agent in shared list", async () => {
    const shared = await getSharedAgentsForUser(userB.id);
    const found = shared.find((a) => a.id === agentId);
    expect(found).toBeDefined();
  });

  test("owner upgrades permission to edit", async () => {
    const event = createMockEvent({
      method: "POST",
      params: { id: agentId },
      body: { userIds: [userB.id], permission: "edit" },
      user: owner,
    });
    const res = await sharesPOST(event);
    expect(res.status).toBe(200);
  });

  test("permission is now edit", async () => {
    const shares = await getAgentShares(agentId);
    const share = shares.find((s) => s.userId === userB.id);
    expect(share).toBeDefined();
    expect(share!.permission).toBe("edit");
  });

  test("owner unshares agent from User B", async () => {
    const event = createMockEvent({
      method: "DELETE",
      params: { id: agentId },
      body: { userId: userB.id },
      user: owner,
    });
    const res = await sharesDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.removed).toBe(true);
  });

  test("User B no longer sees the agent", async () => {
    const shared = await getSharedAgentsForUser(userB.id);
    const found = shared.find((a) => a.id === agentId);
    expect(found).toBeUndefined();
  });
});

// ── 5. Multiple flaggers then bulk dismiss ───────────────────────────

describe("E2E: Multiple flaggers then bulk dismiss", () => {
  let flagger1: AuthUser;
  let flagger2: AuthUser;
  let flagger3: AuthUser;
  let admin: AuthUser;
  let author: AuthUser;
  let listingId: string;

  beforeAll(async () => {
    await setupTestDb();
    const a = await createUser({ email: "e2e-5-author@test.com", passwordHash: "h", name: "E2E5 Author", role: "member" });
    const f1 = await createUser({ email: "e2e-5-f1@test.com", passwordHash: "h", name: "E2E5 Flagger1", role: "member" });
    const f2 = await createUser({ email: "e2e-5-f2@test.com", passwordHash: "h", name: "E2E5 Flagger2", role: "member" });
    const f3 = await createUser({ email: "e2e-5-f3@test.com", passwordHash: "h", name: "E2E5 Flagger3", role: "member" });
    const ad = await createUser({ email: "e2e-5-admin@test.com", passwordHash: "h", name: "E2E5 Admin", role: "admin" });
    author = makeUser(a);
    flagger1 = makeUser(f1);
    flagger2 = makeUser(f2);
    flagger3 = makeUser(f3);
    admin = makeUser(ad);

    const listing = await makeTestListing(author.id, "E2E Multi-Flag Listing");
    listingId = listing.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("3 users flag the same listing", async () => {
    for (const flagger of [flagger1, flagger2, flagger3]) {
      const event = createMockEvent({
        method: "POST",
        url: `http://localhost/api/marketplace/${listingId}/flag`,
        params: { id: listingId },
        body: { reason: `Flag from ${flagger.name}`, category: "spam" },
        user: flagger,
      });
      const res = await flagPOST(event);
      expect(res.status).toBe(200);
    }
  });

  test("flag history shows 3 pending flags", async () => {
    const history = await getFlagHistory(listingId);
    const pending = history.filter((f) => f.status === "pending");
    expect(pending.length).toBe(3);
  });

  test("admin dismisses all 3 flags one by one", async () => {
    const history = await getFlagHistory(listingId);
    for (const flag of history) {
      const event = createMockEvent({
        method: "PATCH",
        url: `http://localhost/api/marketplace/${listingId}/flags`,
        params: { id: listingId },
        body: { flagId: flag.id, action: "dismissed" },
        user: admin,
      });
      const res = await flagResolvePATCH(event);
      expect(res.status).toBe(200);
    }
  });

  test("listing is active with no pending flags", async () => {
    const results = await browseMarketplace({});
    const found = results.find((l) => l.id === listingId);
    expect(found).toBeDefined();
    expect(found!.status).toBe("active");

    const history = await getFlagHistory(listingId);
    const pending = history.filter((f) => f.status === "pending");
    expect(pending.length).toBe(0);
  });
});

// ── 6. Admin delete of flagged listing cleans up ─────────────────────

describe("E2E: Admin delete of flagged listing cleans up", () => {
  let member: AuthUser;
  let admin: AuthUser;
  let author: AuthUser;
  let listingId: string;

  beforeAll(async () => {
    await setupTestDb();
    const a = await createUser({ email: "e2e-6-author@test.com", passwordHash: "h", name: "E2E6 Author", role: "member" });
    const m = await createUser({ email: "e2e-6-member@test.com", passwordHash: "h", name: "E2E6 Member", role: "member" });
    const ad = await createUser({ email: "e2e-6-admin@test.com", passwordHash: "h", name: "E2E6 Admin", role: "admin" });
    author = makeUser(a);
    member = makeUser(m);
    admin = makeUser(ad);

    const listing = await makeTestListing(author.id, "E2E Cleanup Listing");
    listingId = listing.id;
  });

  afterAll(async () => { await closeTestDb(); });

  test("flag the listing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/flag`,
      params: { id: listingId },
      body: { reason: "Should be cleaned up", category: "other" },
      user: member,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
  });

  test("verify flag exists", async () => {
    const history = await getFlagHistory(listingId);
    expect(history.length).toBe(1);
  });

  test("admin hard-deletes the listing", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${listingId}/delete`,
      params: { id: listingId },
      user: admin,
    });
    const res = await hardDELETE(event);
    expect(res.status).toBe(200);
  });

  test("flags are also gone after hard-delete", async () => {
    const history = await getFlagHistory(listingId);
    expect(history.length).toBe(0);
  });
});
