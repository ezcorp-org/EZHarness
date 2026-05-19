import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createVersion,
  getVersion,
  getLatestVersion,
  listVersions,
} = await import("../db/queries/marketplace-versions");
const { createListing, getListingById } = await import("../db/queries/marketplace");
const { createUser } = await import("../db/queries/users");

const sampleManifest = {
  name: "demo-ext",
  version: "1.0.0",
  description: "demo manifest",
} as any;

async function seedListing() {
  const author = await createUser({
    email: `auth-${crypto.randomUUID()}@t.com`,
    passwordHash: "h",
    name: "Author",
  });
  return createListing({
    authorId: author.id,
    name: `listing-${crypto.randomUUID().slice(0, 6)}`,
    description: "desc",
    category: "tools",
    tags: [],
    latestVersion: "0.0.1",
  });
}

describe("marketplace-versions queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("createVersion inserts row and bumps listing latestVersion", async () => {
    const listing = await seedListing();
    const v = await createVersion(listing.id, "1.0.0", sampleManifest, "first release");

    expect(v.listingId).toBe(listing.id);
    expect(v.version).toBe("1.0.0");
    expect(v.manifest).toEqual(sampleManifest);
    expect(v.changelog).toBe("first release");

    const refreshed = await getListingById(listing.id);
    expect(refreshed!.latestVersion).toBe("1.0.0");
  });

  test("createVersion accepts null changelog", async () => {
    const listing = await seedListing();
    const v = await createVersion(listing.id, "1.2.3", sampleManifest);
    expect(v.changelog).toBeNull();
  });

  test("getVersion returns row by listing+version", async () => {
    const listing = await seedListing();
    await createVersion(listing.id, "2.0.0", sampleManifest);
    const fetched = await getVersion(listing.id, "2.0.0");
    expect(fetched).toBeDefined();
    expect(fetched!.version).toBe("2.0.0");
  });

  test("getVersion returns undefined for missing version", async () => {
    const listing = await seedListing();
    expect(await getVersion(listing.id, "9.9.9")).toBeUndefined();
  });

  test("getLatestVersion returns the most recently created version", async () => {
    const listing = await seedListing();
    await createVersion(listing.id, "1.0.0", sampleManifest);
    await new Promise((r) => setTimeout(r, 5));
    await createVersion(listing.id, "1.1.0", sampleManifest);
    await new Promise((r) => setTimeout(r, 5));
    await createVersion(listing.id, "2.0.0", sampleManifest);

    const latest = await getLatestVersion(listing.id);
    expect(latest!.version).toBe("2.0.0");
  });

  test("getLatestVersion returns undefined when no versions exist", async () => {
    const listing = await seedListing();
    expect(await getLatestVersion(listing.id)).toBeUndefined();
  });

  test("listVersions returns all versions for listing, newest first", async () => {
    const listing = await seedListing();
    await createVersion(listing.id, "1.0.0", sampleManifest);
    await new Promise((r) => setTimeout(r, 5));
    await createVersion(listing.id, "1.1.0", sampleManifest);
    await new Promise((r) => setTimeout(r, 5));
    await createVersion(listing.id, "1.2.0", sampleManifest);

    const all = await listVersions(listing.id);
    expect(all.length).toBe(3);
    expect(all.map((v) => v.version)).toEqual(["1.2.0", "1.1.0", "1.0.0"]);
  });

  test("listVersions scopes results to a single listing", async () => {
    const a = await seedListing();
    const b = await seedListing();
    await createVersion(a.id, "1.0.0", sampleManifest);
    await createVersion(b.id, "9.9.9", sampleManifest);

    const aVersions = await listVersions(a.id);
    expect(aVersions.length).toBe(1);
    expect(aVersions[0]!.version).toBe("1.0.0");
  });

  test("listVersions returns empty for listing with no versions", async () => {
    const listing = await seedListing();
    expect(await listVersions(listing.id)).toEqual([]);
  });
});
