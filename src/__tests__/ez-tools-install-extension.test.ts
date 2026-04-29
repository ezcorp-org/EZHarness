/**
 * Phase 48 Wave 2 — propose_install_extension Ez tool.
 *
 * Asserts the tool:
 *  - resolves an exact-slug match and returns a single-entry shortlist
 *  - falls back to a name-substring browse when no exact match exists
 *  - free-text searchQuery routes through browseMarketplace
 *  - rejects when neither extensionName nor searchQuery is provided
 *  - persists an `extension`-kind draft for symmetry with other propose_*
 *  - openUrl is /marketplace?q=... or ?slug=...
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { expectDetails, expectJson, expectText } from "./helpers/expect-tool-result";

interface ExtensionListing {
  id: string;
  slug: string;
  name: string;
  description: string;
}
interface ExtensionDraftJson {
  draftId: string;
  openUrl: string;
  extensions: ExtensionListing[];
}
interface ToolErrorDetails {
  isError: true;
}

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProposeInstallExtensionTool } = await import("../runtime/tools/ez/propose-install-extension");
const { getDraft } = await import("../db/queries/ez-drafts");
const { getDb } = await import("../db/connection");
const { marketplaceListings } = await import("../db/schema");

let userId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-install-ext@test.com", passwordHash: "h", name: "EXT" });
  userId = u.id;

  // Seed a couple of marketplace listings so the lookup paths have data.
  await getDb().insert(marketplaceListings).values([
    {
      authorId: userId,
      name: "PDF Reader",
      description: "Read PDFs in chat.",
      slug: "pdf-reader",
      category: "files",
      latestVersion: "1.0.0",
    },
    {
      authorId: userId,
      name: "Web Crawler",
      description: "Crawl web pages.",
      slug: "web-crawler",
      category: "tools",
      latestVersion: "1.0.0",
    },
  ]);
});

afterAll(async () => {
  await closeTestDb();
});

describe("propose_install_extension", () => {
  test("exact slug match returns a single entry and a slug-keyed openUrl", async () => {
    const tool = createProposeInstallExtensionTool({ userId });
    const result = await tool.execute("e-1", { extensionName: "pdf-reader" });
    const parsed = expectJson<ExtensionDraftJson>(result);
    expect(parsed.extensions.length).toBe(1);
    expect(parsed.extensions[0]!.slug).toBe("pdf-reader");
    expect(parsed.openUrl).toBe("/marketplace?slug=pdf-reader");
    // Draft persisted.
    const row = await getDraft(parsed.draftId, userId);
    expect(row!.kind).toBe("extension");
  });

  test("non-exact name falls back to substring browse", async () => {
    const tool = createProposeInstallExtensionTool({ userId });
    const result = await tool.execute("e-2", { extensionName: "PDF" });
    const parsed = expectJson<ExtensionDraftJson>(result);
    // browseMarketplace ilikes name+description so this should hit "PDF Reader".
    expect(parsed.extensions.some((e) => e.slug === "pdf-reader")).toBe(true);
    expect(parsed.openUrl).toBe("/marketplace?q=PDF");
  });

  test("free-text searchQuery routes through browseMarketplace", async () => {
    const tool = createProposeInstallExtensionTool({ userId });
    const result = await tool.execute("e-3", { searchQuery: "crawl" });
    const parsed = expectJson<ExtensionDraftJson>(result);
    expect(parsed.extensions.some((e) => e.slug === "web-crawler")).toBe(true);
    expect(parsed.openUrl).toBe("/marketplace?q=crawl");
  });

  test("rejects when neither extensionName nor searchQuery is provided", async () => {
    const tool = createProposeInstallExtensionTool({ userId });
    const result = await tool.execute("e-4", {});
    expect(expectDetails<ToolErrorDetails>(result).isError).toBe(true);
    expectText(result, "extensionName or searchQuery");
  });

  test("openUrl URL-encodes the query", async () => {
    const tool = createProposeInstallExtensionTool({ userId });
    const result = await tool.execute("e-5", { searchQuery: "spaces & symbols" });
    const parsed = expectJson<ExtensionDraftJson>(result);
    expect(parsed.openUrl).toBe(`/marketplace?q=${encodeURIComponent("spaces & symbols")}`);
  });
});
