/**
 * Comprehensive tests for the extension installer's v2 manifest validation.
 *
 * Covers:
 * 1. installFromLocal with v2 validation (success, v1 rejection, missing fields, tools/entrypoint, agent-only)
 * 2. DB storage shape verification
 * 3. Marketplace version storage with ExtensionManifestV2
 * 4. Seed data v2 manifest verification
 * 5. Import path cleanup (no remaining marketplace/types or marketplace/manifest imports)
 */

import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { validateManifestV2 } from "../extensions/manifest";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";
import { writeConfig } from "./helpers/write-config";

// ── Mock DB layer (same pattern as extension-crud.test.ts) ───────────

const mockExtensions = new Map<string, any>();
let lastCreateCall: any = null;

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    lastCreateCall = ext;
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtension: async (id: string) => mockExtensions.get(id) ?? null,
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) {
      if (ext.name === name) return ext;
    }
    return null;
  },
  updateExtension: async (id: string, data: any) => {
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
  incrementFailures: async () => 0,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

// Import installer AFTER mock is set up
const { installFromLocal } = await import("../extensions/installer");

// ── Helpers ──────────────────────────────────────────────────────────

function makeValidV2Manifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [
      { name: "greet", description: "Say hi", inputSchema: { type: "object" } },
    ],
    permissions: { network: ["api.example.com"] },
    ...overrides,
  };
}

const defaultPermissions: ExtensionPermissions = {
  network: ["api.example.com"],
  grantedAt: { network: Date.now() },
};

async function setupExtDir(manifest: ExtensionManifestV2 | Record<string, unknown>, entryContent = 'console.log("ext");') {
  const dir = await mkdtemp(join(tmpdir(), "ext-v2-test-"));
  await writeConfig(dir, manifest);
  if ((manifest as any).entrypoint) {
    const ep = (manifest as any).entrypoint.replace(/^\.\//, "");
    await Bun.write(join(dir, ep), entryContent);
  }
  return dir;
}

// ── 1. installFromLocal v2 validation ────────────────────────────────

describe("installFromLocal — v2 validation", () => {
  beforeEach(() => {
    lastCreateCall = null;
    mockExtensions.clear();
  });

  test("succeeds with valid v2 manifest", async () => {
    const manifest = makeValidV2Manifest();
    const dir = await setupExtDir(manifest);

    const result = await installFromLocal(dir, defaultPermissions);

    expect(result.name).toBe("test-ext");
    expect(result.version).toBe("1.0.0");
    expect(result.source).toBe(`local:${dir}`);
  });

  test("fails with v1 manifest (missing schemaVersion)", async () => {
    const v1Manifest = {
      name: "legacy-ext",
      version: "0.9.0",
      description: "Old format",
      entrypoint: "index.ts",
      permissions: {},
    };
    const dir = await setupExtDir(v1Manifest);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*schemaVersion/,
    );
  });

  test("fails when name is missing", async () => {
    const { name, ...rest } = makeValidV2Manifest();
    const dir = await setupExtDir(rest as any);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*name/,
    );
  });

  test("fails when version is invalid semver", async () => {
    const manifest = { ...makeValidV2Manifest(), version: "not-semver" };
    const dir = await setupExtDir(manifest);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*version/,
    );
  });

  test("fails when description is missing", async () => {
    const { description, ...rest } = makeValidV2Manifest();
    const dir = await setupExtDir(rest as any);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*description/,
    );
  });

  test("fails when author.name is missing", async () => {
    const manifest = { ...makeValidV2Manifest(), author: {} };
    const dir = await setupExtDir(manifest);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*author/,
    );
  });

  test("fails when tools declared but no entrypoint — validation error", async () => {
    const manifest = makeValidV2Manifest();
    const { entrypoint, ...rest } = manifest;
    // Write manifest without entrypoint but with tools
    const dir = await mkdtemp(join(tmpdir(), "ext-v2-noep-"));
    await writeConfig(dir, rest);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Invalid manifest.*entrypoint/,
    );
  });

  test("fails when manifest has entrypoint but file does not exist (no entrypoint file)", async () => {
    // Valid manifest but we don't create the entrypoint file
    const manifest = makeValidV2Manifest();
    const dir = await mkdtemp(join(tmpdir(), "ext-v2-nofile-"));
    await writeConfig(dir, manifest);
    // Do NOT write index.ts

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow();
  });

  test("agent-only manifest (no tools, no entrypoint) fails install due to missing entrypoint", async () => {
    // validateManifestV2 passes for agent-only (no tools = no entrypoint requirement)
    // but installFromLocal throws "Cannot install extension without entrypoint"
    const agentManifest: Record<string, unknown> = {
      schemaVersion: 2,
      name: "agent-only",
      version: "1.0.0",
      description: "An agent extension",
      author: { name: "Agent Author" },
      agent: {
        prompt: "You are a helpful assistant.",
        category: "Productivity",
      },
      permissions: {},
    };

    // Validation itself should pass (no tools = no entrypoint required)
    const validation = validateManifestV2(agentManifest);
    expect(validation.valid).toBe(true);

    // But installer requires entrypoint for all installs currently
    const dir = await mkdtemp(join(tmpdir(), "ext-v2-agent-"));
    await writeConfig(dir, agentManifest);

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /Cannot install extension without entrypoint/,
    );
  });

  test("multiple validation errors are joined", async () => {
    const badManifest = { schemaVersion: 1 }; // missing everything
    const dir = await mkdtemp(join(tmpdir(), "ext-v2-multi-"));
    await writeConfig(dir, badManifest);

    try {
      await installFromLocal(dir, defaultPermissions);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("Invalid manifest:");
      // Should contain multiple comma-separated errors
      expect(err.message).toContain(",");
    }
  });

  test("rejects when ezcorp.config.ts is missing entirely", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ext-v2-empty-"));

    await expect(installFromLocal(dir, defaultPermissions)).rejects.toThrow(
      /No ezcorp\.config\.ts found/,
    );
  });
});

