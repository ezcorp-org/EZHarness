import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, restoreFetch } from "./helpers/test-pglite";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { configContent } from "./helpers/write-config";

// Must be called before importing modules that use db/connection
mockDbConnection();

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
});

import {
  // Phase 6 deletes the dead `checkPermission` boolean helper. PDP unit
  // coverage lives in `permission-engine.test.ts`; this file keeps the
  // remaining helpers (diff, getRequired, sensitive-confirmation).
  getRequiredPermissions,
  diffPermissions,
  isSensitiveOperation,
  checkSensitiveConfirmation,
  setSensitiveAlwaysAllow,
} from "../extensions/permissions";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import { installFromLocal } from "../extensions/installer";
import { validateManifestV2 as validateManifest } from "../extensions/manifest";

// ── Setup ───────────────────────────────────────────────────────────

beforeAll(async () => {
  restoreFetch();
  mockDbConnection();
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test" },
    entrypoint: "./index.ts",
    tools: [
      {
        name: "my-tool",
        description: "Does something",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════
// 1. permissions.ts
// ════════════════════════════════════════════════════════════════════
//
// `checkPermission` (the dead sync boolean helper) was removed in
// Phase 6 — PDP coverage lives in `permission-engine.test.ts` and the
// boolean-shape edge cases (network/filesystem/shell/env subset
// matching) are exercised through the engine's `firstMissingCapability`
// + `capabilityCovers` unit tests in the same file.

// ── getRequiredPermissions ──────────────────────────────────────────

describe("getRequiredPermissions", () => {
  test("returns empty array for manifest with empty permissions", () => {
    const manifest = makeManifest({ permissions: {} });
    expect(getRequiredPermissions(manifest)).toEqual([]);
  });

  test("lists all network domains", () => {
    const manifest = makeManifest({
      permissions: { network: ["a.com", "b.com", "c.com"] },
    });
    const items = getRequiredPermissions(manifest);
    const networkItems = items.filter((i) => i.type === "network");
    expect(networkItems).toHaveLength(3);
    expect(networkItems.map((i) => i.value)).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("lists all filesystem paths", () => {
    const manifest = makeManifest({
      permissions: { filesystem: ["/tmp", "/home/user"] },
    });
    const items = getRequiredPermissions(manifest);
    const fsItems = items.filter((i) => i.type === "filesystem");
    expect(fsItems).toHaveLength(2);
    expect(fsItems.map((i) => i.value)).toEqual(["/tmp", "/home/user"]);
  });

  test("lists shell permission", () => {
    const manifest = makeManifest({ permissions: { shell: true } });
    const items = getRequiredPermissions(manifest);
    const shellItems = items.filter((i) => i.type === "shell");
    expect(shellItems).toHaveLength(1);
    expect(shellItems[0]!.value).toBe(true);
  });

  test("lists all env vars", () => {
    const manifest = makeManifest({
      permissions: { env: ["TOKEN", "SECRET", "HOME"] },
    });
    const items = getRequiredPermissions(manifest);
    const envItems = items.filter((i) => i.type === "env");
    expect(envItems).toHaveLength(3);
    expect(envItems.map((i) => i.value)).toEqual(["TOKEN", "SECRET", "HOME"]);
  });

  test("returns correct descriptions for each type", () => {
    const manifest = makeManifest({
      permissions: {
        network: ["api.example.com"],
        filesystem: ["/tmp"],
        shell: true,
        env: ["MY_VAR"],
      },
    });
    const items = getRequiredPermissions(manifest);
    expect(items.find((i) => i.type === "network")!.description).toBe("Network access to api.example.com");
    expect(items.find((i) => i.type === "filesystem")!.description).toBe("Filesystem access to /tmp");
    expect(items.find((i) => i.type === "shell")!.description).toBe("Execute shell commands");
    expect(items.find((i) => i.type === "env")!.description).toBe("Read environment variable MY_VAR");
  });

  test("handles manifest with all permission types", () => {
    const manifest = makeManifest({
      permissions: {
        network: ["x.com"],
        filesystem: ["/data"],
        shell: true,
        env: ["KEY"],
      },
    });
    const items = getRequiredPermissions(manifest);
    const types = new Set(items.map((i) => i.type));
    expect(types).toEqual(new Set(["network", "filesystem", "shell", "env"]));
    expect(items).toHaveLength(4);
  });
});

// ── diffPermissions ─────────────────────────────────────────────────

describe("diffPermissions", () => {
  test("returns empty diff when all permissions already granted", () => {
    const perms: ExtensionPermissions = {
      network: ["a.com"],
      filesystem: ["/tmp"],
      shell: true,
      env: ["KEY"],
      grantedAt: {},
    };
    const diff = diffPermissions(perms, perms);
    expect(diff.network).toBeUndefined();
    expect(diff.filesystem).toBeUndefined();
    expect(diff.shell).toBeUndefined();
    expect(diff.env).toBeUndefined();
  });

  test("returns ungranted network domains", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com", "c.com"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com", "c.com"]);
  });

  test("returns ungranted filesystem paths", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["/tmp", "/home", "/etc"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      filesystem: ["/tmp"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.filesystem).toEqual(["/home", "/etc"]);
  });

  test("returns shell if not yet granted", () => {
    const requested: ExtensionPermissions = { shell: true, grantedAt: {} };
    const granted: ExtensionPermissions = { grantedAt: {} };
    const diff = diffPermissions(requested, granted);
    expect(diff.shell).toBe(true);
  });

  test("returns ungranted env vars", () => {
    const requested: ExtensionPermissions = {
      env: ["A", "B", "C"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      env: ["B"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.env).toEqual(["A", "C"]);
  });

  test("handles mix of granted and ungranted", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com"],
      filesystem: ["/tmp", "/data"],
      shell: true,
      env: ["X", "Y"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      filesystem: ["/tmp"],
      shell: true,
      env: ["X"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com"]);
    expect(diff.filesystem).toEqual(["/data"]);
    expect(diff.shell).toBeUndefined(); // shell already granted
    expect(diff.env).toEqual(["Y"]);
  });
});

// ── isSensitiveOperation ────────────────────────────────────────────

describe("isSensitiveOperation", () => {
  test('returns true for "shell"', () => {
    expect(isSensitiveOperation("shell")).toBe(true);
  });

  test('returns true for "filesystem"', () => {
    expect(isSensitiveOperation("filesystem")).toBe(true);
  });
});

// ── checkSensitiveConfirmation & setSensitiveAlwaysAllow ────────────

describe("checkSensitiveConfirmation and setSensitiveAlwaysAllow", () => {
  test('returns "needs_confirmation" by default', async () => {
    const result = await checkSensitiveConfirmation("comprehensive-ext-1", "shell");
    expect(result).toBe("needs_confirmation");
  });

  test('returns "allowed" after setSensitiveAlwaysAllow(true)', async () => {
    await setSensitiveAlwaysAllow("comprehensive-ext-2", "shell", true);
    const result = await checkSensitiveConfirmation("comprehensive-ext-2", "shell");
    expect(result).toBe("allowed");
  });

  test('returns "needs_confirmation" after setSensitiveAlwaysAllow(false)', async () => {
    await setSensitiveAlwaysAllow("comprehensive-ext-3", "filesystem", true);
    await setSensitiveAlwaysAllow("comprehensive-ext-3", "filesystem", false);
    const result = await checkSensitiveConfirmation("comprehensive-ext-3", "filesystem");
    expect(result).toBe("needs_confirmation");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. validateManifestV2
// ════════════════════════════════════════════════════════════════════

describe("validateManifest (v2)", () => {
  const validManifest = {
    schemaVersion: 2,
    name: "my-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test" },
    entrypoint: "./index.ts",
    tools: [
      { name: "tool1", description: "A tool", inputSchema: { type: "object" } },
    ],
    permissions: {},
  };

  test("valid manifest passes", () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing name fails", () => {
    const { name, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
  });

  test("missing version fails", () => {
    const { version, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("version"))).toBe(true);
  });

  test("tools with missing entrypoint fails", () => {
    const { entrypoint, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("entrypoint"))).toBe(true);
  });

  test("tool without name fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ description: "A tool", inputSchema: { type: "object" } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("name"))).toBe(true);
  });

  test("tool without description fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ name: "tool1", inputSchema: { type: "object" } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("description"))).toBe(true);
  });

  test("tool without inputSchema fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ name: "tool1", description: "A tool" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("inputSchema"))).toBe(true);
  });

  test("null manifest fails", () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("undefined manifest fails", () => {
    const result = validateManifest(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("non-object manifest fails", () => {
    const result = validateManifest("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("non-object tool element fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: ["not an object"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("must be an object"))).toBe(true);
  });

  test("multiple errors accumulated", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("version"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("schemaVersion"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("description"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. installer.ts — installFromLocal
// ════════════════════════════════════════════════════════════════════

describe("installFromLocal", () => {
  test("successfully installs from local path with valid manifest", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-local-test-"));
    try {
      const manifest = makeManifest({ name: `local-install-${Date.now()}` });
      await Bun.write(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
      await Bun.write(join(tempDir, "index.ts"), "export default {}");

      const permissions: ExtensionPermissions = { grantedAt: {} };
      const ext = await installFromLocal(tempDir, permissions);

      expect(ext.name).toBe(manifest.name);
      expect(ext.version).toBe("1.0.0");
      expect(ext.enabled).toBe(false); // Extensions default to disabled without explicit approval
      expect(ext.source).toBe(`local:${tempDir}`);
      expect(ext.installPath).toBe(tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("throws when ezcorp.config.ts not found", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-nomanifest-"));
    try {
      const permissions: ExtensionPermissions = { grantedAt: {} };
      await expect(installFromLocal(tempDir, permissions)).rejects.toThrow("No ezcorp.config.ts found");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("throws when manifest is invalid", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-badmanifest-"));
    try {
      // Manifest missing required fields
      await Bun.write(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify({ description: "incomplete" })};\n`);

      const permissions: ExtensionPermissions = { grantedAt: {} };
      await expect(installFromLocal(tempDir, permissions)).rejects.toThrow("Invalid manifest");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("computes and stores checksum", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-checksum-"));
    try {
      const manifest = makeManifest({ name: `checksum-test-${Date.now()}` });
      await Bun.write(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
      await Bun.write(join(tempDir, "index.ts"), "console.log('hello')");

      const permissions: ExtensionPermissions = { grantedAt: {} };
      const ext = await installFromLocal(tempDir, permissions);

      // The manifest stored in the DB should have a checksum
      expect(ext.manifest).toBeDefined();
      expect((ext.manifest as any).checksum).toBeDefined();
      expect(typeof (ext.manifest as any).checksum).toBe("string");
      expect((ext.manifest as any).checksum.length).toBe(64); // SHA-256 hex
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("stores correct source format", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-source-"));
    try {
      const manifest = makeManifest({ name: `source-test-${Date.now()}` });
      await Bun.write(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
      await Bun.write(join(tempDir, "index.ts"), "export default {}");

      const permissions: ExtensionPermissions = { grantedAt: {} };
      const ext = await installFromLocal(tempDir, permissions);

      expect(ext.source).toBe(`local:${tempDir}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. installer.ts — installFromGitHub (mocked fetch)
// ════════════════════════════════════════════════════════════════════

describe("installFromGitHub", () => {
  // We need to dynamically import installFromGitHub so our fetch mock is in place
  const { installFromGitHub } = require("../extensions/installer");

  test("successfully installs from mocked GitHub release", async () => {
    // Create a temp dir with a valid tarball containing ezcorp.config.ts + entrypoint
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-ok-"));
    try {
      const contentDir = join(tempDir, "ext-content");
      await Bun.write(join(contentDir, "ezcorp.config.ts"), configContent(
        makeManifest({ name: `gh-install-${Date.now()}` }),
      ));
      await Bun.write(join(contentDir, "index.ts"), "export default {}");

      // Create a tarball from the content
      const tarPath = join(tempDir, "release.tar.gz");
      const tarProc = Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
      expect(tarProc.exitCode).toBe(0);

      const tarBytes = await Bun.file(tarPath).arrayBuffer();

      const originalFetch = globalThis.fetch;
      const mockFetch = async (input: any, _init?: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify({
            tag_name: "v1.0.0",
            assets: [{ name: "release.tar.gz", browser_download_url: "https://fake.example.com/release.tar.gz" }],
          }), { status: 200 });
        }
        if (url.includes("fake.example.com")) {
          return new Response(tarBytes, { status: 200 });
        }
        return originalFetch(input, _init);
      };
      globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

      try {
        const permissions: ExtensionPermissions = { grantedAt: {} };
        const ext = await installFromGitHub("testuser/testrepo", permissions);
        expect(ext.name).toBeDefined();
        expect(ext.source).toContain("github:");
        expect(ext.source).toContain("v1.0.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("handles @tag syntax in repo spec", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-tag-"));
    try {
      const contentDir = join(tempDir, "ext-content");
      await Bun.write(join(contentDir, "ezcorp.config.ts"), configContent(
        makeManifest({ name: `gh-tag-${Date.now()}` }),
      ));
      await Bun.write(join(contentDir, "index.ts"), "export default {}");

      const tarPath = join(tempDir, "release.tar.gz");
      Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
      const tarBytes = await Bun.file(tarPath).arrayBuffer();

      const originalFetch = globalThis.fetch;
      let capturedUrl = "";
      const mockFetch = async (input: any, _init?: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("api.github.com")) {
          capturedUrl = url;
          return new Response(JSON.stringify({
            tag_name: "v2.0.0",
            assets: [{ name: "release.tar.gz", browser_download_url: "https://fake.example.com/release.tar.gz" }],
          }), { status: 200 });
        }
        if (url.includes("fake.example.com")) {
          return new Response(tarBytes, { status: 200 });
        }
        return originalFetch(input, _init);
      };
      globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

      try {
        const permissions: ExtensionPermissions = { grantedAt: {} };
        await installFromGitHub("testuser/testrepo@v2.0.0", permissions);
        // The URL should use the tag-specific endpoint
        expect(capturedUrl).toContain("/releases/tags/v2.0.0");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("throws on checksum mismatch", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-checksum-"));
    try {
      const contentDir = join(tempDir, "ext-content");
      // Manifest with a wrong checksum
      const manifest = makeManifest({ name: `gh-bad-checksum-${Date.now()}` });
      (manifest as any).checksum = "0000000000000000000000000000000000000000000000000000000000000000";
      await Bun.write(join(contentDir, "ezcorp.config.ts"), configContent(manifest));
      await Bun.write(join(contentDir, "index.ts"), "export default {}");

      const tarPath = join(tempDir, "release.tar.gz");
      Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
      const tarBytes = await Bun.file(tarPath).arrayBuffer();

      const originalFetch = globalThis.fetch;
      const mockFetch = async (input: any, _init?: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify({
            tag_name: "v1.0.0",
            assets: [{ name: "release.tar.gz", browser_download_url: "https://fake.example.com/release.tar.gz" }],
          }), { status: 200 });
        }
        if (url.includes("fake.example.com")) {
          return new Response(tarBytes, { status: 200 });
        }
        return originalFetch(input, _init);
      };
      globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

      try {
        const permissions: ExtensionPermissions = { grantedAt: {} };
        await expect(installFromGitHub("testuser/testrepo", permissions)).rejects.toThrow("Checksum mismatch");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("throws when no tarball found in release", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = async (input: any, _init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({
          tag_name: "v1.0.0",
          assets: [], // no assets
          // no tarball_url either
        }), { status: 200 });
      }
      return originalFetch(input, _init);
    };
    globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

    try {
      const permissions: ExtensionPermissions = { grantedAt: {} };
      await expect(installFromGitHub("testuser/testrepo", permissions)).rejects.toThrow("No tarball found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when ezcorp.config.ts not found in extracted tarball", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "ext-gh-nomanifest-"));
    try {
      const contentDir = join(tempDir, "ext-content");
      // No ezcorp.config.ts, just a random file
      await Bun.write(join(contentDir, "README.md"), "# Hello");

      const tarPath = join(tempDir, "release.tar.gz");
      Bun.spawnSync(["tar", "-czf", tarPath, "-C", tempDir, "ext-content"]);
      const tarBytes = await Bun.file(tarPath).arrayBuffer();

      const originalFetch = globalThis.fetch;
      const mockFetch = async (input: any, _init?: any) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify({
            tag_name: "v1.0.0",
            assets: [{ name: "release.tar.gz", browser_download_url: "https://fake.example.com/release.tar.gz" }],
          }), { status: 200 });
        }
        if (url.includes("fake.example.com")) {
          return new Response(tarBytes, { status: 200 });
        }
        return originalFetch(input, _init);
      };
      globalThis.fetch = Object.assign(mockFetch, { preconnect: originalFetch.preconnect }) as typeof fetch;

      try {
        const permissions: ExtensionPermissions = { grantedAt: {} };
        await expect(installFromGitHub("testuser/testrepo", permissions)).rejects.toThrow("No ezcorp.config.ts found");
      } finally {
        globalThis.fetch = originalFetch;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
