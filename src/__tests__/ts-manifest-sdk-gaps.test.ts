/**
 * Phase 28 gap tests: SDK tools (publish, dev, test-runner) integration
 * with loadManifest/loadManifestFresh, plus backward compatibility.
 */
import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig } from "./helpers/write-config";

// ── Shared fixtures ──────────────────────────────────────────────

const VALID_MANIFEST = {
  schemaVersion: 2,
  name: "sdk-gap-ext",
  version: "1.0.0",
  description: "SDK gap test extension",
  author: { name: "Tester" },
  entrypoint: "index.ts",
  permissions: {},
  tools: [{ name: "noop", description: "No-op", inputSchema: { type: "object" } }],
};

const MANIFEST_WITH_MEMORY = {
  ...VALID_MANIFEST,
  resources: { memory: "256MB" },
};

// ── Mocks ────────────────────────────────────────────────────────

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
mock.module("../extensions/manifest", () => ({
  validateManifestV2: (data: unknown) => {
    const errors: string[] = [];
    if (!data || typeof data !== "object") return { valid: false, errors: ["not an object"] };
    const m = data as Record<string, unknown>;
    if (m.schemaVersion !== 2) errors.push("schemaVersion must be 2");
    if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) errors.push("version must be valid semver");
    if (!m.description || typeof m.description !== "string") errors.push("description required");
    if (!m.author || typeof m.author !== "object") errors.push("author.name required");
    return { valid: errors.length === 0, errors };
  },
  generateSlug: (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  inferPackageType: () => "tool",
}));

const mockInitDb = mock(() => Promise.resolve());
const mockGetAllSettings = mock(() => Promise.resolve({
  "publish:token:user-1": { token: "valid-token", createdAt: 1 },
}));
const mockCreateListing = mock(() => Promise.resolve({ id: "lst-1", name: "sdk-gap-ext", slug: "sdk-gap-ext" }));
const mockGetListingBySlug = mock(() => Promise.resolve(undefined));
const mockCreateVersion = mock(() => Promise.resolve({ id: "ver-1" }));
const mockGetVersion = mock(() => Promise.resolve(undefined));
const mockRunExtensionTests = mock(() => Promise.resolve(0));
const mockComputePackageChecksums = mock(() => Promise.resolve({ "index.ts": "abc" }));

mock.module("../db/connection", () => ({ initDb: mockInitDb, getDb: mock(() => ({})) }));
mock.module("../db/queries/settings", () => ({
  getSetting: mock(() => Promise.resolve(undefined)),
  getAllSettings: mockGetAllSettings,
  upsertSetting: mock(() => Promise.resolve()),
  deleteSetting: mock(() => Promise.resolve(true)),
}));
mock.module("../db/queries/marketplace", () => ({
  createListing: mockCreateListing,
  getListingBySlug: mockGetListingBySlug,
}));
mock.module("../db/queries/marketplace-versions", () => ({
  createVersion: mockCreateVersion,
  getVersion: mockGetVersion,
}));
mock.module("../extensions/sdk/test-runner", () => ({
  runExtensionTests: mockRunExtensionTests,
}));
mock.module("../extensions/checksum", () => ({
  computePackageChecksums: mockComputePackageChecksums,
  computeChecksum: mock(() => Promise.resolve("a".repeat(64))),
  verifyChecksum: mock(() => Promise.resolve(true)),
  verifyPackageChecksums: mock(() => Promise.resolve({ valid: true, mismatched: [] })),
}));

afterAll(() => restoreModuleMocks());

// ── Helpers ──────────────────────────────────────────────────────

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sdk-gap-test-"));
  mockInitDb.mockClear();
  mockGetAllSettings.mockClear();
  mockCreateListing.mockClear();
  mockGetListingBySlug.mockClear();
  mockCreateVersion.mockClear();
  mockGetVersion.mockClear();
  mockComputePackageChecksums.mockClear();
  mockGetListingBySlug.mockImplementation(() => Promise.resolve(undefined));
  mockGetVersion.mockImplementation(() => Promise.resolve(undefined));
  mockCreateListing.mockImplementation(() => Promise.resolve({ id: "lst-1", name: "sdk-gap-ext", slug: "sdk-gap-ext" }));
  mockGetAllSettings.mockImplementation(() => Promise.resolve({
    "publish:token:user-1": { token: "valid-token", createdAt: 1 },
  }));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeEntrypoint() {
  writeFileSync(join(tempDir, "index.ts"), 'export default {};');
}

// ── publish + loadManifest ───────────────────────────────────────