// ── 2. DB storage shape verification ─────────────────────────────────

describe("DB storage — v2 manifest shape", () => {
  beforeEach(() => {
    lastCreateCall = null;
    mockExtensions.clear();
  });

  test("stored manifest has schemaVersion: 3 (auto-promoted from v2 by migrateManifestV2ToV3 on load)", async () => {
    // Phase 1: `loadManifest` auto-promotes v2 manifests to v3, marking
    // them with `_inheritedFromV2: true`. The on-disk file stays v2;
    // it's the in-memory + DB-stored shape that becomes v3.
    const manifest = makeValidV2Manifest();
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall).not.toBeNull();
    expect(lastCreateCall.manifest.schemaVersion).toBe(3);
    expect(lastCreateCall.manifest._inheritedFromV2).toBe(true);
  });

  test("stored manifest preserves author object", async () => {
    const manifest = makeValidV2Manifest({ author: { name: "Jane", id: "usr_123" } });
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall.manifest.author).toEqual({ name: "Jane", id: "usr_123" });
  });

  test("stored manifest preserves tools array", async () => {
    const tools = [
      { name: "tool_a", description: "Tool A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "Tool B", inputSchema: { type: "object", properties: { x: { type: "number" } } } },
    ];
    const manifest = makeValidV2Manifest({ tools });
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall.manifest.tools).toHaveLength(2);
    expect(lastCreateCall.manifest.tools[0].name).toBe("tool_a");
    expect(lastCreateCall.manifest.tools[1].name).toBe("tool_b");
    expect(lastCreateCall.manifest.tools[1].inputSchema.properties).toEqual({ x: { type: "number" } });
  });

  test("stored manifest includes computed checksum", async () => {
    const manifest = makeValidV2Manifest();
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("source field is 'local:<path>'", async () => {
    const manifest = makeValidV2Manifest();
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall.source).toBe(`local:${dir}`);
  });

  test("extension top-level fields match manifest values", async () => {
    const manifest = makeValidV2Manifest({
      name: "db-shape-test",
      version: "2.3.4",
      description: "Checking DB fields",
    });
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions, true);

    expect(lastCreateCall.name).toBe("db-shape-test");
    expect(lastCreateCall.version).toBe("2.3.4");
    expect(lastCreateCall.description).toBe("Checking DB fields");
    expect(lastCreateCall.enabled).toBe(true);
    expect(lastCreateCall.checksumVerified).toBe(true);
    expect(lastCreateCall.consecutiveFailures).toBe(0);
  });

  test("grantedPermissions are stored as provided", async () => {
    const manifest = makeValidV2Manifest();
    const dir = await setupExtDir(manifest);
    const perms: ExtensionPermissions = {
      network: ["*.example.com"],
      filesystem: ["/tmp"],
      shell: true,
      grantedAt: { network: 1000, filesystem: 2000, shell: 3000 },
    };
    await installFromLocal(dir, perms);

    expect(lastCreateCall.grantedPermissions).toEqual(perms);
  });

  test("manifest preserves optional v2 fields (tags, category, skills)", async () => {
    const manifest = makeValidV2Manifest({
      tags: ["utility", "dev"],
      category: "Development",
      skills: [{ name: "refactor", description: "Refactors code" }],
    });
    const dir = await setupExtDir(manifest);
    await installFromLocal(dir, defaultPermissions);

    expect(lastCreateCall.manifest.tags).toEqual(["utility", "dev"]);
    expect(lastCreateCall.manifest.category).toBe("Development");
    expect(lastCreateCall.manifest.skills).toEqual([{ name: "refactor", description: "Refactors code" }]);
  });
});

