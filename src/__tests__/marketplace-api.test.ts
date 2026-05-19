import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createListing, browseMarketplace, getListingById, incrementInstallCount } from "../db/queries/marketplace";
import { createVersion, getLatestVersion, listVersions } from "../db/queries/marketplace-versions";
import { upsertRating, getUserRating, createFlag } from "../db/queries/marketplace-ratings";
import { createAgentConfig } from "../db/queries/agent-configs";
import { upsertSetting, getSetting } from "../db/queries/settings";
import { validateManifestV2, compareVersions, generateSlug } from "../extensions/manifest";
import type { ExtensionManifestV2 } from "../extensions/types";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

function buildV2Manifest(config: { name: string; description: string; prompt: string; capabilities?: string[]; category?: string | null }, author: { name: string; id: string }, version: string): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    // Mirror the production publish route (web/src/routes/api/marketplace/+server.ts):
    // manifest.name must be filesystem-safe, so slugify the display name.
    name: generateSlug(config.name),
    version,
    description: config.description,
    author,
    agent: {
      prompt: config.prompt,
      category: config.category ?? "Other",
      capabilities: config.capabilities ?? ["llm"],
    },
    permissions: {},
    tags: [],
  };
}

let testUserId: string;
let testUser2Id: string;

beforeAll(async () => {
  await setupTestDb();

  testUserId = crypto.randomUUID();
  testUser2Id = crypto.randomUUID();

  await getDb().insert(users).values([
    { id: testUserId, email: "api-test@example.com", passwordHash: "hashed", name: "API Tester", role: "member" },
    { id: testUser2Id, email: "api-test2@example.com", passwordHash: "hashed", name: "API Tester 2", role: "member" },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

// ── Publish Flow ─────────────────────────────────────────────────

describe("publish", () => {
  test("publish with valid agentConfig creates listing + version 1.0.0", async () => {
    const config = await createAgentConfig({
      name: "Publish Test Agent",
      description: "Test agent for publish",
      prompt: "You are helpful.",
      capabilities: ["llm"],
      category: "Productivity",
      userId: testUserId,
    });

    const manifest = buildV2Manifest(config, { name: "API Tester", id: testUserId }, "1.0.0");
    const validation = validateManifestV2(manifest);
    expect(validation.valid).toBe(true);

    const listing = await createListing({
      authorId: testUserId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: config.category ?? "Other",
      tags: ["test"],
      latestVersion: "1.0.0",
    });

    const version = await createVersion(listing.id, "1.0.0", manifest);
    expect(listing.id).toBeDefined();
    expect(listing.status).toBe("active");
    expect(version.version).toBe("1.0.0");
  });

  test("publish with invalid manifest returns errors", () => {
    const result = validateManifestV2({ schemaVersion: 2, name: "" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("republish with higher version creates new version entry", async () => {
    const config = await createAgentConfig({
      name: "Republish Agent",
      description: "Test republish",
      prompt: "You are helpful v2.",
      capabilities: ["llm"],
      category: "Development",
      userId: testUserId,
    });

    const listing = await createListing({
      authorId: testUserId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Development",
      tags: [],
      latestVersion: "1.0.0",
    });

    const m1 = buildV2Manifest(config, { name: "API Tester", id: testUserId }, "1.0.0");
    await createVersion(listing.id, "1.0.0", m1);

    // Republish with higher version
    const m2 = buildV2Manifest(config, { name: "API Tester", id: testUserId }, "2.0.0");
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);

    const v2 = await createVersion(listing.id, "2.0.0", m2, "Major update");
    expect(v2.version).toBe("2.0.0");

    const versions = await listVersions(listing.id);
    expect(versions.length).toBe(2);
    const versionStrings = versions.map((v) => v.version).sort();
    expect(versionStrings).toEqual(["1.0.0", "2.0.0"]);
  });
});

// ── Browse/Search ────────────────────────────────────────────────

describe("browse", () => {
  test("GET browse returns active listings sorted by popular", async () => {
    const results = await browseMarketplace({ sort: "popular" });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.status).toBe("active");
    }
  });

  test("GET browse with category filter returns matching listings", async () => {
    const results = await browseMarketplace({ category: "Development" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.category).toBe("Development");
    }
  });

  test("GET browse with search query returns matching listings", async () => {
    const results = await browseMarketplace({ query: "Republish" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.name.includes("Republish"))).toBe(true);
  });
});

// ── Install ──────────────────────────────────────────────────────

describe("install", () => {
  let listingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Installable Agent",
      description: "Can be installed",
      prompt: "You are installable.",
      capabilities: ["llm"],
      category: "Productivity",
      userId: testUserId,
    });

    const listing = await createListing({
      authorId: testUserId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Productivity",
      tags: ["install-test"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;

    const manifest = buildV2Manifest(config, { name: "API Tester", id: testUserId }, "1.0.0");
    await createVersion(listing.id, "1.0.0", manifest);
  });

  test("install creates local agentConfig copy owned by installer", async () => {
    const listing = await getListingById(listingId);
    expect(listing).toBeDefined();

    const latestVer = await getLatestVersion(listingId);
    expect(latestVer).toBeDefined();

    const manifest = latestVer!.manifest as ExtensionManifestV2;
    expect(manifest.agent).toBeDefined();

    // Create a local copy for the installing user (with suffix to avoid name collision)
    const localConfig = await createAgentConfig({
      name: `${manifest.name} (Marketplace)`,
      description: manifest.description,
      prompt: manifest.agent!.prompt,
      capabilities: manifest.agent!.capabilities as any,
      category: manifest.agent!.category,
      temperature: manifest.agent!.temperature,
      maxTokens: manifest.agent!.maxTokens,
      userId: testUser2Id, // installed by different user
    });

    expect(localConfig.userId).toBe(testUser2Id);
    expect(localConfig.prompt).toBe("You are installable.");
  });

  test("install increments install count", async () => {
    const before = await getListingById(listingId);
    const beforeCount = before!.installCount;

    await incrementInstallCount(listingId);

    const after = await getListingById(listingId);
    expect(after!.installCount).toBe(beforeCount + 1);
  });

  test("install stores marketplace:installed setting for tracking", async () => {
    const agentConfigId = "installed-config-id";
    await upsertSetting(`marketplace:installed:${agentConfigId}`, {
      listingId,
      version: "1.0.0",
      installedAt: new Date().toISOString(),
    });

    const setting = await getSetting(`marketplace:installed:${agentConfigId}`);
    expect(setting).toBeDefined();
    expect((setting as any).listingId).toBe(listingId);
  });
});

// ── Rate ─────────────────────────────────────────────────────────

describe("rate", () => {
  let listingId: string;

  beforeAll(async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Ratable Agent",
      description: "For rating API tests",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
  });

  test("rate with thumbsUp=true updates listing ratingPositive", async () => {
    await upsertRating(listingId, testUserId, true);

    const listing = await getListingById(listingId);
    expect(listing!.ratingPositive).toBe(1);
    expect(listing!.ratingTotal).toBe(1);
  });

  test("rate twice from same user updates (not duplicates) the rating", async () => {
    // Already rated thumbsUp=true above, now change to false
    await upsertRating(listingId, testUserId, false);

    const listing = await getListingById(listingId);
    expect(listing!.ratingPositive).toBe(0);
    expect(listing!.ratingTotal).toBe(1); // still 1 total, not 2

    const userRating = await getUserRating(listingId, testUserId);
    expect(userRating).toBeDefined();
    expect(userRating!.thumbsUp).toBe(false);
  });
});

// ── Flag ─────────────────────────────────────────────────────────

describe("flag", () => {
  test("flag sets listing status to flagged", async () => {
    const listing = await createListing({
      authorId: testUserId,
      name: "Flaggable API Agent",
      description: "For flag API tests",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });

    await createFlag(listing.id, testUser2Id, "Spam content");

    const flagged = await getListingById(listing.id);
    expect(flagged!.status).toBe("flagged");
  });
});

// ── Export/Import ────────────────────────────────────────────────

describe("export/import", () => {
  let listingId: string;
  let exportedManifest: ExtensionManifestV2;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "Exportable Agent",
      description: "Can be exported",
      prompt: "You are exportable.",
      capabilities: ["llm"],
      category: "Creative",
      userId: testUserId,
    });

    const listing = await createListing({
      authorId: testUserId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Creative",
      tags: ["export-test"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;

    const manifest = buildV2Manifest(config, { name: "API Tester", id: testUserId }, "1.0.0");
    await createVersion(listing.id, "1.0.0", manifest);
    exportedManifest = manifest;
  });

  test("export returns downloadable JSON manifest", async () => {
    const latestVer = await getLatestVersion(listingId);
    expect(latestVer).toBeDefined();

    const manifest = latestVer!.manifest as ExtensionManifestV2 & { exportedAt?: string };
    manifest.exportedAt = new Date().toISOString();

    // Simulate export -- the endpoint returns this as JSON with Content-Disposition
    const exportJson = JSON.stringify(manifest, null, 2);
    expect(exportJson).toContain('"schemaVersion":');
    expect(exportJson).toContain('"exportedAt":');
    expect(manifest.name).toBe("exportable-agent");
  });

  test("import with valid manifest JSON creates local agent", async () => {
    const importManifest = { ...exportedManifest, exportedAt: new Date().toISOString() };

    const validation = validateManifestV2(importManifest);
    expect(validation.valid).toBe(true);

    // Create local agent from manifest (with suffix to avoid name collision)
    const localConfig = await createAgentConfig({
      name: `${importManifest.name} (Imported)`,
      description: importManifest.description,
      prompt: importManifest.agent!.prompt,
      capabilities: importManifest.agent!.capabilities as any,
      category: importManifest.agent!.category,
      userId: testUser2Id,
    });

    // Store import tracking
    await upsertSetting(`marketplace:imported:${localConfig.id}`, {
      source: "import",
      importedAt: new Date().toISOString(),
    });

    // importManifest.name is the slugified form.
    expect(localConfig.name).toBe("exportable-agent (Imported)");
    expect(localConfig.userId).toBe(testUser2Id);

    const tracking = await getSetting(`marketplace:imported:${localConfig.id}`);
    expect(tracking).toBeDefined();
  });
});
