import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtempSync, rmSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readConfig, writeConfig, getPublishToken } from "../extensions/sdk/config";
import { parseArgs } from "../cli";

// ── Config Module Tests ────────────────────────────────────────

describe("config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("readConfig returns empty object when file does not exist", async () => {
    const config = await readConfig(tempDir);
    expect(config).toEqual({});
  });

  test("readConfig returns parsed config when file exists", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ publishToken: "tok123", foo: "bar" }));

    const config = await readConfig(tempDir);
    expect(config.publishToken).toBe("tok123");
    expect(config.foo).toBe("bar");
  });

  test("writeConfig creates config file with 0600 permissions", async () => {
    await writeConfig({ publishToken: "secret-token" }, tempDir);

    const configPath = join(tempDir, "config.json");
    const content = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(content.publishToken).toBe("secret-token");

    const stats = statSync(configPath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("writeConfig creates config directory if missing", async () => {
    const nestedDir = join(tempDir, "nested");
    await writeConfig({ publishToken: "test" }, nestedDir);

    expect(statSync(nestedDir).isDirectory()).toBe(true);
  });

  test("getPublishToken returns flagToken when provided", async () => {
    const token = await getPublishToken("flag-token");
    expect(token).toBe("flag-token");
  });

  test("getPublishToken reads from config when no flag provided", async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ publishToken: "config-token" }));

    const token = await getPublishToken(undefined, tempDir);
    expect(token).toBe("config-token");
  });

  test("getPublishToken returns null when no token anywhere", async () => {
    const token = await getPublishToken(undefined, tempDir);
    expect(token).toBeNull();
  });
});

// ── Publish Workflow Tests ──────────────────────────────────────

// Re-mock manifest with real validation logic to prevent leaking always-valid
// mocks from ext-dev/ext-test-runner tests (Bun mock.module is global/process-wide)
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

// Mock DB modules before importing publish
const mockGetSetting = mock(() => Promise.resolve(undefined));
const mockGetAllSettings = mock(() => Promise.resolve({}));
const mockUpsertSetting = mock(() => Promise.resolve());
const mockCreateListing = mock(() => Promise.resolve({ id: "listing-1", name: "test-ext", slug: "test-ext" }));
const mockGetListingBySlug = mock(() => Promise.resolve(undefined));
const mockCreateVersion = mock(() => Promise.resolve({ id: "ver-1" }));
const mockGetVersion = mock(() => Promise.resolve(undefined));
const mockRunExtensionTests = mock(() => Promise.resolve(0));
const mockComputePackageChecksums = mock(() => Promise.resolve({ "index.ts": "abc123" }));
const mockInitDb = mock(() => Promise.resolve());

mock.module("../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  getAllSettings: mockGetAllSettings,
  upsertSetting: mockUpsertSetting,
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
  computeChecksum: mock(() => Promise.resolve("hash")),
  verifyChecksum: mock(() => Promise.resolve(true)),
  verifyPackageChecksums: mock(() => Promise.resolve({ valid: true, mismatched: [] })),
}));

mock.module("../db/connection", () => ({
  initDb: mockInitDb,
  getDb: mock(() => ({})),
}));

afterAll(() => restoreModuleMocks());

