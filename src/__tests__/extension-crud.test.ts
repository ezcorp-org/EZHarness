import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";
import { writeConfig } from "./helpers/write-config";

// ── Mock DB queries (must precede imports that touch these modules) ──
const mockExtensions = new Map<string, any>();
let createExtensionCalled: any = null;

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = { id: crypto.randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() };
    createExtensionCalled = ext;
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtension: async (id: string) => mockExtensions.get(id) ?? null,
  getExtensionByName: async () => null,
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

afterAll(() => restoreModuleMocks());

// Import AFTER mock.module so the mock is in place when modules load
const { computeChecksum, verifyChecksum } = await import("../extensions/checksum");
const { installFromLocal, installFromGitHub } = await import("../extensions/installer");
const { validateManifestV2: validateManifest } = await import("../extensions/manifest");

// ── Checksum Tests ──────────────────────────────────────────────────

describe("checksum", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ext-checksum-"));
  });

  // cleanup handled by OS temp dir

  test("computeChecksum returns SHA-256 hex string", async () => {
    const filePath = join(tempDir, "test.txt");
    await Bun.write(filePath, "hello world");
    const hash = await computeChecksum(filePath);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Known SHA-256 of "hello world"
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("verifyChecksum returns true for matching hash", async () => {
    const filePath = join(tempDir, "test2.txt");
    await Bun.write(filePath, "hello world");
    const result = await verifyChecksum(filePath, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    expect(result).toBe(true);
  });

  test("verifyChecksum returns false for mismatched hash", async () => {
    const filePath = join(tempDir, "test3.txt");
    await Bun.write(filePath, "hello world");
    const result = await verifyChecksum(filePath, "0000000000000000000000000000000000000000000000000000000000000000");
    expect(result).toBe(false);
  });
});

// ── Manifest Validation Tests ──────────────────────────────────────

describe("validateManifest (v2)", () => {
  const validManifest = {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test" },
    entrypoint: "index.ts",
    tools: [
      {
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: { network: ["api.example.com"] },
  };

  test("accepts valid manifest", () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("rejects manifest missing name", () => {
    const { name, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
  });

  test("rejects manifest missing version", () => {
    const { version, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("version"))).toBe(true);
  });

  test("rejects manifest with tools but missing entrypoint", () => {
    const { entrypoint, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("entrypoint"))).toBe(true);
  });

  test("rejects manifest with invalid tool (missing name)", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ description: "no name", inputSchema: {} }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools"))).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = validateManifest("not an object");
    expect(result.valid).toBe(false);
  });
});

// ── Local Installer Tests ───────────────────────────────────────────

describe("installFromLocal", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ext-install-"));
    createExtensionCalled = null;
    mockExtensions.clear();
  });

  test("reads manifest, validates, computes checksum, creates DB record", async () => {
    // Set up a minimal extension directory
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "local-ext",
      version: "1.0.0",
      description: "A local extension",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [{ name: "greet", description: "Say hello", inputSchema: { type: "object" } }],
      permissions: { network: ["api.example.com"] },
    };
    await writeConfig(tempDir, manifest);
    await Bun.write(join(tempDir, "index.ts"), 'console.log("hello");');

    const granted: ExtensionPermissions = {
      network: ["api.example.com"],
      grantedAt: { network: Date.now() },
    };

    const result = await installFromLocal(tempDir, granted);
    expect(result.name).toBe("local-ext");
    expect(result.source).toContain("local:");
    expect(createExtensionCalled).not.toBeNull();
    expect(createExtensionCalled.checksumVerified).toBe(true);
  });

  test("rejects if manifest is invalid", async () => {
    await writeConfig(tempDir, { bad: true });

    const granted: ExtensionPermissions = { grantedAt: {} };
    await expect(installFromLocal(tempDir, granted)).rejects.toThrow();
  });
});

// ── GitHub Installer Tests ──────────────────────────────────────────

describe("installFromGitHub", () => {
  beforeEach(() => {
    createExtensionCalled = null;
    mockExtensions.clear();
  });

  test("fetches release tarball, extracts manifest, creates DB record", async () => {
    // Create a temporary tarball with a manifest inside
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-"));
    const extDir = join(tempDir, "ext-content");
    await writeConfig(extDir, {
      schemaVersion: 2,
      name: "gh-ext",
      version: "2.0.0",
      description: "GitHub extension",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [{ name: "fetch_data", description: "Fetch data", inputSchema: { type: "object" } }],
      permissions: {},
    });
    await Bun.write(join(extDir, "index.ts"), 'console.log("github ext");');

    // Create tarball
    const tarPath = join(tempDir, "release.tar.gz");
    const proc = Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
    expect(proc.exitCode).toBe(0);

    const tarData = await Bun.file(tarPath).arrayBuffer();

    // Mock fetch to return our tarball
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: any, _init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.github.com/repos/test/repo/releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: "v2.0.0",
          assets: [{ name: "extension.tar.gz", browser_download_url: "https://example.com/release.tar.gz" }],
        }));
      }
      if (url.includes("example.com/release.tar.gz")) {
        return new Response(tarData);
      }
      return originalFetch(input, _init);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

    try {
      const granted: ExtensionPermissions = { grantedAt: {} };
      const result = await installFromGitHub("test/repo", granted);
      expect(result.name).toBe("gh-ext");
      expect(result.source).toContain("github:");
      expect(createExtensionCalled).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects if checksum mismatch", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-bad-"));
    const extDir = join(tempDir, "ext-content");
    await writeConfig(extDir, {
      schemaVersion: 2,
      name: "gh-ext-bad",
      version: "1.0.0",
      description: "Bad checksum",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [{ name: "tool", description: "Tool", inputSchema: {} }],
      permissions: {},
      checksum: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    await Bun.write(join(extDir, "index.ts"), 'console.log("bad");');

    const tarPath = join(tempDir, "release.tar.gz");
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
    const tarData = await Bun.file(tarPath).arrayBuffer();

    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: any, _init?: any) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.github.com/repos/bad/repo/releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: "v1.0.0",
          assets: [{ name: "ext.tar.gz", browser_download_url: "https://example.com/bad.tar.gz" }],
        }));
      }
      if (url.includes("example.com/bad.tar.gz")) {
        return new Response(tarData);
      }
      return originalFetch(input, _init);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

    try {
      const granted: ExtensionPermissions = { grantedAt: {} };
      await expect(installFromGitHub("bad/repo", granted)).rejects.toThrow(/checksum/i);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
