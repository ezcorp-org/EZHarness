import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { computePackageChecksums } from "../extensions/checksum";

// ── Mocks ────────────────────────────────────────────────────────

let disableExtensionCalls: string[] = [];

mock.module("../db/queries/extensions", () => ({
  disableExtension: async (id: string) => {
    disableExtensionCalls.push(id);
  },
  listExtensions: async () => [],
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

// denyAndDisable also calls getSetting/upsertSetting for violation history
mock.module("../db/queries/settings", () => ({
  getSetting: async () => null,
  upsertSetting: async () => {},
  getAllSettings: async () => ({}),
  deleteSetting: async () => false,
  isListingInstalled: async () => false,
}));

afterAll(() => restoreModuleMocks());

// ── Imports (after mocks) ────────────────────────────────────────

import { ExtensionRegistry } from "../extensions/registry";
import type { ExtensionManifestV2 } from "../extensions/types";

// ── Helpers ──────────────────────────────────────────────────────

let tempDir: string;

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "Test extension",
    author: { name: "Test" },
    entrypoint: "index.ts",
    tools: [],
    permissions: {},
    ...overrides,
  };
}

beforeEach(async () => {
  ExtensionRegistry.resetInstance();
  disableExtensionCalls = [];
  tempDir = await mkdtemp(join(tmpdir(), "registry-integrity-"));
  await writeFile(join(tempDir, "index.ts"), 'console.log("ext")');
});

afterEach(async () => {
  ExtensionRegistry.resetInstance();
  await rm(tempDir, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────

describe("registry integrity verification", () => {
  test("getProcess() verifies checksums on first load", async () => {
    const checksums = await computePackageChecksums(tempDir);

    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest({ packageChecksums: checksums });
    registry.setManifestForTest("ext-1", manifest);
    registry.setInstallPathForTest("ext-1", tempDir);
    registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

    // Should succeed -- checksums match, process is created
    const proc = await registry.getProcess("ext-1");
    expect(proc).toBeDefined();
    // No disable calls -- checksums matched
    expect(disableExtensionCalls).toHaveLength(0);
  });

  test("getProcess() skips verification on second call (same session)", async () => {
    const checksums = await computePackageChecksums(tempDir);

    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest({ packageChecksums: checksums });
    registry.setManifestForTest("ext-1", manifest);
    registry.setInstallPathForTest("ext-1", tempDir);
    registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

    // First call -- triggers verification
    const proc1 = await registry.getProcess("ext-1");
    proc1.kill();

    // Tamper with the file AFTER first verification
    await writeFile(join(tempDir, "index.ts"), "TAMPERED CONTENT");

    // Second call -- should NOT re-verify (verifiedSessions caches it)
    // so it succeeds despite the tampered file
    const proc2 = await registry.getProcess("ext-1");
    expect(proc2).toBeDefined();
    // No disable calls -- the tampering was not detected
    expect(disableExtensionCalls).toHaveLength(0);
  });

  test("getProcess() denies and disables on checksum mismatch", async () => {
    const checksums = await computePackageChecksums(tempDir);

    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest({ packageChecksums: checksums });
    registry.setManifestForTest("ext-bad", manifest);
    registry.setInstallPathForTest("ext-bad", tempDir);
    registry.setGrantedPermsForTest("ext-bad", { grantedAt: {} });

    // Tamper with file before first getProcess call
    await writeFile(join(tempDir, "index.ts"), "EVIL CODE");

    // Should throw due to checksum mismatch
    await expect(registry.getProcess("ext-bad")).rejects.toThrow(
      /ext-bad failed integrity check/,
    );

    // denyAndDisable should have been called
    expect(disableExtensionCalls).toEqual(["ext-bad"]);
  });

  test("reload() clears verifiedSessions, forcing re-verification", async () => {
    const checksums = await computePackageChecksums(tempDir);

    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest({ packageChecksums: checksums });
    registry.setManifestForTest("ext-1", manifest);
    registry.setInstallPathForTest("ext-1", tempDir);
    registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

    // First call -- verification succeeds
    await registry.getProcess("ext-1");

    // reload() clears verifiedSessions (and calls loadFromDb which clears maps)
    await registry.reload();

    // Kill stale process so getProcess() creates a new one
    registry.killAll();

    // Re-register the extension (loadFromDb cleared maps)
    registry.setManifestForTest("ext-1", manifest);
    registry.setInstallPathForTest("ext-1", tempDir);
    registry.setGrantedPermsForTest("ext-1", { grantedAt: {} });

    // Tamper with file -- this time verification should run again
    await writeFile(join(tempDir, "index.ts"), "TAMPERED AFTER RELOAD");

    // Should fail because reload cleared verifiedSessions and file was tampered
    await expect(registry.getProcess("ext-1")).rejects.toThrow(
      /ext-1 failed integrity check/,
    );
    expect(disableExtensionCalls).toEqual(["ext-1"]);
  });

  test("getProcess() skips verification when manifest has no packageChecksums", async () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest(); // no packageChecksums field
    registry.setManifestForTest("ext-no-checksums", manifest);
    registry.setInstallPathForTest("ext-no-checksums", tempDir);
    registry.setGrantedPermsForTest("ext-no-checksums", { grantedAt: {} });

    // Should succeed without any checksum verification
    const proc = await registry.getProcess("ext-no-checksums");
    expect(proc).toBeDefined();
    expect(disableExtensionCalls).toHaveLength(0);
  });
});