describe("ezcorp ext publish", () => {
  let tempDir: string;

  const VALID_MANIFEST = {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test Author" },
    entrypoint: "index.ts",
    tools: [{ name: "hello", description: "Says hello", inputSchema: { type: "object" } }],
    permissions: {},
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "pi-publish-test-"));
    mockGetSetting.mockReset();
    mockGetAllSettings.mockReset();
    mockCreateListing.mockReset();
    mockGetListingBySlug.mockReset();
    mockCreateVersion.mockReset();
    mockGetVersion.mockReset();
    mockRunExtensionTests.mockReset();
    mockComputePackageChecksums.mockReset();
    mockInitDb.mockReset();

    // Default happy-path mocks
    mockGetSetting.mockImplementation(((key: string) => {
      if (key === "publish:token:user-1") return Promise.resolve({ token: "valid-token-abc", createdAt: 1 });
      return Promise.resolve(undefined);
    }) as any);
    mockGetAllSettings.mockImplementation(() => Promise.resolve({
      "publish:token:user-1": { token: "valid-token-abc", createdAt: 1 },
    }));
    mockCreateListing.mockImplementation(() => Promise.resolve({ id: "listing-1", name: "test-ext", slug: "test-ext" }));
    mockGetListingBySlug.mockImplementation(() => Promise.resolve(undefined));
    mockCreateVersion.mockImplementation(() => Promise.resolve({ id: "ver-1" }));
    mockGetVersion.mockImplementation(() => Promise.resolve(undefined));
    mockRunExtensionTests.mockImplementation(() => Promise.resolve(0));
    mockComputePackageChecksums.mockImplementation(() => Promise.resolve({ "index.ts": "abc123" }));
    mockInitDb.mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeManifest(manifest: object = VALID_MANIFEST) {
    writeFileSync(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
  }

  function writeEntrypoint(name = "index.ts") {
    writeFileSync(join(tempDir, name), 'console.log("hello")');
  }

  test("rejects if no publish token found", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest();
    writeEntrypoint();

    await expect(publishExtension({ extDir: tempDir, skipTests: true }))
      .rejects.toThrow("No publish token found");
  });

  test("rejects if manifest invalid", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeFileSync(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify({ name: "bad" })};\n`);

    await expect(publishExtension({ extDir: tempDir, token: "valid-token-abc", skipTests: true }))
      .rejects.toThrow("Invalid manifest");
  });

  test("rejects if entrypoint file missing", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest(); // has entrypoint: "index.ts" but file doesn't exist

    await expect(publishExtension({ extDir: tempDir, token: "valid-token-abc", skipTests: true }))
      .rejects.toThrow("Entrypoint file not found");
  });

  test("rejects if tests fail", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest();
    writeEntrypoint();
    mockRunExtensionTests.mockImplementation(() => Promise.resolve(1));

    await expect(publishExtension({ extDir: tempDir, token: "valid-token-abc" }))
      .rejects.toThrow("Tests failed");
  });

  test("rejects if version already published", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest();
    writeEntrypoint();
    mockGetListingBySlug.mockImplementation((() => Promise.resolve({ id: "listing-1" })) as any);
    mockGetVersion.mockImplementation((() => Promise.resolve({ id: "ver-1" })) as any);

    await expect(publishExtension({ extDir: tempDir, token: "valid-token-abc", skipTests: true }))
      .rejects.toThrow("already published");
  });

  test("creates listing and version on success", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest();
    writeEntrypoint();

    await publishExtension({ extDir: tempDir, token: "valid-token-abc", skipTests: true });

    expect(mockCreateListing).toHaveBeenCalledTimes(1);
    expect(mockCreateVersion).toHaveBeenCalledTimes(1);
  });

  test("computes and includes package checksums", async () => {
    const { publishExtension } = await import("../extensions/sdk/publish");
    writeManifest();
    writeEntrypoint();

    await publishExtension({ extDir: tempDir, token: "valid-token-abc", skipTests: true });

    expect(mockComputePackageChecksums).toHaveBeenCalledWith(tempDir);
    // createVersion should receive manifest with checksums
    const versionCall = mockCreateVersion.mock.calls[0];
    expect(versionCall).toBeDefined();
    const manifestArg = (versionCall as unknown as any[])[2] as Record<string, unknown>;
    expect(manifestArg.packageChecksums).toEqual({ "index.ts": "abc123" });
  });
});

// ── CLI Parse Tests ─────────────────────────────────────────────

describe("ext publish parseArgs", () => {
  test("parseArgs routes ext publish with --token flag", () => {
    const result = parseArgs(["ext", "publish", "--token", "abc123"]);
    expect(result.command).toBe("ext:publish");
    expect(result.token).toBe("abc123");
  });

  test("parseArgs routes ext publish without token", () => {
    const result = parseArgs(["ext", "publish"]);
    expect(result.command).toBe("ext:publish");
    expect(result.token).toBeUndefined();
  });
});