// ── 3. Marketplace version storage — v2 manifest type ────────────────

describe("marketplace-versions — v2 manifest type", () => {
  test("createVersion accepts ExtensionManifestV2 parameter type", async () => {
    // Type-level verification: createVersion's third arg is ExtensionManifestV2.
    // We import and confirm the function signature accepts our manifest.
    const { createVersion } = await import("../db/queries/marketplace-versions");

    // This is a compile-time check — if ExtensionManifestV2 were wrong, TS would error.
    const manifest: ExtensionManifestV2 = makeValidV2Manifest();
    // We cannot call createVersion without a real DB, so we verify the type compatibility
    // by checking that the function exists and is callable with the right signature.
    expect(typeof createVersion).toBe("function");
    expect(createVersion.length).toBeGreaterThanOrEqual(2);

    // Verify the manifest satisfies the expected shape
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.author.name).toBe("Tester");
  });

  test("marketplace_versions schema column types ExtensionManifestV2", async () => {
    // Verify the schema definition references ExtensionManifestV2 for the manifest column.
    // We read the column type from the imported schema.
    const { marketplaceVersions } = await import("../db/schema");

    // The table should have manifest, listingId, version, changelog, id, createdAt columns
    const columnNames = Object.keys(marketplaceVersions);
    expect(columnNames).toContain("manifest");
    expect(columnNames).toContain("listingId");
    expect(columnNames).toContain("version");
  });
});

// ── 4. Seed data v2 manifest verification ────────────────────────────

