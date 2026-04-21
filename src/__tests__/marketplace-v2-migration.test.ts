import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { createListing } from "../db/queries/marketplace";
import { createVersion, getLatestVersion } from "../db/queries/marketplace-versions";
import { createAgentConfig } from "../db/queries/agent-configs";
import { validateManifestV2 } from "../extensions/manifest";
import type { ExtensionManifestV2 } from "../extensions/types";
import { MARKETPLACE_CATEGORIES } from "../extensions/types";
import { getDb } from "../db/connection";
import { users } from "../db/schema";

function at<T>(arr: readonly T[] | undefined, i: number, what: string): T {
  const v = arr?.[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

let testUserId: string;

beforeAll(async () => {
  await setupTestDb();
  testUserId = crypto.randomUUID();
  await getDb().insert(users).values({
    id: testUserId,
    email: "v2-migration@test.com",
    passwordHash: "hashed",
    name: "V2 Tester",
    role: "member",
  });
});

afterAll(async () => {
  await closeTestDb();
});

// ── 1. Import Verification (Static Analysis) ─────────────────────

describe("import verification: marketplace routes use extensions/manifest and extensions/types", () => {
  const routeFiles = [
    "web/src/routes/api/marketplace/+server.ts",
    "web/src/routes/api/marketplace/import/+server.ts",
    "web/src/routes/api/marketplace/export/[id]/+server.ts",
    "web/src/routes/api/marketplace/[id]/install/+server.ts",
  ];

  for (const relPath of routeFiles) {
    const basename = relPath.split("/").slice(-2).join("/");

    test(`${basename} imports from extensions/manifest, not marketplace/manifest`, async () => {
      const content = await Bun.file(`${import.meta.dir}/../../${relPath}`).text();
      // Should import validateManifestV2 or compareVersions from extensions/manifest
      if (content.includes("validateManifestV2") || content.includes("compareVersions")) {
        expect(content).toContain("extensions/manifest");
      }
      expect(content).not.toContain("marketplace/manifest");
    });

    test(`${basename} imports types from extensions/types, not marketplace/types`, async () => {
      const content = await Bun.file(`${import.meta.dir}/../../${relPath}`).text();
      if (content.includes("ExtensionManifestV2")) {
        expect(content).toContain("extensions/types");
      }
      expect(content).not.toContain("marketplace/types");
    });
  }

  test("src/marketplace/types.ts does NOT exist", async () => {
    const file = Bun.file(`${import.meta.dir}/../marketplace/types.ts`);
    expect(await file.exists()).toBe(false);
  });

  test("src/marketplace/manifest.ts does NOT exist", async () => {
    const file = Bun.file(`${import.meta.dir}/../marketplace/manifest.ts`);
    expect(await file.exists()).toBe(false);
  });
});

// ── 2. DB Schema Type Verification ───────────────────────────────

describe("DB schema references ExtensionManifestV2", () => {
  test("extensions table manifest column references ExtensionManifestV2", async () => {
    const schemaContent = await Bun.file(`${import.meta.dir}/../db/schema.ts`).text();
    // The extensions table manifest column should use ExtensionManifestV2
    const extensionsBlock = schemaContent.slice(
      schemaContent.indexOf('export const extensions = pgTable'),
      schemaContent.indexOf('export const toolCalls'),
    );
    expect(extensionsBlock).toContain("ExtensionManifestV2");
    expect(extensionsBlock).toContain("manifest");
  });

  test("marketplace_versions table manifest column references ExtensionManifestV2", async () => {
    const schemaContent = await Bun.file(`${import.meta.dir}/../db/schema.ts`).text();
    const versionsBlock = schemaContent.slice(
      schemaContent.indexOf('export const marketplaceVersions = pgTable'),
      schemaContent.indexOf('export const marketplaceRatings'),
    );
    expect(versionsBlock).toContain("ExtensionManifestV2");
    expect(versionsBlock).toContain("manifest");
  });

  test("schema has no remaining references to MarketplaceManifest type", async () => {
    const schemaContent = await Bun.file(`${import.meta.dir}/../db/schema.ts`).text();
    expect(schemaContent).not.toContain("MarketplaceManifest");
  });

  test("schema imports ExtensionManifestV2 from extensions/types", async () => {
    const schemaContent = await Bun.file(`${import.meta.dir}/../db/schema.ts`).text();
    expect(schemaContent).toMatch(/import.*ExtensionManifestV2.*from.*extensions\/types/);
  });
});

// ── 3. Marketplace Export Produces V2 Manifests ──────────────────

describe("marketplace export produces v2 manifests", () => {
  let listingId: string;

  beforeAll(async () => {
    const config = await createAgentConfig({
      name: "V2 Export Test Agent",
      description: "Agent for v2 export testing",
      prompt: "You are an export v2 test agent.",
      capabilities: ["llm", "shell"],
      category: "Research",
      userId: testUserId,
    });

    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "v2-export-test-agent",
      version: "1.0.0",
      description: config.description,
      author: { name: "V2 Tester", id: testUserId },
      agent: {
        prompt: config.prompt,
        category: config.category ?? "Other",
        capabilities: config.capabilities as string[],
      },
      entrypoint: "./index.ts",
      tools: [
        {
          name: "search",
          description: "Search the web",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
      permissions: { network: ["*"] },
      tags: ["v2-test"],
    };

    const listing = await createListing({
      authorId: testUserId,
      agentConfigId: config.id,
      name: config.name,
      description: config.description,
      category: "Research",
      tags: ["v2-test"],
      latestVersion: "1.0.0",
    });
    listingId = listing.id;

    await createVersion(listingId, "1.0.0", manifest);
  });

  test("exported manifest has schemaVersion: 2", async () => {
    const latestVer = await getLatestVersion(listingId);
    expect(latestVer).toBeDefined();
    const manifest = latestVer!.manifest as ExtensionManifestV2;
    expect(manifest.schemaVersion).toBe(2);
  });

  test("exported manifest has author as an object with name", async () => {
    const latestVer = await getLatestVersion(listingId);
    const manifest = latestVer!.manifest as ExtensionManifestV2;
    expect(manifest.author).toBeDefined();
    expect(typeof manifest.author).toBe("object");
    expect(manifest.author.name).toBe("V2 Tester");
    expect(manifest.author.id).toBe(testUserId);
  });

  test("exported manifest has tools as array of ToolDefinition objects", async () => {
    const latestVer = await getLatestVersion(listingId);
    const manifest = latestVer!.manifest as ExtensionManifestV2;
    expect(Array.isArray(manifest.tools)).toBe(true);
    expect(manifest.tools!.length).toBe(1);
    const tool = at(manifest.tools, 0, "tool");
    expect(tool.name).toBe("search");
    expect(tool.description).toBe("Search the web");
    expect(tool.inputSchema).toBeDefined();
  });

  test("exported manifest includes agent component", async () => {
    const latestVer = await getLatestVersion(listingId);
    const manifest = latestVer!.manifest as ExtensionManifestV2;
    expect(manifest.agent).toBeDefined();
    expect(manifest.agent!.prompt).toBe("You are an export v2 test agent.");
    expect(manifest.agent!.category).toBe("Research");
    expect(manifest.agent!.capabilities).toEqual(["llm", "shell"]);
  });

  test("exported manifest serializes to valid JSON with v2 fields", async () => {
    const latestVer = await getLatestVersion(listingId);
    const manifest = latestVer!.manifest as ExtensionManifestV2;
    const exported = { ...manifest, exportedAt: new Date().toISOString() };
    const json = JSON.stringify(exported, null, 2);

    expect(json).toContain('"schemaVersion": 2');
    expect(json).toContain('"author"');
    expect(json).toContain('"tools"');
    expect(json).toContain('"exportedAt"');

    // Round-trip: parse back and validate
    const parsed = JSON.parse(json);
    const { valid } = validateManifestV2(parsed);
    expect(valid).toBe(true);
  });
});

// ── 4. Marketplace Import Validates V2 ───────────────────────────

describe("marketplace import validates v2", () => {
  test("valid v2 manifest passes validation", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "valid-import-agent",
      version: "1.0.0",
      description: "A valid agent for import",
      author: { name: "Importer" },
      agent: {
        prompt: "You are a valid import agent.",
        category: "Productivity",
        capabilities: ["llm"],
      },
      permissions: {},
      tags: [],
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  test("v1 manifest (no schemaVersion) fails validation", () => {
    const v1Manifest = {
      name: "Old V1 Agent",
      version: "1.0.0",
      description: "An old v1 manifest without schemaVersion",
      author: { name: "Old Author" },
      permissions: {},
    };

    const { valid, errors } = validateManifestV2(v1Manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("schemaVersion"))).toBe(true);
  });

  test("manifest with schemaVersion: 1 fails validation", () => {
    const badManifest = {
      schemaVersion: 1,
      name: "Wrong Version Agent",
      version: "1.0.0",
      description: "Has wrong schema version",
      author: { name: "Author" },
      permissions: {},
    };

    const { valid, errors } = validateManifestV2(badManifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("schemaVersion must be 2"))).toBe(true);
  });

  test("manifest with invalid tools component fails with specific errors", () => {
    const manifest = {
      schemaVersion: 2,
      name: "Bad Tools Agent",
      version: "1.0.0",
      description: "Agent with invalid tools",
      author: { name: "Author" },
      permissions: {},
      entrypoint: "./index.ts",
      tools: [
        { name: "", description: "missing name" },
        { name: "valid-tool" },
      ],
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("tools[0].name"))).toBe(true);
    expect(errors.some((e) => e.includes("tools[0].inputSchema"))).toBe(true);
    expect(errors.some((e) => e.includes("tools[1].description"))).toBe(true);
    expect(errors.some((e) => e.includes("tools[1].inputSchema"))).toBe(true);
  });

  test("manifest with invalid skills component fails with specific errors", () => {
    const manifest = {
      schemaVersion: 2,
      name: "Bad Skills Agent",
      version: "1.0.0",
      description: "Agent with invalid skills",
      author: { name: "Author" },
      permissions: {},
      skills: [
        { name: "" },
        { description: "missing name" },
      ],
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("skills[0].name"))).toBe(true);
    expect(errors.some((e) => e.includes("skills[0].description"))).toBe(true);
    expect(errors.some((e) => e.includes("skills[1].name"))).toBe(true);
  });

  test("manifest with invalid mcpServers component fails with specific errors", () => {
    const manifest = {
      schemaVersion: 2,
      name: "Bad MCP Agent",
      version: "1.0.0",
      description: "Agent with invalid mcpServers",
      author: { name: "Author" },
      permissions: {},
      mcpServers: [
        { name: "server1" },
      ],
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("mcpServers[0].transport"))).toBe(true);
  });

  test("manifest with tools but no entrypoint fails", () => {
    const manifest = {
      schemaVersion: 2,
      name: "No Entrypoint Agent",
      version: "1.0.0",
      description: "Has tools but no entrypoint",
      author: { name: "Author" },
      permissions: {},
      tools: [
        { name: "tool1", description: "A tool", inputSchema: { type: "object" } },
      ],
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("entrypoint is required when tools are declared"))).toBe(true);
  });

  test("manifest missing required fields fails with multiple errors", () => {
    const { valid, errors } = validateManifestV2({});
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("schemaVersion"))).toBe(true);
    expect(errors.some((e) => e.includes("name"))).toBe(true);
    expect(errors.some((e) => e.includes("version"))).toBe(true);
    expect(errors.some((e) => e.includes("description"))).toBe(true);
    expect(errors.some((e) => e.includes("author"))).toBe(true);
  });

  test("null manifest fails validation", () => {
    const { valid, errors } = validateManifestV2(null);
    expect(valid).toBe(false);
    expect(errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("manifest with invalid version format fails", () => {
    const manifest = {
      schemaVersion: 2,
      name: "Bad Version",
      version: "not-semver",
      description: "Invalid version format",
      author: { name: "Author" },
      permissions: {},
    };

    const { valid, errors } = validateManifestV2(manifest);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("version must be valid semver"))).toBe(true);
  });
});