describe("publishExtension + loadManifest", () => {
  test("reads manifest via loadManifest without throwing", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    await writeConfig(tempDir, VALID_MANIFEST);
    writeEntrypoint();

    await expect(
      publishExtension({ extDir: tempDir, token: "valid-token", skipTests: true }),
    ).resolves.toBeUndefined();
  });

  test("rejects when ezcorp.config.ts is missing", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    // tempDir exists but has no config file

    await expect(
      publishExtension({ extDir: tempDir, token: "valid-token", skipTests: true }),
    ).rejects.toThrow("No ezcorp.config.ts found");
  });

  test("rejects invalid manifest (missing required fields)", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeFileSync(
      join(tempDir, "ezcorp.config.ts"),
      `export default { name: "bad" };\n`,
    );

    await expect(
      publishExtension({ extDir: tempDir, token: "valid-token", skipTests: true }),
    ).rejects.toThrow("Invalid manifest");
  });
});

// ── test-runner + loadManifest ───────────────────────────────────

describe("runExtensionTests + loadManifest", () => {
  // For these tests we need the real test-runner (not the mock used by publish).
  // We import loadManifest directly since test-runner is mocked above.
  test("loadManifest succeeds for valid config in test-runner context", async () => {
    const { loadManifest } = await import("../extensions/loader");
    await writeConfig(tempDir, VALID_MANIFEST);

    const manifest = await loadManifest(tempDir);
    expect(manifest.name).toBe("sdk-gap-ext");
    expect(manifest.version).toBe("1.0.0");
  });

  test("loadManifest fails when ezcorp.config.ts is missing (test-runner path)", async () => {
    const { loadManifest } = await import("../extensions/loader");

    await expect(loadManifest(tempDir)).rejects.toThrow("No ezcorp.config.ts found");
  });

  test("manifest.resources.memory is available for memory limit", async () => {
    const { loadManifest } = await import("../extensions/loader");
    await writeConfig(tempDir, MANIFEST_WITH_MEMORY);

    const manifest = await loadManifest(tempDir) as unknown as Record<string, unknown>;
    const resources = manifest.resources as { memory?: string };
    expect(resources?.memory).toBe("256MB");
  });
});

// ── dev server + loadManifestFresh ───────────────────────────────

describe("startDevServer + loadManifestFresh", () => {
  test("dev.ts imports loadManifestFresh from loader", async () => {
    const source = await Bun.file(join(import.meta.dir, "../extensions/sdk/dev.ts")).text();
    expect(source).toContain("loadManifestFresh");
    expect(source).toMatch(/import\s*\{[^}]*loadManifestFresh[^}]*\}\s*from\s*["']\.\.\/loader["']/);
  });

  test("dev.ts does NOT import loadManifest (only loadManifestFresh)", async () => {
    const source = await Bun.file(join(import.meta.dir, "../extensions/sdk/dev.ts")).text();
    // Should not have a bare loadManifest import (loadManifestFresh is fine)
    const importLine = source.match(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/loader["']/);
    expect(importLine).toBeTruthy();
    const imports = importLine![1]!.split(",").map(s => s.trim());
    expect(imports).toContain("loadManifestFresh");
    expect(imports).not.toContain("loadManifest");
  });
});

// ── Backward compatibility ───────────────────────────────────────

describe("backward compatibility", () => {
  test("directory with only manifest.json throws 'No ezcorp.config.ts found'", async () => {
    const { loadManifest } = await import("../extensions/loader");
    writeFileSync(join(tempDir, "manifest.json"), JSON.stringify(VALID_MANIFEST));
    // No ezcorp.config.ts

    await expect(loadManifest(tempDir)).rejects.toThrow("No ezcorp.config.ts found");
  });

  test("directory with both manifest.json and ezcorp.config.ts returns data from config", async () => {
    const { loadManifest } = await import("../extensions/loader");
    // Write manifest.json with different name
    writeFileSync(join(tempDir, "manifest.json"), JSON.stringify({ ...VALID_MANIFEST, name: "json-name" }));
    // Write ezcorp.config.ts with the real name
    await writeConfig(tempDir, VALID_MANIFEST);

    const manifest = await loadManifest(tempDir);
    expect(manifest.name).toBe("sdk-gap-ext"); // from config, not json
  });

  test("loadManifest error message mentions 'ezcorp.config.ts'", async () => {
    const { loadManifest } = await import("../extensions/loader");

    try {
      await loadManifest(tempDir);
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("ezcorp.config.ts");
      expect(msg).not.toContain("manifest.json");
    }
  });
});