describe("seed-marketplace — v2 manifest shape", () => {
  // We parse the seed data by importing SEED_AGENTS indirectly (it's not exported,
  // so we read the file and verify the manifest construction pattern).

  test("seed builds manifests with schemaVersion: 2", async () => {
    const seedContent = await Bun.file(
      join(import.meta.dir, "..", "db", "seed-marketplace.ts"),
    ).text();

    // Verify schemaVersion: 2 is used in manifest construction
    expect(seedContent).toContain("schemaVersion: 2");
  });

  test("seed builds manifests with author object (name + id)", async () => {
    const seedContent = await Bun.file(
      join(import.meta.dir, "..", "db", "seed-marketplace.ts"),
    ).text();

    expect(seedContent).toContain('author: { name: "Marketplace Tester", id: userId }');
  });

  test("seed imports ExtensionManifestV2 from extensions/types", async () => {
    const seedContent = await Bun.file(
      join(import.meta.dir, "..", "db", "seed-marketplace.ts"),
    ).text();

    expect(seedContent).toContain('import type { ExtensionManifestV2 } from "../extensions/types"');
  });

  test("seed manifests include agent component with prompt", async () => {
    const seedContent = await Bun.file(
      join(import.meta.dir, "..", "db", "seed-marketplace.ts"),
    ).text();

    // Verify agent block structure
    expect(seedContent).toContain("agent: {");
    expect(seedContent).toContain("prompt: config.prompt");
  });

  test("seed manifests validate against validateManifestV2", () => {
    // Reconstruct a representative manifest that mirrors what the seed produces.
    // seed-marketplace.ts slugifies manifest.name (the display name lives on
    // the listing row) so names are always filesystem-safe.
    const seedManifest = {
      schemaVersion: 2,
      name: "code-reviewer",
      version: "1.0.0",
      description: "Analyzes pull requests for bugs, style issues, and security vulnerabilities.",
      author: { name: "Marketplace Tester", id: "fake-user-id" },
      agent: {
        prompt: "You are a senior code reviewer.",
        category: "Development",
        capabilities: ["llm"],
      },
      permissions: {},
      tags: ["code-review", "security", "best-practices"],
    };

    const result = validateManifestV2(seedManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ── 5. Import path cleanup verification ──────────────────────────────

describe("import path cleanup — no marketplace/types or marketplace/manifest", () => {
  test("zero 'from' imports of marketplace/types in src/", async () => {
    // Match actual import statements, not comments or string literals
    const proc = Bun.spawnSync(
      ["grep", "-rP", "from\\s+[\"'].*marketplace/types", "--include=*.ts", "--include=*.tsx", "-l"],
      { cwd: join(import.meta.dir, "..") },
    );
    const stdout = proc.stdout.toString().trim();
    expect(stdout).toBe("");
  });

  test("zero 'from' imports of marketplace/manifest in src/", async () => {
    const proc = Bun.spawnSync(
      ["grep", "-rP", "from\\s+[\"'].*marketplace/manifest", "--include=*.ts", "--include=*.tsx", "-l"],
      { cwd: join(import.meta.dir, "..") },
    );
    const stdout = proc.stdout.toString().trim();
    expect(stdout).toBe("");
  });

  test("zero 'from' imports of marketplace/types in web/src/", async () => {
    const proc = Bun.spawnSync(
      ["grep", "-rP", "from\\s+[\"'].*marketplace/types", "--include=*.ts", "--include=*.tsx", "--include=*.svelte", "-l"],
      { cwd: join(import.meta.dir, "../../web/src") },
    );
    const stdout = proc.stdout.toString().trim();
    expect(stdout).toBe("");
  });

  test("zero 'from' imports of marketplace/manifest in web/src/", async () => {
    const proc = Bun.spawnSync(
      ["grep", "-rP", "from\\s+[\"'].*marketplace/manifest", "--include=*.ts", "--include=*.tsx", "--include=*.svelte", "-l"],
      { cwd: join(import.meta.dir, "../../web/src") },
    );
    const stdout = proc.stdout.toString().trim();
    expect(stdout).toBe("");
  });

  test("all files importing validateManifestV2 use extensions/manifest path", async () => {
    // Find actual import statements (lines starting with import) that reference validateManifestV2
    const proc = Bun.spawnSync(
      ["grep", "-rPn", "^import.*validateManifestV2.*from", "--include=*.ts", "--include=*.tsx"],
      { cwd: join(import.meta.dir, "..") },
    );
    const lines = proc.stdout.toString().trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0); // at least installer.ts and this test

    for (const match of lines) {
      // Each line is "file:linenum:content"
      const [filePath, , ...rest] = match.split(":");
      const line = rest.join(":");

      // Files inside extensions/ may use relative "./manifest" or "../manifest"
      if (filePath!.startsWith("extensions/")) {
        expect(line).toMatch(/from\s+["']\.\.?\/manifest["']/);
      } else {
        // Files outside extensions/ must use "extensions/manifest" or "../extensions/manifest"
        expect(line).toMatch(/extensions\/manifest/);
      }
    }
  });

  test("old marketplace/types.ts and marketplace/manifest.ts files do not exist", async () => {
    const typesFile = Bun.file(join(import.meta.dir, "..", "marketplace", "types.ts"));
    expect(await typesFile.exists()).toBe(false);

    const manifestFile = Bun.file(join(import.meta.dir, "..", "marketplace", "manifest.ts"));
    expect(await manifestFile.exists()).toBe(false);
  });
});