// ── 5. Type Consistency Checks ───────────────────────────────────

describe("type consistency: marketplace types live in extensions/types.ts", () => {
  test("MARKETPLACE_CATEGORIES is exported from extensions/types.ts", () => {
    expect(MARKETPLACE_CATEGORIES).toBeDefined();
    expect(Array.isArray(MARKETPLACE_CATEGORIES)).toBe(true);
    expect(MARKETPLACE_CATEGORIES.length).toBeGreaterThan(0);
    expect(MARKETPLACE_CATEGORIES).toContain("Productivity");
    expect(MARKETPLACE_CATEGORIES).toContain("Development");
    expect(MARKETPLACE_CATEGORIES).toContain("Other");
  });

  test("MarketplaceCategory, ListingStatus, FlagStatus types are defined in extensions/types.ts", async () => {
    const typesContent = await Bun.file(`${import.meta.dir}/../extensions/types.ts`).text();
    expect(typesContent).toContain("export type MarketplaceCategory");
    expect(typesContent).toContain("export type ListingStatus");
    expect(typesContent).toContain("export type FlagStatus");
  });

  test("extensions/types.ts contains ExtensionManifestV2 interface", async () => {
    const typesContent = await Bun.file(`${import.meta.dir}/../extensions/types.ts`).text();
    expect(typesContent).toContain("export interface ExtensionManifestV2");
  });

  test("extensions/types.ts contains all v2 component definitions", async () => {
    const typesContent = await Bun.file(`${import.meta.dir}/../extensions/types.ts`).text();
    expect(typesContent).toContain("export interface ToolDefinition");
    expect(typesContent).toContain("export interface SkillDefinition");
    expect(typesContent).toContain("export type McpServerDefinition");
    expect(typesContent).toContain("export interface AgentComponentDefinition");
    expect(typesContent).toContain("export interface ScriptDefinition");
  });

  test("no 'as any' type casting on manifest variables themselves in route files", async () => {
    const routeFiles = [
      "web/src/routes/api/marketplace/+server.ts",
      "web/src/routes/api/marketplace/import/+server.ts",
      "web/src/routes/api/marketplace/export/[id]/+server.ts",
      "web/src/routes/api/marketplace/[id]/install/+server.ts",
    ];

    // Patterns that indicate a manifest variable itself is cast to any
    // e.g. `manifest as any`, `(manifest) as any`, `= data as any`
    // We allow `as any` on sub-fields like capabilities/inputSchema since
    // those are jsonb columns with looser types
    const manifestCastPattern = /\bmanifest\s+as\s+any\b/;

    for (const relPath of routeFiles) {
      const content = await Bun.file(`${import.meta.dir}/../../${relPath}`).text();
      const lines = content.split("\n");
      for (const line of lines) {
        if (manifestCastPattern.test(line)) {
          throw new Error(
            `Found manifest cast to 'any' in ${relPath}: ${line.trim()}`,
          );
        }
      }
    }
  });

  test("extensions/manifest.ts exports validateManifestV2, compareVersions, generateSlug", async () => {
    const manifestContent = await Bun.file(`${import.meta.dir}/../extensions/manifest.ts`).text();
    expect(manifestContent).toContain("export function validateManifestV2");
    expect(manifestContent).toContain("export function compareVersions");
    expect(manifestContent).toContain("export function generateSlug");
  });

  test("extensions/manifest.ts does not re-export from marketplace/", async () => {
    const manifestContent = await Bun.file(`${import.meta.dir}/../extensions/manifest.ts`).text();
    expect(manifestContent).not.toContain("from \"../marketplace");
    expect(manifestContent).not.toContain("from './marketplace");
  });
});
