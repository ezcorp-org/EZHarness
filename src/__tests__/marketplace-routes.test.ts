/**
 * Marketplace HTTP Route Integration Tests
 *
 * Tests the actual SvelteKit route handlers with mock request events.
 * Covers: GET/POST /api/marketplace, GET/DELETE /api/marketplace/[id],
 * POST install, POST rate, POST flag, GET versions, GET export, POST import,
 * GET updates.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { mockServerAlias, createMockEvent, jsonFromResponse } from "./helpers/mock-request";
import type { AuthUser } from "../auth/types";

// Must be at module level BEFORE handler imports
mockDbConnection();
mockServerAlias();

// Import route handlers
import { GET as browseGET, POST as publishPOST } from "../../web/src/routes/api/marketplace/+server";
import { GET as detailGET, DELETE as removeDELETE } from "../../web/src/routes/api/marketplace/[id]/+server";
import { POST as installPOST } from "../../web/src/routes/api/marketplace/[id]/install/+server";
import { POST as ratePOST } from "../../web/src/routes/api/marketplace/[id]/rate/+server";
import { POST as flagPOST } from "../../web/src/routes/api/marketplace/[id]/flag/+server";
import { GET as versionsGET } from "../../web/src/routes/api/marketplace/[id]/versions/+server";
import { GET as exportGET } from "../../web/src/routes/api/marketplace/export/[id]/+server";
import { POST as importPOST } from "../../web/src/routes/api/marketplace/import/+server";
import { GET as updatesGET } from "../../web/src/routes/api/marketplace/updates/+server";

// DB helpers for setup
import { getDb } from "../db/connection";
import { users } from "../db/schema";
import { createAgentConfig } from "../db/queries/agent-configs";

const AUTHOR: AuthUser = { id: "route-author-001", email: "author@route.test", name: "Route Author", role: "member" };
const INSTALLER: AuthUser = { id: "route-installer-001", email: "installer@route.test", name: "Route Installer", role: "member" };
const ADMIN: AuthUser = { id: "route-admin-001", email: "admin@route.test", name: "Route Admin", role: "admin" };

let agentConfigId: string;

beforeAll(async () => {
  await setupTestDb();
  await getDb().insert(users).values([
    { id: AUTHOR.id, email: AUTHOR.email, passwordHash: "h", name: AUTHOR.name, role: "member" },
    { id: INSTALLER.id, email: INSTALLER.email, passwordHash: "h", name: INSTALLER.name, role: "member" },
    { id: ADMIN.id, email: ADMIN.email, passwordHash: "h", name: ADMIN.name, role: "admin" },
  ]);

  const config = await createAgentConfig({
    name: "Route Test Agent",
    description: "Agent for route testing",
    prompt: "You are a helpful route test agent.",
    capabilities: ["llm"],
    category: "Productivity",
    userId: AUTHOR.id,
  });
  agentConfigId = config.id;
});

afterAll(async () => {
  await closeTestDb();
});

// ── GET /api/marketplace (Browse) ───────────────────────────────────

describe("GET /api/marketplace", () => {
  test("browse returns empty listings when no data exists", async () => {
    const event = createMockEvent({ url: "http://localhost/api/marketplace" });
    const res = await browseGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.listings).toBeInstanceOf(Array);
    expect(data.featured).toBeInstanceOf(Array);
  });

  test("browse is public (no auth required)", async () => {
    const event = createMockEvent({ url: "http://localhost/api/marketplace" });
    // No user set on locals
    const res = await browseGET(event);
    expect(res.status).toBe(200);
  });

  test("browse respects query, category, sort, limit, offset params", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace?q=test&category=Productivity&sort=newest&limit=5&offset=0",
    });
    const res = await browseGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.listings).toBeInstanceOf(Array);
  });

  test("browse caps limit at 50", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace?limit=999",
    });
    const res = await browseGET(event);
    expect(res.status).toBe(200);
    // Should not error, limit is capped internally
  });

  test("browse includes ratingPercent on listings", async () => {
    // First publish something to browse
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId, version: "1.0.0", tags: ["route-test"] },
      user: AUTHOR,
    });
    await publishPOST(pubEvent);

    const event = createMockEvent({ url: "http://localhost/api/marketplace" });
    const res = await browseGET(event);
    const data = await jsonFromResponse(res);
    expect(data.listings.length).toBeGreaterThan(0);
    for (const listing of data.listings) {
      expect(typeof listing.ratingPercent).toBe("number");
    }
  });

  test("browse omits featured when offset > 0", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace?offset=10",
    });
    const res = await browseGET(event);
    const data = await jsonFromResponse(res);
    expect(data.featured).toBeUndefined();
  });
});

// ── POST /api/marketplace (Publish) ─────────────────────────────────

describe("POST /api/marketplace", () => {
  test("publish requires authentication", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId },
    });
    // No user -> requireAuth throws
    expect(() => publishPOST(event)).toThrow();
  });

  test("publish requires agentConfigId", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: {},
      user: AUTHOR,
    });
    const res = await publishPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Validation failed");
    expect(data.fields.agentConfigId).toBeDefined();
  });

  test("publish with non-existent agentConfigId returns 404", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: crypto.randomUUID() },
      user: AUTHOR,
    });
    const res = await publishPOST(event);
    expect(res.status).toBe(404);
  });

  test("publish with another user's agentConfigId returns 404", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId },
      user: INSTALLER, // Not the owner
    });
    const res = await publishPOST(event);
    expect(res.status).toBe(404);
  });

  test("publish creates listing with version 1.0.0 by default", async () => {
    // Need a fresh agent config since the prior publish test already published one
    const freshConfig = await createAgentConfig({
      name: "Fresh Publish Agent",
      description: "For publish route test",
      prompt: "Prompt for publish test.",
      capabilities: ["llm"],
      category: "Development",
      userId: AUTHOR.id,
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: freshConfig.id, tags: ["fresh"] },
      user: AUTHOR,
    });
    const res = await publishPOST(event);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.listing).toBeDefined();
    expect(data.version).toBeDefined();
    expect(data.version.version).toBe("1.0.0");
    expect(data.listing.status).toBe("active");
  });

  test("republish with higher version succeeds", async () => {
    const freshConfig = await createAgentConfig({
      name: "Republish Route Agent",
      description: "For republish test",
      prompt: "Prompt for republish.",
      capabilities: ["llm"],
      category: "Creative",
      userId: AUTHOR.id,
    });

    // Initial publish
    const event1 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: freshConfig.id },
      user: AUTHOR,
    });
    await publishPOST(event1);

    // Republish with higher version
    const event2 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: freshConfig.id, version: "2.0.0", changelog: "Major update" },
      user: AUTHOR,
    });
    const res = await publishPOST(event2);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.version.version).toBe("2.0.0");
  });

  test("republish with same or lower version fails", async () => {
    // Reuse "Route Test Agent" already at 1.0.0
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId, version: "0.9.0" },
      user: AUTHOR,
    });
    const res = await publishPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("must be higher");
  });
});

// ── GET /api/marketplace/[id] (Detail) ──────────────────────────────

describe("GET /api/marketplace/[id]", () => {
  let listingId: string;

  beforeAll(async () => {
    // Get the listing ID from browse
    const browseEvent = createMockEvent({ url: "http://localhost/api/marketplace" });
    const browseRes = await browseGET(browseEvent);
    const browseData = await jsonFromResponse(browseRes);
    listingId = browseData.listings[0].id;
  });

  test("detail is public (works without auth)", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${listingId}`,
      params: { id: listingId },
    });
    const res = await detailGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.listing).toBeDefined();
    expect(data.listing.id).toBe(listingId);
    expect(data.versions).toBeInstanceOf(Array);
    expect(data.userRating).toBeNull(); // No auth => no user rating
    expect(typeof data.installed).toBe("boolean");
  });

  test("detail with authenticated user includes userRating", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${listingId}`,
      params: { id: listingId },
      user: AUTHOR,
    });
    const res = await detailGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.listing).toBeDefined();
    // userRating will be null since AUTHOR hasn't rated, but it should be present
    expect("userRating" in data).toBe(true);
  });

  test("detail includes ratingPercent", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${listingId}`,
      params: { id: listingId },
    });
    const res = await detailGET(event);
    const data = await jsonFromResponse(res);
    expect(typeof data.listing.ratingPercent).toBe("number");
  });

  test("detail returns 404 for non-existent listing", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${crypto.randomUUID()}`,
      params: { id: crypto.randomUUID() },
    });
    const res = await detailGET(event);
    expect(res.status).toBe(404);
  });
});

// ── DELETE /api/marketplace/[id] (Admin Remove) ─────────────────────

describe("DELETE /api/marketplace/[id]", () => {
  let removableListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Removable Agent",
      description: "Will be removed by admin",
      prompt: "Removable prompt.",
      capabilities: ["llm"],
      category: "Other",
      userId: AUTHOR.id,
    });
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    const pubData = await jsonFromResponse(pubRes);
    removableListingId = pubData.listing.id;
  });

  test("non-admin cannot delete listing", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${removableListingId}`,
      params: { id: removableListingId },
      user: AUTHOR,
    });
    expect(() => removeDELETE(event)).toThrow();
  });

  test("admin can delete listing", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: `http://localhost/api/marketplace/${removableListingId}`,
      params: { id: removableListingId },
      user: ADMIN,
    });
    const res = await removeDELETE(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("deleted listing returns 404 on detail", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${removableListingId}`,
      params: { id: removableListingId },
    });
    const res = await detailGET(event);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/marketplace/[id]/install ──────────────────────────────

describe("POST /api/marketplace/[id]/install", () => {
  let installListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Install Route Agent",
      description: "Agent for install route test",
      prompt: "Install route prompt.",
      capabilities: ["llm"],
      category: "Productivity",
      userId: AUTHOR.id,
    });
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    const pubData = await jsonFromResponse(pubRes);
    installListingId = pubData.listing.id;
  });

  test("install requires authentication", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${installListingId}/install`,
      params: { id: installListingId },
      body: {},
    });
    expect(() => installPOST(event)).toThrow();
  });

  test("install creates local agent config owned by installer", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${installListingId}/install`,
      params: { id: installListingId },
      body: {},
      user: INSTALLER,
    });
    const res = await installPOST(event);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.agentConfig).toBeDefined();
    expect(data.agentConfig.userId).toBe(INSTALLER.id);
    expect(data.agentConfig.prompt).toBe("Install route prompt.");
    expect(data.extensionsNeeded).toBeInstanceOf(Array);
  });

  test("install returns 404 for non-existent listing", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${crypto.randomUUID()}/install`,
      params: { id: crypto.randomUUID() },
      body: {},
      user: INSTALLER,
    });
    const res = await installPOST(event);
    expect(res.status).toBe(404);
  });

  test("install with specific version works", async () => {
    // Create a separate listing to avoid name collision with prior install
    const vConfig = await createAgentConfig({
      name: "Version Install Agent",
      description: "For version-specific install",
      prompt: "Version install prompt.",
      capabilities: ["llm"],
      category: "Other",
      userId: AUTHOR.id,
    });
    const vPubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: vConfig.id },
      user: AUTHOR,
    });
    const vPubRes = await publishPOST(vPubEvent);
    const vPubData = await jsonFromResponse(vPubRes);

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${vPubData.listing.id}/install`,
      params: { id: vPubData.listing.id },
      body: { version: "1.0.0" },
      user: ADMIN,
    });
    const res = await installPOST(event);
    expect(res.status).toBe(201);
  });

  test("install with non-existent version returns 404", async () => {
    // Create another user to avoid name collision
    const otherUserId = crypto.randomUUID();
    await getDb().insert(users).values({
      id: otherUserId, email: `install-v-test@route.test`, passwordHash: "h", name: "V Tester", role: "member",
    });

    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${installListingId}/install`,
      params: { id: installListingId },
      body: { version: "99.99.99" },
      user: { id: otherUserId, email: "install-v-test@route.test", name: "V Tester", role: "member" },
    });
    const res = await installPOST(event);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/marketplace/[id]/rate ─────────────────────────────────

describe("POST /api/marketplace/[id]/rate", () => {
  let rateListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Rate Route Agent",
      description: "Agent for rate route test",
      prompt: "Rate route prompt.",
      capabilities: ["llm"],
      category: "Education",
      userId: AUTHOR.id,
    });
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    const pubData = await jsonFromResponse(pubRes);
    rateListingId = pubData.listing.id;
  });

  test("rate requires authentication", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${rateListingId}/rate`,
      params: { id: rateListingId },
      body: { thumbsUp: true },
    });
    expect(() => ratePOST(event)).toThrow();
  });

  test("rate requires boolean thumbsUp", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${rateListingId}/rate`,
      params: { id: rateListingId },
      body: { thumbsUp: "yes" },
      user: INSTALLER,
    });
    const res = await ratePOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("boolean");
  });

  test("rate thumbsUp=true returns ok", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${rateListingId}/rate`,
      params: { id: rateListingId },
      body: { thumbsUp: true },
      user: INSTALLER,
    });
    const res = await ratePOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("rating updates listing detail", async () => {
    const detailEvent = createMockEvent({
      url: `http://localhost/api/marketplace/${rateListingId}`,
      params: { id: rateListingId },
      user: INSTALLER,
    });
    const res = await detailGET(detailEvent);
    const data = await jsonFromResponse(res);
    expect(data.listing.ratingTotal).toBeGreaterThanOrEqual(1);
    expect(data.userRating).toBeDefined();
    expect(data.userRating.thumbsUp).toBe(true);
  });

  test("rate thumbsUp=false updates rating", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${rateListingId}/rate`,
      params: { id: rateListingId },
      body: { thumbsUp: false },
      user: INSTALLER,
    });
    const res = await ratePOST(event);
    expect(res.status).toBe(200);

    // Verify the rating changed
    const detailEvent = createMockEvent({
      url: `http://localhost/api/marketplace/${rateListingId}`,
      params: { id: rateListingId },
      user: INSTALLER,
    });
    const detailRes = await detailGET(detailEvent);
    const detailData = await jsonFromResponse(detailRes);
    expect(detailData.userRating.thumbsUp).toBe(false);
  });
});

// ── POST /api/marketplace/[id]/flag ─────────────────────────────────

describe("POST /api/marketplace/[id]/flag", () => {
  let flagListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Flag Route Agent",
      description: "Agent for flag route test",
      prompt: "Flag route prompt.",
      capabilities: ["llm"],
      category: "Communication",
      userId: AUTHOR.id,
    });
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    const pubData = await jsonFromResponse(pubRes);
    flagListingId = pubData.listing.id;
  });

  test("flag requires authentication", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "Spam" },
    });
    expect(() => flagPOST(event)).toThrow();
  });

  test("flag requires non-empty reason string", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "" },
      user: INSTALLER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("reason");
  });

  test("flag with missing reason returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: {},
      user: INSTALLER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(400);
  });

  test("flag with valid reason returns ok", async () => {
    const event = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${flagListingId}/flag`,
      params: { id: flagListingId },
      body: { reason: "Inappropriate content" },
      user: INSTALLER,
    });
    const res = await flagPOST(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.ok).toBe(true);
  });

  test("flagged listing hidden from browse but visible on detail", async () => {
    // Browse should not contain the flagged listing
    const browseEvent = createMockEvent({ url: "http://localhost/api/marketplace" });
    const browseRes = await browseGET(browseEvent);
    const browseData = await jsonFromResponse(browseRes);
    const found = browseData.listings.find((l: any) => l.id === flagListingId);
    expect(found).toBeUndefined();

    // Detail should still work (for author notification)
    const detailEvent = createMockEvent({
      url: `http://localhost/api/marketplace/${flagListingId}`,
      params: { id: flagListingId },
    });
    const detailRes = await detailGET(detailEvent);
    expect(detailRes.status).toBe(200);
    const detailData = await jsonFromResponse(detailRes);
    expect(detailData.listing.status).toBe("flagged");
  });
});

// ── GET /api/marketplace/[id]/versions ──────────────────────────────

describe("GET /api/marketplace/[id]/versions", () => {
  let versionsListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Versions Route Agent",
      description: "Agent for versions route test",
      prompt: "Versions prompt.",
      capabilities: ["llm"],
      category: "Development",
      userId: AUTHOR.id,
    });
    // Publish v1 then v2
    const pub1 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id, version: "1.0.0" },
      user: AUTHOR,
    });
    const pub1Res = await publishPOST(pub1);
    const pub1Data = await jsonFromResponse(pub1Res);
    versionsListingId = pub1Data.listing.id;

    const pub2 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id, version: "2.0.0", changelog: "V2 update" },
      user: AUTHOR,
    });
    await publishPOST(pub2);
  });

  test("versions requires authentication", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${versionsListingId}/versions`,
      params: { id: versionsListingId },
    });
    expect(() => versionsGET(event)).toThrow();
  });

  test("versions returns all versions for listing", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/${versionsListingId}/versions`,
      params: { id: versionsListingId },
      user: AUTHOR,
    });
    const res = await versionsGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.length).toBe(2);
    const versionStrings = data.map((v: any) => v.version).sort();
    expect(versionStrings).toEqual(["1.0.0", "2.0.0"]);
  });
});

// ── GET /api/marketplace/export/[id] ────────────────────────────────

describe("GET /api/marketplace/export/[id]", () => {
  let exportListingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Export Route Agent",
      description: "Agent for export test",
      prompt: "Export prompt.",
      capabilities: ["llm"],
      category: "Research",
      userId: AUTHOR.id,
    });
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    const pubData = await jsonFromResponse(pubRes);
    exportListingId = pubData.listing.id;
  });

  test("export requires authentication", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/export/${exportListingId}`,
      params: { id: exportListingId },
    });
    expect(() => exportGET(event)).toThrow();
  });

  test("export returns JSON manifest with Content-Disposition header", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/export/${exportListingId}`,
      params: { id: exportListingId },
      user: AUTHOR,
    });
    const res = await exportGET(event);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain(".json");

    const manifest = await res.json();
    expect(manifest.schemaVersion).toBe(2);
    // The publish route slugifies manifest.name for filesystem-safety
    // (data/extensions/<name>). Display name lives on the listing row.
    expect(manifest.name).toBe("export-route-agent");
    expect(manifest.exportedAt).toBeDefined();
  });

  test("export returns 404 for non-existent listing", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/export/${crypto.randomUUID()}`,
      params: { id: crypto.randomUUID() },
      user: AUTHOR,
    });
    const res = await exportGET(event);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/marketplace/import ────────────────────────────────────

describe("POST /api/marketplace/import", () => {
  // manifest.name must match /^[a-z0-9][a-z0-9-_.]{0,63}$/ per
  // validateManifestV2 (filesystem-safe, no spaces/caps). The display
  // name used in agent configs is derived from this slug on import.
  const validManifest = {
    schemaVersion: 2,
    name: "imported-via-route",
    description: "Agent imported via route test",
    version: "1.0.0",
    author: { name: "External Author" },
    agent: {
      prompt: "You are an imported agent.",
      category: "Other",
    },
    permissions: {},
    tags: ["imported"],
  };

  test("import requires authentication", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: validManifest,
    });
    expect(() => importPOST(event)).toThrow();
  });

  test("import with valid manifest creates local agent", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: validManifest,
      user: INSTALLER,
    });
    const res = await importPOST(event);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.agentConfig).toBeDefined();
    expect(data.agentConfig.userId).toBe(INSTALLER.id);
    expect(data.agentConfig.prompt).toBe("You are an imported agent.");
    expect(data.extensionsNeeded).toBeInstanceOf(Array);
  });

  test("import with invalid manifest returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: { schemaVersion: 2, name: "" },
      user: INSTALLER,
    });
    const res = await importPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toBe("Validation failed");
    expect(data.fields).toBeDefined();
  });

  test("import extension-only type returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: {
        schemaVersion: 2,
        // slug-form name so validateManifestV2 passes; the 400 we want
        // is from the "must include agent component" branch, not from
        // name-regex validation.
        name: "some-extension",
        description: "An extension",
        version: "1.0.0",
        author: { name: "Someone" },
        tools: [{ name: "t", description: "d", inputSchema: {} }],
        entrypoint: "./index.ts",
        permissions: {},
        tags: [],
      },
      user: INSTALLER,
    });
    const res = await importPOST(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toContain("agent component");
  });

  test("import with name collision adds (Imported) suffix", async () => {
    // Import again with same slug — should get "(Imported)" suffix since
    // "imported-via-route" already exists from the prior test.
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: validManifest,
      user: ADMIN, // Different user
    });
    const res = await importPOST(event);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.agentConfig.name).toBe("imported-via-route (Imported)");
  });
});

// ── GET /api/marketplace/updates ────────────────────────────────────

describe("GET /api/marketplace/updates", () => {
  test("updates requires authentication", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/updates?ids=abc",
    });
    expect(() => updatesGET(event)).toThrow();
  });

  test("updates with no ids param returns empty object", async () => {
    const event = createMockEvent({
      url: "http://localhost/api/marketplace/updates",
      user: INSTALLER,
    });
    const res = await updatesGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data).toEqual({});
  });

  test("updates with non-installed ids returns empty object", async () => {
    const event = createMockEvent({
      url: `http://localhost/api/marketplace/updates?ids=${crypto.randomUUID()},${crypto.randomUUID()}`,
      user: INSTALLER,
    });
    const res = await updatesGET(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data).toEqual({});
  });

  test("updates detects available update for installed agent", async () => {
    // Setup: create agent, publish v1, install, then publish v2
    const config = await createAgentConfig({
      name: "Update Check Agent",
      description: "For update check test",
      prompt: "Update check prompt.",
      capabilities: ["llm"],
      category: "Productivity",
      userId: AUTHOR.id,
    });

    // Publish v1
    const pub1 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id, version: "1.0.0" },
      user: AUTHOR,
    });
    await publishPOST(pub1);

    // Install as INSTALLER
    const browseEvent = createMockEvent({ url: "http://localhost/api/marketplace?q=Update+Check+Agent" });
    const browseRes = await browseGET(browseEvent);
    const browseData = await jsonFromResponse(browseRes);
    const listingId = browseData.listings.find((l: any) => l.name === "Update Check Agent")?.id;

    const installEvent = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/install`,
      params: { id: listingId },
      body: {},
      user: INSTALLER,
    });
    const installRes = await installPOST(installEvent);
    const installData = await jsonFromResponse(installRes);
    const installedConfigId = installData.agentConfig.id;

    // Publish v2
    const pub2 = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id, version: "2.0.0" },
      user: AUTHOR,
    });
    await publishPOST(pub2);

    // Check for updates
    const updateEvent = createMockEvent({
      url: `http://localhost/api/marketplace/updates?ids=${installedConfigId}`,
      user: INSTALLER,
    });
    const updateRes = await updatesGET(updateEvent);
    expect(updateRes.status).toBe(200);
    const updateData = await jsonFromResponse(updateRes);
    expect(updateData[installedConfigId]).toBeDefined();
    expect(updateData[installedConfigId].hasUpdate).toBe(true);
    expect(updateData[installedConfigId].currentVersion).toBe("1.0.0");
    expect(updateData[installedConfigId].latestVersion).toBe("2.0.0");
    expect(updateData[installedConfigId].listingId).toBe(listingId);
  });
});

// ── Full E2E Flow Through Routes ────────────────────────────────────

describe("full e2e flow through HTTP routes", () => {
  test("publish -> browse -> detail -> install -> rate -> flag -> export -> import", async () => {
    // 1. Create agent config
    const config = await createAgentConfig({
      name: "E2E Route Flow Agent",
      description: "Complete flow test",
      prompt: "E2E route flow prompt.",
      capabilities: ["llm", "shell"],
      category: "Data & Analysis",
      userId: AUTHOR.id,
    });

    // 2. Publish
    const pubEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace",
      body: { agentConfigId: config.id, tags: ["e2e", "flow"] },
      user: AUTHOR,
    });
    const pubRes = await publishPOST(pubEvent);
    expect(pubRes.status).toBe(201);
    const { listing, version } = await jsonFromResponse(pubRes);
    const listingId = listing.id;
    expect(version.version).toBe("1.0.0");

    // 3. Browse - should find it
    const browseEvent = createMockEvent({ url: "http://localhost/api/marketplace?q=E2E+Route+Flow" });
    const browseRes = await browseGET(browseEvent);
    const browseData = await jsonFromResponse(browseRes);
    expect(browseData.listings.some((l: any) => l.id === listingId)).toBe(true);

    // 4. Detail
    const detailEvent = createMockEvent({
      url: `http://localhost/api/marketplace/${listingId}`,
      params: { id: listingId },
      user: INSTALLER,
    });
    const detailRes = await detailGET(detailEvent);
    const detailData = await jsonFromResponse(detailRes);
    expect(detailData.listing.name).toBe("E2E Route Flow Agent");
    expect(detailData.listing.category).toBe("Data & Analysis");

    // 5. Install
    const installEvent = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/install`,
      params: { id: listingId },
      body: {},
      user: INSTALLER,
    });
    const installRes = await installPOST(installEvent);
    expect(installRes.status).toBe(201);
    const installData = await jsonFromResponse(installRes);
    expect(installData.agentConfig.prompt).toBe("E2E route flow prompt.");

    // 6. Rate
    const rateEvent = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/rate`,
      params: { id: listingId },
      body: { thumbsUp: true },
      user: INSTALLER,
    });
    const rateRes = await ratePOST(rateEvent);
    expect(rateRes.status).toBe(200);

    // 7. Verify rating on detail
    const detail2Event = createMockEvent({
      url: `http://localhost/api/marketplace/${listingId}`,
      params: { id: listingId },
      user: INSTALLER,
    });
    const detail2Res = await detailGET(detail2Event);
    const detail2Data = await jsonFromResponse(detail2Res);
    expect(detail2Data.listing.ratingPositive).toBe(1);
    expect(detail2Data.userRating.thumbsUp).toBe(true);

    // 8. Flag
    const flagEvent = createMockEvent({
      method: "POST",
      url: `http://localhost/api/marketplace/${listingId}/flag`,
      params: { id: listingId },
      body: { reason: "Test flag for e2e" },
      user: ADMIN,
    });
    const flagRes = await flagPOST(flagEvent);
    expect(flagRes.status).toBe(200);

    // 9. Verify flagged listing hidden from browse
    const browse2Event = createMockEvent({ url: "http://localhost/api/marketplace?q=E2E+Route+Flow" });
    const browse2Res = await browseGET(browse2Event);
    const browse2Data = await jsonFromResponse(browse2Res);
    expect(browse2Data.listings.some((l: any) => l.id === listingId)).toBe(false);

    // 10. Export (still accessible to author)
    const exportEvent = createMockEvent({
      url: `http://localhost/api/marketplace/export/${listingId}`,
      params: { id: listingId },
      user: AUTHOR,
    });
    const exportRes = await exportGET(exportEvent);
    expect(exportRes.status).toBe(200);
    const manifest = await exportRes.json();
    // manifest.name is the filesystem-safe slug (publish route slugifies).
    expect(manifest.name).toBe("e2e-route-flow-agent");
    expect(manifest.exportedAt).toBeDefined();

    // 11. Import the exported manifest
    const importEvent = createMockEvent({
      method: "POST",
      url: "http://localhost/api/marketplace/import",
      body: manifest,
      user: INSTALLER,
    });
    const importRes = await importPOST(importEvent);
    expect(importRes.status).toBe(201);
    const importData = await jsonFromResponse(importRes);
    // Name collision resolved — manifest.name is the slug, so the
    // imported config name is derived from the slug.
    expect(importData.agentConfig.name).toContain("e2e-route-flow-agent");
    expect(importData.agentConfig.prompt).toBe("E2E route flow prompt.");
  });
});
