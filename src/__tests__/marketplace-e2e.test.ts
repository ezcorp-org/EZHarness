import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { validateManifestV2, compareVersions, generateSlug } from "../extensions/manifest";
import type { ExtensionManifestV2 } from "../extensions/types";
import { createListing, getListingById, getListingBySlug, browseMarketplace, incrementInstallCount, getListingsByAuthor, getFeaturedListings } from "../db/queries/marketplace";
import { createVersion, getLatestVersion, getVersion, listVersions } from "../db/queries/marketplace-versions";
import { upsertRating, getUserRating, createFlag, resolveFlag, listFlags } from "../db/queries/marketplace-ratings";
import { createAgentConfig, getAgentConfig, getAgentConfigByName } from "../db/queries/agent-configs";
import { upsertSetting, getSetting } from "../db/queries/settings";
import { getDb } from "../db/connection";
import { users, marketplaceListings } from "../db/schema";
import { eq } from "drizzle-orm";

function buildV2Manifest(config: { name: string; description: string; prompt: string; capabilities?: string[] | null; category?: string | null }, author: { name: string; id: string }, version: string): ExtensionManifestV2 {
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

let authorId: string;
let installerId: string;
let adminId: string;

beforeAll(async () => {
  await setupTestDb();
  authorId = crypto.randomUUID();
  installerId = crypto.randomUUID();
  adminId = crypto.randomUUID();
  await getDb().insert(users).values([
    { id: authorId, email: "author@e2e.com", passwordHash: "h", name: "Author", role: "member" },
    { id: installerId, email: "installer@e2e.com", passwordHash: "h", name: "Installer", role: "member" },
    { id: adminId, email: "admin@e2e.com", passwordHash: "h", name: "Admin", role: "admin" },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

// ── 1. Complete publish → browse → install → rate lifecycle ─────────

describe("complete publish → browse → install → rate lifecycle", () => {
  let listingId: string;
  let agentConfigId: string;

  test("author creates an agent config", async () => {
    const config = await createAgentConfig({
      name: "E2E Lifecycle Agent",
      description: "An agent for lifecycle testing",
      prompt: "You are a helpful lifecycle test agent.",
      capabilities: ["llm"],
      category: "Productivity",
      userId: authorId,
    });
    agentConfigId = config.id;
    expect(config.name).toBe("E2E Lifecycle Agent");
    expect(config.category).toBe("Productivity");
  });

  test("author generates and validates manifest", async () => {
    const config = (await getAgentConfig(agentConfigId))!;
    expect(config).toBeDefined();

    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.agent).toBeDefined();
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.agent!.prompt).toBe("You are a helpful lifecycle test agent.");

    const { valid, errors } = validateManifestV2(manifest);
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  test("author publishes to marketplace", async () => {
    const config = (await getAgentConfig(agentConfigId))!;
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");

    const listing = await createListing({
      authorId,
      agentConfigId,
      name: config.name,
      description: config.description,
      category: config.category ?? "Other",
      tags: ["lifecycle", "test"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
    expect(listing.slug).toBe("e2e-lifecycle-agent");
    expect(listing.status).toBe("active");

    const version = await createVersion(listingId, "1.0.0", manifest);
    expect(version.version).toBe("1.0.0");
    expect(version.listingId).toBe(listingId);
  });

  test("listing appears in browse results", async () => {
    const results = await browseMarketplace({});
    const found = results.find((r) => r.id === listingId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("E2E Lifecycle Agent");
  });

  test("listing retrieved by ID and by slug", async () => {
    const byId = await getListingById(listingId);
    expect(byId).toBeDefined();
    expect(byId!.name).toBe("E2E Lifecycle Agent");

    const bySlug = await getListingBySlug("e2e-lifecycle-agent");
    expect(bySlug).toBeDefined();
    expect(bySlug!.id).toBe(listingId);
  });

  test("second user installs the listing", async () => {
    const latestVer = await getLatestVersion(listingId);
    expect(latestVer).toBeDefined();
    const manifest = latestVer!.manifest as ExtensionManifestV2;

    // Check for name collision
    const existing = await getAgentConfigByName(manifest.name);
    const installName = existing ? `${manifest.name} (Marketplace)` : manifest.name;

    const installed = await createAgentConfig({
      name: installName,
      description: manifest.description,
      prompt: manifest.agent!.prompt,
      capabilities: manifest.agent!.capabilities,
      category: manifest.agent!.category,
      userId: installerId,
    });

    // manifest.name is slugified, so no collision with the display-named
    // agent config "E2E Lifecycle Agent" — installed uses the slug directly.
    expect(installed.name).toBe("e2e-lifecycle-agent");

    // Track installation
    await upsertSetting(`marketplace:installed:${installed.id}`, {
      listingId,
      version: latestVer!.version,
      installedAt: new Date().toISOString(),
    });
    const setting = await getSetting(`marketplace:installed:${installed.id}`);
    expect(setting).toBeDefined();
    expect((setting as any).listingId).toBe(listingId);

    await incrementInstallCount(listingId);
    const listing = (await getListingById(listingId))!;
    expect(listing.installCount).toBe(1);
  });

  test("second user rates thumbsUp=true", async () => {
    await upsertRating(listingId, installerId, true);
    const listing = (await getListingById(listingId))!;
    expect(listing.ratingTotal).toBe(1);
    expect(listing.ratingPositive).toBe(1);
  });

  test("second user changes rating to thumbsUp=false", async () => {
    await upsertRating(listingId, installerId, false);
    const listing = (await getListingById(listingId))!;
    expect(listing.ratingTotal).toBe(1);
    expect(listing.ratingPositive).toBe(0);
  });

  test("author publishes version 2.0.0", async () => {
    const config = (await getAgentConfig(agentConfigId))!;
    const currentListing = (await getListingById(listingId))!;
    expect(compareVersions("2.0.0", currentListing.latestVersion) > 0).toBe(true);

    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "2.0.0");
    manifest.agent!.prompt = "You are an improved lifecycle test agent v2.";
    const { valid } = validateManifestV2(manifest);
    expect(valid).toBe(true);

    await createVersion(listingId, "2.0.0", manifest);
    const updated = (await getListingById(listingId))!;
    expect(updated.latestVersion).toBe("2.0.0");
  });

  test("update detection: installed 1.0.0 vs latest 2.0.0", async () => {
    const installedVersion = "1.0.0";
    const latest = await getLatestVersion(listingId);
    expect(latest).toBeDefined();
    const hasUpdate = compareVersions(latest!.version, installedVersion) > 0;
    expect(hasUpdate).toBe(true);
  });
});

// ── 2. Flag → resolve → re-flag lifecycle ───────────────────────────

describe("flag → resolve → re-flag lifecycle", () => {
  let listingId: string;
  let flagId: string;

  test("create and publish a listing", async () => {
    const config = await createAgentConfig({
      name: "Flaggable Agent",
      description: "Agent that will be flagged",
      prompt: "You are a flaggable agent.",
      capabilities: ["llm"],
      category: "Development",
      userId: authorId,
    });
    const listing = await createListing({
      authorId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Development",
      tags: ["flagtest"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
    await createVersion(listingId, "1.0.0", manifest);
  });

  test("user flags listing with reason", async () => {
    const flag = await createFlag(listingId, installerId, "Inappropriate content");
    flagId = flag.id;
    expect(flag.reason).toBe("Inappropriate content");
    expect(flag.status).toBe("pending");
  });

  test("listing status becomes flagged", async () => {
    const listing = (await getListingById(listingId))!;
    expect(listing.status).toBe("flagged");
  });

  test("flagged listing no longer appears in browse", async () => {
    const results = await browseMarketplace({});
    const found = results.find((r) => r.id === listingId);
    expect(found).toBeUndefined();
  });

  test("admin resolves flag as dismissed → listing active", async () => {
    await resolveFlag(flagId, adminId, "dismissed");
    const listing = (await getListingById(listingId))!;
    expect(listing.status).toBe("active");
  });

  test("listing reappears in browse results", async () => {
    const results = await browseMarketplace({});
    const found = results.find((r) => r.id === listingId);
    expect(found).toBeDefined();
  });

  test("another user flags again → listing flagged again", async () => {
    const flag = await createFlag(listingId, adminId, "Spam content");
    expect(flag.status).toBe("pending");
    const listing = (await getListingById(listingId))!;
    expect(listing.status).toBe("flagged");
  });

  test("admin resolves as removed → listing removed", async () => {
    const flags = await listFlags({ listingId, status: "pending" });
    expect(flags.length).toBeGreaterThan(0);
    await resolveFlag(flags[0]!.id, adminId, "removed");

    const listing = await getListingById(listingId);
    expect(listing).toBeUndefined();
  });

  test("listFlags returns correct flags with status filters", async () => {
    const allFlags = await listFlags({ listingId });
    expect(allFlags.length).toBe(2);

    const dismissed = await listFlags({ listingId, status: "dismissed" });
    expect(dismissed.length).toBe(1);

    const removed = await listFlags({ listingId, status: "removed" });
    expect(removed.length).toBe(1);

    const pending = await listFlags({ listingId, status: "pending" });
    expect(pending.length).toBe(0);
  });
});

// ── 3. Export → import lifecycle ────────────────────────────────────

describe("export → import lifecycle", () => {
  let listingId: string;

  test("author publishes an agent to marketplace", async () => {
    const config = await createAgentConfig({
      name: "Exportable Agent",
      description: "Agent for export testing",
      prompt: "You are an exportable agent.",
      capabilities: ["llm", "shell"],
      category: "Research",
      userId: authorId,
    });
    const listing = await createListing({
      authorId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Research",
      tags: ["export"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
    await createVersion(listingId, "1.0.0", manifest);
  });

  test("export: serialize latest version as JSON with exportedAt", async () => {
    const latest = (await getLatestVersion(listingId))!;
    const manifest = latest.manifest as ExtensionManifestV2;
    const exported = { ...manifest, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(exported);

    const parsed = JSON.parse(json);
    expect(parsed.exportedAt).toBeDefined();
    // buildV2Manifest slugifies the display name (matches production publish).
    expect(parsed.name).toBe("exportable-agent");

    const { valid } = validateManifestV2(parsed);
    expect(valid).toBe(true);
  });

  test("import: parse JSON, validate, create local agent config", async () => {
    const latest = (await getLatestVersion(listingId))!;
    const manifest = latest.manifest as ExtensionManifestV2;
    const exported = { ...manifest, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(exported);

    const parsed = JSON.parse(json) as ExtensionManifestV2;
    const { valid } = validateManifestV2(parsed);
    expect(valid).toBe(true);

    // Create local agent with "(Imported)" suffix
    const importedConfig = await createAgentConfig({
      name: `${parsed.name} (Imported)`,
      description: parsed.description,
      prompt: parsed.agent!.prompt,
      capabilities: parsed.agent!.capabilities,
      category: parsed.agent!.category,
      userId: installerId,
    });

    await upsertSetting(`marketplace:imported:${importedConfig.id}`, {
      source: "export",
      importedAt: new Date().toISOString(),
    });

    // parsed.name is the slugified manifest name, not the display name.
    expect(importedConfig.name).toBe("exportable-agent (Imported)");
    expect(importedConfig.prompt).toBe("You are an exportable agent.");
    expect(importedConfig.capabilities).toEqual(["llm", "shell"]);
    expect(importedConfig.category).toBe("Research");

    const setting = await getSetting(`marketplace:imported:${importedConfig.id}`);
    expect(setting).toBeDefined();
    expect((setting as any).source).toBe("export");
  });

  test("import invalid manifest → validation fails", () => {
    const invalid = { schemaVersion: 2, name: "" };
    const { valid, errors } = validateManifestV2(invalid);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("import manifest without agent → cannot install as agent", () => {
    const extensionManifest = {
      schemaVersion: 2,
      name: "some-extension",
      description: "An extension",
      version: "1.0.0",
      author: { name: "Someone" },
      permissions: {},
    };
    const { valid } = validateManifestV2(extensionManifest);
    // Valid v2 manifest, but no agent component -- cannot be imported as an agent
    expect(valid).toBe(true);
    expect(extensionManifest).not.toHaveProperty("agent");
  });
});

// ── 4. Multi-author marketplace ─────────────────────────────────────

describe("multi-author marketplace", () => {
  const authorAListingIds: string[] = [];
  const authorBListingIds: string[] = [];

  test("Author A publishes 3 agents in different categories", async () => {
    const agents = [
      { name: "A-Productivity-Agent", category: "Productivity", description: "A prod agent" },
      { name: "A-Development-Agent", category: "Development", description: "A dev agent" },
      { name: "A-Writing-Agent", category: "Writing", description: "A writing agent" },
    ];
    for (const a of agents) {
      const config = await createAgentConfig({
        name: a.name,
        description: a.description,
        prompt: `Prompt for ${a.name}`,
        capabilities: ["llm"],
        category: a.category,
        userId: authorId,
      });
      const listing = await createListing({
        authorId,
        agentConfigId: config.id,
        name: a.name,
        description: a.description,
        category: a.category,
        tags: ["multi-author"],
        latestVersion: "1.0.0",
      });
      authorAListingIds.push(listing.id);
      const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
      await createVersion(listing.id, "1.0.0", manifest);
    }
    expect(authorAListingIds.length).toBe(3);
  });

  test("Author B publishes 2 agents", async () => {
    const agents = [
      { name: "B-Unique-SearchMe-Agent", category: "Creative", description: "B creative agent" },
      { name: "B-Education-Agent", category: "Education", description: "B education agent" },
    ];
    for (const a of agents) {
      const config = await createAgentConfig({
        name: a.name,
        description: a.description,
        prompt: `Prompt for ${a.name}`,
        capabilities: ["llm"],
        category: a.category,
        userId: installerId,
      });
      const listing = await createListing({
        authorId: installerId,
        agentConfigId: config.id,
        name: a.name,
        description: a.description,
        category: a.category,
        tags: ["multi-author"],
        latestVersion: "1.0.0",
      });
      authorBListingIds.push(listing.id);
      const manifest = buildV2Manifest(config, { name: "Installer", id: installerId }, "1.0.0");
      await createVersion(listing.id, "1.0.0", manifest);
    }
    expect(authorBListingIds.length).toBe(2);
  });

  test("browse by category returns only matching agents", async () => {
    const results = await browseMarketplace({ category: "Writing" });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("A-Writing-Agent");
  });

  test("browse with search query matching only B's agent name", async () => {
    const results = await browseMarketplace({ query: "SearchMe" });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("B-Unique-SearchMe-Agent");
  });

  test("getListingsByAuthor returns only correct author's listings", async () => {
    const authorAListings = await getListingsByAuthor(authorId);
    const authorBListings = await getListingsByAuthor(installerId);

    // Author A has all their listings (including ones from other tests)
    const authorAMulti = authorAListings.filter((l) => authorAListingIds.includes(l.id));
    expect(authorAMulti.length).toBe(3);

    const authorBMulti = authorBListings.filter((l) => authorBListingIds.includes(l.id));
    expect(authorBMulti.length).toBe(2);
  });

  test("featured listings show featured first", async () => {
    // Set one listing as featured via direct DB update
    await getDb()
      .update(marketplaceListings)
      .set({ featured: true })
      .where(eq(marketplaceListings.id, authorAListingIds[2]!));

    const featured = await getFeaturedListings(10);
    // Featured listing should come first
    const featuredIdx = featured.findIndex((l) => l.id === authorAListingIds[2]!);
    expect(featuredIdx).toBe(0);
  });

  test("pagination: limit=2, offset=0 vs offset=2", async () => {
    const page1 = await browseMarketplace({ sort: "newest", limit: 2, offset: 0 });
    const page2 = await browseMarketplace({ sort: "newest", limit: 2, offset: 2 });

    expect(page1.length).toBe(2);
    expect(page2.length).toBe(2);

    const page1Ids = new Set(page1.map((l) => l.id));
    const page2Ids = new Set(page2.map((l) => l.id));
    // No overlap between pages
    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  });
});

// ── 5. Version management lifecycle ─────────────────────────────────

describe("version management lifecycle", () => {
  let listingId: string;
  let agentConfigId: string;

  test("publish v1.0.0", async () => {
    const config = await createAgentConfig({
      name: "Versioned Agent",
      description: "Agent for version testing",
      prompt: "v1 prompt",
      capabilities: ["llm"],
      category: "Development",
      userId: authorId,
    });
    agentConfigId = config.id;

    const listing = await createListing({
      authorId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Development",
      tags: ["versioning"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;

    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
    await createVersion(listingId, "1.0.0", manifest);
  });

  test("publish v1.1.0 with changelog", async () => {
    const config = (await getAgentConfig(agentConfigId))!;
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.1.0");
    manifest.agent!.prompt = "v1.1 prompt with bug fixes";
    await createVersion(listingId, "1.1.0", manifest, "Bug fixes");
  });

  test("publish v2.0.0 with changelog", async () => {
    const config = (await getAgentConfig(agentConfigId))!;
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "2.0.0");
    manifest.agent!.prompt = "v2 major rewrite prompt";
    await createVersion(listingId, "2.0.0", manifest, "Major rewrite");
  });

  test("listVersions returns all 3 in reverse chronological order", async () => {
    const versions = await listVersions(listingId);
    expect(versions.length).toBe(3);
    // Reverse chronological: newest first
    expect(versions[0]!.version).toBe("2.0.0");
    expect(versions[1]!.version).toBe("1.1.0");
    expect(versions[2]!.version).toBe("1.0.0");
  });

  test("getVersion returns specific version with changelog", async () => {
    const v = await getVersion(listingId, "1.1.0");
    expect(v).toBeDefined();
    expect(v!.version).toBe("1.1.0");
    expect(v!.changelog).toBe("Bug fixes");
  });

  test("getLatestVersion returns v2.0.0", async () => {
    const latest = await getLatestVersion(listingId);
    expect(latest).toBeDefined();
    expect(latest!.version).toBe("2.0.0");
  });

  test("listing latestVersion field matches 2.0.0", async () => {
    const listing = (await getListingById(listingId))!;
    expect(listing.latestVersion).toBe("2.0.0");
  });

  test("install specific version (not latest)", async () => {
    const v1 = await getVersion(listingId, "1.0.0");
    expect(v1).toBeDefined();
    const manifest = v1!.manifest as ExtensionManifestV2;

    const installed = await createAgentConfig({
      name: `${manifest.name} (v1.0.0)`,
      description: manifest.description,
      prompt: manifest.agent!.prompt,
      capabilities: manifest.agent!.capabilities,
      category: manifest.agent!.category,
      userId: installerId,
    });

    // v1.0.0 prompt, not v2.0.0
    expect(installed.prompt).toBe("v1 prompt");
    expect(installed.prompt).not.toBe("v2 major rewrite prompt");
  });
});

// ── 6. Edge cases and error handling ────────────────────────────────

describe("edge cases and error handling", () => {
  test("generateSlug handles special characters, spaces, unicode", () => {
    expect(generateSlug("Hello World")).toBe("hello-world");
    expect(generateSlug("My Agent!@#$%")).toBe("my-agent");
    expect(generateSlug("  leading/trailing  ")).toBe("leading-trailing");
    expect(generateSlug("café résumé")).toBe("caf-r-sum");
    expect(generateSlug("UPPER CASE")).toBe("upper-case");
    expect(generateSlug("multiple---dashes")).toBe("multiple-dashes");
    expect(generateSlug("日本語テスト")).toBe("");
  });

  test("compareVersions with edge cases", () => {
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
    expect(compareVersions("0.0.1", "0.0.0")).toBe(1);
    expect(compareVersions("0.0.0", "0.0.1")).toBe(-1);
    expect(compareVersions("99.99.99", "99.99.98")).toBe(1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  test("browseMarketplace with all filters combined", async () => {
    const config = await createAgentConfig({
      name: "Edge Filter Agent",
      description: "Filterable agent for edge test",
      prompt: "Edge filter prompt",
      capabilities: ["llm"],
      category: "Creative",
      userId: authorId,
    });
    const listing = await createListing({
      authorId,
      name: config.name,
      description: config.description,
      category: "Creative",
      tags: ["edge-tag"],
      latestVersion: "1.0.0",
    });
    const manifest = buildV2Manifest(config, { name: "Author", id: authorId }, "1.0.0");
    await createVersion(listing.id, "1.0.0", manifest);

    const results = await browseMarketplace({
      query: "Edge Filter",
      category: "Creative",
      tag: "edge-tag",
      sort: "newest",
      limit: 10,
      offset: 0,
    });
    const found = results.find((r) => r.id === listing.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Edge Filter Agent");
  });

  test("install count increments are cumulative", async () => {
    const config = await createAgentConfig({
      name: "Install Count Agent",
      description: "Agent for install count testing",
      prompt: "Install count prompt",
      capabilities: ["llm"],
      category: "Other",
      userId: authorId,
    });
    const listing = await createListing({
      authorId,
      name: config.name,
      description: config.description,
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });

    for (let i = 0; i < 5; i++) {
      await incrementInstallCount(listing.id);
    }

    const updated = (await getListingById(listing.id))!;
    expect(updated.installCount).toBe(5);
  });

  test("ratings from 3 different users: verify counts", async () => {
    const config = await createAgentConfig({
      name: "Rating Count Agent",
      description: "Agent for rating count testing",
      prompt: "Rating count prompt",
      capabilities: ["llm"],
      category: "Other",
      userId: authorId,
    });
    const listing = await createListing({
      authorId,
      name: config.name,
      description: config.description,
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });

    await upsertRating(listing.id, authorId, true);
    await upsertRating(listing.id, installerId, true);
    await upsertRating(listing.id, adminId, false);

    const updated = (await getListingById(listing.id))!;
    expect(updated.ratingTotal).toBe(3);
    expect(updated.ratingPositive).toBe(2);
  });

  test("creating listing with same slug fails (unique constraint)", async () => {
    await createAgentConfig({
      name: "Duplicate Slug Test",
      description: "First one",
      prompt: "First prompt",
      capabilities: ["llm"],
      category: "Other",
      userId: authorId,
    });
    await createListing({
      authorId,
      name: "Duplicate Slug",
      description: "First listing",
      category: "Other",
      tags: [],
      latestVersion: "1.0.0",
    });

    // Same slug should cause unique constraint error
    await expect(
      createListing({
        authorId,
        name: "Duplicate Slug",
        description: "Second listing",
        category: "Other",
        tags: [],
        latestVersion: "1.0.0",
      }),
    ).rejects.toThrow();
  });

  test("getListingById with non-UUID string returns undefined", async () => {
    const result = await getListingById("not-a-valid-uuid");
    expect(result).toBeUndefined();
  });

  test("getUserRating for non-existent listing/user returns undefined", async () => {
    const result = await getUserRating(crypto.randomUUID(), crypto.randomUUID());
    expect(result).toBeUndefined();
  });
});
