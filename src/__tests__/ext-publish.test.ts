import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { createHash } from "node:crypto";
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

const realCliControl = await import("../extensions/cli-control");
const mockGetAllSettings = mock(async (): Promise<Record<string, unknown>> => ({}));
const mockCreateListing = mock(async (_input: unknown) => ({ id: "listing-1", authorId: "user-1" }));
const mockGetListingBySlug = mock(async (_slug: string): Promise<{ id: string; authorId: string } | undefined> => undefined);
const mockCreateVersion = mock(async (..._input: unknown[]) => ({ id: "version-1" }));
const mockGetVersion = mock(async (): Promise<unknown> => undefined);
const mockUser = mock(async () => ({ id: "user-1", status: "active" }));
const mockBuild = mock(async (_directory: string): Promise<unknown> => null);
const mockArtifacts = mock(async (): Promise<Record<string, string>> => ({}));
mock.module("../db/queries/settings", () => ({ getAllSettings: mockGetAllSettings }));
mock.module("../db/queries/users", () => ({ getUserById: mockUser }));
mock.module("../db/queries/marketplace", () => ({ createListing: mockCreateListing, getListingBySlug: mockGetListingBySlug }));
mock.module("../db/queries/marketplace-versions", () => ({ createVersion: mockCreateVersion, getVersion: mockGetVersion }));
mock.module("../db/connection", () => ({ initDb: async () => {} }));
mock.module("../extensions/cli-control", () => ({ verifyCliExtension: mockBuild, getCliExtensionRunner: () => ({ collectArtifacts: mockArtifacts }) }));
afterAll(() => { mock.module("../extensions/cli-control", () => realCliControl); restoreModuleMocks(); });

describe("ezcorp ext publish immutable releases", () => {
  let tempDir: string;
  let build: Record<string, any>;
  let artifacts: Record<string, string>;
  const token = "valid-token";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "v4-publish-test-"));
    const { canonicalJson } = await import("@ezcorp/extension-contract");
    const manifest = { schemaVersion: 4, name: "test-ext", version: "1.0.0", description: "Test", author: { name: "Tests" }, permissions: {}, entrypoint: "extension.ts", tools: [] };
    const source = { "extension.ts": "throw new Error('HOST EXECUTION FORBIDDEN')", "extension.test.ts": "test('fixture', () => {})" };
    artifacts = { ...source, ".runner/extension.js": "sealed artifact" };
    build = { operationId: "build", state: "succeeded", sourceDigest: digest(canonicalJson(source)), artifactDigest: digest(canonicalJson(artifacts)), imageDigest: "image", manifest, diagnostics: [], evidence: { protocolVersion: 4, validatorVersion: "runner-v4.1", tests: [{ name: "fixture", passed: true }], discoveryDigest: digest(canonicalJson(manifest)) } };
    mockGetAllSettings.mockReset();
    mockGetAllSettings.mockImplementation(async () => ({ "publish:token:user-1": { tokenHash: digest(token) } }));
    mockBuild.mockReset(); mockBuild.mockImplementation(async () => build);
    mockArtifacts.mockReset(); mockArtifacts.mockImplementation(async () => artifacts);
    mockCreateListing.mockReset(); mockCreateListing.mockImplementation(async () => ({ id: "listing-1", authorId: "user-1" }));
    mockGetListingBySlug.mockReset(); mockGetListingBySlug.mockImplementation(async () => undefined);
    mockCreateVersion.mockReset(); mockCreateVersion.mockImplementation(async () => ({ id: "version-1" }));
    mockGetVersion.mockReset(); mockGetVersion.mockImplementation(async () => undefined);
    mockUser.mockReset(); mockUser.mockImplementation(async () => ({ id: "user-1", status: "active" }));
    writeFileSync(join(tempDir, "ezcorp.config.ts"), "throw new Error('HOST CONFIG EXECUTION FORBIDDEN')");
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));
  async function publish(options: Record<string, unknown> = {}) {
    return (await import("../extensions/sdk/publish")).publishExtension({ extDir: tempDir, token, ...options });
  }
  test("rejects missing, invalid, plaintext and malformed tokens before a build", async () => {
    for (const settings of [{}, { other: null }, { "publish:token:user-1": { token } }, { "publish:token:user-1": { tokenHash: "abc123" } }, { "publish:token:user-1": null }, { "publish:token:user-1": { tokenHash: digest("other") } }]) {
      mockGetAllSettings.mockImplementation(async () => settings);
      await expect(publish()).rejects.toThrow("Invalid publish token");
    }
    await expect(publish({ token: "" })).rejects.toThrow("No publish token");
    expect(mockBuild).not.toHaveBeenCalled();
  });
  test("test bypass and inactive publishers are rejected", async () => {
    await expect(publish({ skipTests: true })).rejects.toThrow("cannot be skipped");
    mockUser.mockImplementation(async () => ({ id: "user-1", status: "disabled" }));
    await expect(publish()).rejects.toThrow("active publisher");
    expect(mockBuild).not.toHaveBeenCalled();
  });
  test("invalid manifests and missing entrypoints fail through isolated build validation", async () => {
    build.manifest = { name: "bad" };
    await expect(publish()).rejects.toThrow();
    expect(mockCreateVersion).not.toHaveBeenCalled();
  });
  test("failed tests and corrupt runner artifacts cannot be published", async () => {
    build.state = "failed";
    await expect(publish()).rejects.toThrow("build or tests failed");
    build.state = "succeeded";
    artifacts["extension.ts"] = "changed after build";
    await expect(publish()).rejects.toThrow("artifact digest mismatch");
  });
  test("existing versions and foreign listing authors are rejected", async () => {
    mockGetListingBySlug.mockImplementation(async () => ({ id: "listing-1", authorId: "other" }));
    await expect(publish()).rejects.toThrow("listing author");
    mockGetListingBySlug.mockImplementation(async () => ({ id: "listing-1", authorId: "user-1" }));
    mockGetVersion.mockImplementation(async () => ({ id: "existing" }));
    await expect(publish()).rejects.toThrow("already published");
  });
  test("publishes immutable checked source and artifact without executing host config", async () => {
    await publish();
    expect(mockBuild).toHaveBeenCalledWith(tempDir);
    expect(mockArtifacts).toHaveBeenCalledWith(build.artifactDigest);
    expect(mockCreateListing).toHaveBeenCalledTimes(1);
    const args = mockCreateVersion.mock.calls[0]!;
    const { validatePublishedRelease } = await import("@ezcorp/extension-contract");
    const release = await validatePublishedRelease(args[4]);
    expect(release.packageChecksums["extension.ts"]).toBe(digest(artifacts["extension.ts"]!));
    expect(Object.keys(release.sourceFiles)).not.toContain(".runner/extension.js");
    expect(args[2]).toEqual(build.manifest);
  });
  test("authorization revoked during verification prevents publication", async () => {
    mockBuild.mockImplementation(async () => { mockGetAllSettings.mockImplementation(async () => ({})); return build; });
    await expect(publish()).rejects.toThrow("Invalid publish token");
    expect(mockCreateListing).not.toHaveBeenCalled();
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
