/**
 * Comprehensive coverage tests for src/extensions/installer.ts.
 *
 * Covers branches NOT tested by git-install.test.ts:
 *   - installFromLocal (all paths)
 *   - installFromGitHub (all paths, mocked fetch)
 *   - installFromGit: no-entrypoint branch
 *   - updateExtension: no semver tags, already latest, checkout fail, invalid manifest, no entrypoint
 *   - removeExtension: path safety branches (relative, abs+extensions, abs-no-extensions)
 *   - checkForUpdates: no semver tags, tags but none newer
 *   - findManifest: nested manifest discovery (via installFromGitHub)
 */

import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import { configContent, writeConfig } from "./helpers/write-config";

// ── Mock DB layer (same pattern as git-install.test.ts) ──────────────

const mockExtensions = new Map<string, any>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExtensions.set(ext.id, ext);
    return ext;
  },
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
  deleteExtension: async (id: string) => {
    return mockExtensions.delete(id);
  },
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
}));

afterAll(() => restoreModuleMocks());

// Import after mocks
const {
  installFromLocal,
  installFromGitHub,
  installFromGit,
  updateExtension,
  removeExtension,
  checkForUpdates,
} = await import("../extensions/installer");

// ── Helpers ────────────────────────────────────────────────────────────

const defaultPerms: ExtensionPermissions = {
  network: [],
  grantedAt: { network: Date.now() },
};

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: {},
    ...overrides,
  };
}

let tempBase: string;

beforeEach(async () => {
  mockExtensions.clear();
  tempBase = await mkdtemp(join(tmpdir(), "installer-cov-"));
});

afterEach(async () => {
  await rm(tempBase, { recursive: true, force: true }).catch(() => {});
});

// ═══════════════════════════════════════════════════════════════════════
// installFromLocal
// ═══════════════════════════════════════════════════════════════════════

describe("installFromLocal", () => {
  test("success: valid manifest + entrypoint creates DB record", async () => {
    const extDir = join(tempBase, "my-local-ext");
    await mkdir(extDir, { recursive: true });
    const manifest = makeManifest({ name: "local-test" });
    await writeConfig(extDir, manifest);
    await Bun.write(join(extDir, "index.ts"), 'console.log("hi");');

    const result = await installFromLocal(extDir, defaultPerms, true);

    expect(result.name).toBe("local-test");
    expect(result.version).toBe("1.0.0");
    expect(result.source).toBe(`local:${extDir}`);
    expect(result.enabled).toBe(true);
    expect(result.checksumVerified).toBe(true);
    // Checksum should be on the manifest
    expect(result.manifest.checksum).toBeDefined();
    expect(typeof result.manifest.checksum).toBe("string");
  });

  test("failure: no ezcorp.config.ts at path", async () => {
    const extDir = join(tempBase, "no-manifest");
    await mkdir(extDir, { recursive: true });

    await expect(installFromLocal(extDir, defaultPerms)).rejects.toThrow(
      /No ezcorp\.config\.ts found/,
    );
  });

  test("failure: invalid manifest", async () => {
    const extDir = join(tempBase, "bad-manifest");
    await mkdir(extDir, { recursive: true });
    await writeConfig(extDir, { schemaVersion: 1 });

    await expect(installFromLocal(extDir, defaultPerms)).rejects.toThrow(/Invalid manifest/);
  });

  test("success: entrypoint-less (agent-kind) manifest installs cleanly", async () => {
    // Regression for the bundled-boot defect: agent-/skill-kind manifests
    // have no entrypoint by design and must install cleanly rather than
    // throwing "Cannot install extension without entrypoint" on every boot.
    const extDir = join(tempBase, "no-entrypoint");
    await mkdir(extDir, { recursive: true });
    const manifest = makeManifest({
      name: "no-ep",
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "You are a helpful assistant." },
    });
    await writeConfig(extDir, manifest);

    const result = await installFromLocal(extDir, defaultPerms, true);
    expect(result.name).toBe("no-ep");
    expect(result.enabled).toBe(true);
    // No entrypoint → no entrypoint checksum, checksumVerified false.
    expect(result.manifest.checksum).toBeUndefined();
    expect(result.checksumVerified).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// installFromGitHub
// ═══════════════════════════════════════════════════════════════════════

describe("installFromGitHub", () => {
  const originalFetch = globalThis.fetch;
  const originalSpawnSync = Bun.spawnSync;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // @ts-expect-error – restore original
    Bun.spawnSync = originalSpawnSync;
  });

  /**
   * Helper: create a real tarball from a temp dir to use in mocked fetch responses.
   */
  async function createTarball(manifest: ExtensionManifestV2, entrypointContent: string): Promise<string> {
    const srcDir = join(tempBase, "tar-src", manifest.name);
    await mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, manifest);
    if (manifest.entrypoint) {
      await Bun.write(join(srcDir, manifest.entrypoint), entrypointContent);
    }

    const tarPath = join(tempBase, "release.tar.gz");
    const result = Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-src"), manifest.name]);
    if (result.exitCode !== 0) throw new Error("Failed to create test tarball");
    return tarPath;
  }

  function mockFetchForGitHub(opts: {
    releaseOk?: boolean;
    releaseStatus?: string;
    releaseBody?: any;
    tarballOk?: boolean;
    tarballStatus?: string;
    tarballPath?: string;
  }) {
    const {
      releaseOk = true,
      releaseStatus = "OK",
      releaseBody = {},
      tarballOk = true,
      tarballStatus = "OK",
      tarballPath,
    } = opts;

    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;

      if (urlStr.includes("api.github.com/repos")) {
        return {
          ok: releaseOk,
          statusText: releaseStatus,
          json: async () => releaseBody,
        } as Response;
      }

      // Tarball download
      if (tarballPath) {
        const buf = await Bun.file(tarballPath).arrayBuffer();
        return {
          ok: tarballOk,
          statusText: tarballStatus,
          arrayBuffer: async () => buf,
        } as Response;
      }

      return {
        ok: tarballOk,
        statusText: tarballStatus,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as Response;
    }) as typeof fetch;
  }

  test("success: with tag, finds tarball asset", async () => {
    const manifest = makeManifest({ name: "gh-tagged" });
    const tarPath = await createTarball(manifest, 'console.log("hi");');

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "release.tar.gz", browser_download_url: "https://example.com/release.tar.gz" }],
        tarball_url: "https://example.com/tarball",
      },
      tarballPath: tarPath,
    });

    const result = await installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms);

    expect(result.name).toBe("gh-tagged");
    expect(result.version).toBe("1.0.0");
    expect(result.source).toContain("github:");
    expect(result.source).toContain("v1.0.0");
  });

  test("success: without tag (latest release), uses tarball_url fallback", async () => {
    const manifest = makeManifest({ name: "gh-latest" });
    const tarPath = await createTarball(manifest, 'console.log("hi");');

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v2.0.0",
        assets: [], // No .tar.gz asset → falls back to tarball_url
        tarball_url: "https://example.com/tarball",
      },
      tarballPath: tarPath,
    });

    const result = await installFromGitHub("testuser/testrepo", defaultPerms);

    expect(result.name).toBe("gh-latest");
    expect(result.source).toContain("v2.0.0");
  });

  test("failure: release fetch fails", async () => {
    mockFetchForGitHub({
      releaseOk: false,
      releaseStatus: "Not Found",
    });

    await expect(installFromGitHub("testuser/testrepo@v9.9.9", defaultPerms)).rejects.toThrow(
      /Failed to fetch release/,
    );
  });

  test("failure: no tarball in release", async () => {
    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "something.zip", browser_download_url: "https://example.com/something.zip" }],
        // No tarball_url either
      },
    });

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /No tarball found/,
    );
  });

  test("failure: tarball download fails", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.github.com")) {
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            tag_name: "v1.0.0",
            assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
          }),
        } as Response;
      }
      return { ok: false, statusText: "Server Error" } as Response;
    }) as typeof fetch;

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /Failed to download tarball/,
    );
  });

  test("failure: extract fails", async () => {
    // Return valid release but invalid tarball content (empty buffer)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.github.com")) {
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            tag_name: "v1.0.0",
            assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
          }),
        } as Response;
      }
      // Return garbage data that tar can't extract
      return {
        ok: true,
        statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode("not-a-tarball").buffer,
      } as Response;
    }) as typeof fetch;

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /Failed to extract tarball/,
    );
  });

  test("failure: no config in extracted tarball", async () => {
    // Create a tarball with no ezcorp.config.ts
    const srcDir = join(tempBase, "tar-no-manifest", "pkg");
    await mkdir(srcDir, { recursive: true });
    await Bun.write(join(srcDir, "readme.md"), "hello");
    const tarPath = join(tempBase, "no-manifest.tar.gz");
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-no-manifest"), "pkg"]);

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /No ezcorp\.config\.ts found/,
    );
  });

  test("failure: invalid manifest after extract", async () => {
    const srcDir = join(tempBase, "tar-bad-manifest", "pkg");
    await mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, { schemaVersion: 1, bad: true });
    const tarPath = join(tempBase, "bad-manifest.tar.gz");
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-bad-manifest"), "pkg"]);

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /Invalid manifest/,
    );
  });

  test("success: entrypoint-less (agent-kind) manifest installs cleanly", async () => {
    // Regression for the bundled-boot defect — agent-kind manifests have
    // no entrypoint and must install via the GitHub path too rather than
    // throwing "Cannot install extension without entrypoint".
    const manifest = makeManifest({
      name: "no-ep-gh",
      entrypoint: undefined,
      tools: undefined,
      agent: { prompt: "You are a helpful assistant." },
    });
    const srcDir = join(tempBase, "tar-no-ep", manifest.name);
    await mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, manifest);
    const tarPath = join(tempBase, "no-ep.tar.gz");
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-no-ep"), manifest.name]);

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    const result = await installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms);
    expect(result.name).toBe("no-ep-gh");
    expect(result.manifest.checksum).toBeUndefined();
    expect(result.checksumVerified).toBe(false);
  });

  test("failure: checksum mismatch", async () => {
    const manifest = makeManifest({ name: "checksum-fail", checksum: "badhash123" });
    const tarPath = await createTarball(manifest, 'console.log("mismatch");');

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    await expect(installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms)).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  test("checksumVerified is true when manifest has checksum and it matches", async () => {
    const entrypointContent = 'console.log("verified");';
    const manifest = makeManifest({ name: "checksum-ok" });

    // Compute the real checksum
    const tmpFile = join(tempBase, "tmp-ep.ts");
    await Bun.write(tmpFile, entrypointContent);
    const { computeChecksum } = await import("../extensions/checksum");
    const realChecksum = await computeChecksum(tmpFile);

    manifest.checksum = realChecksum;
    const tarPath = await createTarball(manifest, entrypointContent);

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    const result = await installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms);
    expect(result.checksumVerified).toBe(true);
  });

  test("checksumVerified is false when manifest has no checksum field", async () => {
    const manifest = makeManifest({ name: "no-checksum-field" });
    delete (manifest as any).checksum;
    const tarPath = await createTarball(manifest, 'console.log("no checksum");');

    mockFetchForGitHub({
      releaseBody: {
        tag_name: "v1.0.0",
        assets: [{ name: "r.tar.gz", browser_download_url: "https://example.com/r.tar.gz" }],
      },
      tarballPath: tarPath,
    });

    const result = await installFromGitHub("testuser/testrepo@v1.0.0", defaultPerms);
    expect(result.checksumVerified).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// installFromGit — additional branches
// ═══════════════════════════════════════════════════════════════════════

describe("installFromGit (additional branches)", () => {
  const env = { ...process.env };
  const spawn = (cmd: string[], opts?: { cwd?: string }) =>
    Bun.spawnSync(cmd, { ...opts, env });

  test("extension without entrypoint: checksum is undefined", async () => {
    const bareDir = join(tempBase, "no-ep.git");
    const workDir = join(tempBase, "no-ep-work");
    const installDir = join(tempBase, "extensions");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    // Manifest without entrypoint and without tools (valid v2 manifest)
    const manifest = makeManifest({ name: "no-ep-git", entrypoint: undefined, tools: undefined });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "init"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD"], { cwd: workDir });

    const result = await installFromGit(`file://${bareDir}`, defaultPerms, {
      extensionsDir: installDir,
    });

    expect(result.name).toBe("no-ep-git");
    expect(result.checksumVerified).toBe(false);
    // Manifest should NOT have checksum property
    expect(result.manifest.checksum).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// updateExtension — additional branches
// ═══════════════════════════════════════════════════════════════════════

describe("updateExtension (additional branches)", () => {
  const env = { ...process.env };
  const spawn = (cmd: string[], opts?: { cwd?: string }) =>
    Bun.spawnSync(cmd, { ...opts, env });

  test("throws when no semver tags found", async () => {
    // Create a repo with no tags
    const bareDir = join(tempBase, "no-tags.git");
    const workDir = join(tempBase, "no-tags-work");
    const installDir = join(tempBase, "ext-no-tags");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    const manifest = makeManifest({ name: "no-tags-ext" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "init"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD"], { cwd: workDir });

    // Install it
    await installFromGit(`file://${bareDir}`, defaultPerms, { extensionsDir: installDir });

    await expect(updateExtension("no-tags-ext")).rejects.toThrow(/No semver tags/);
  });

  test("throws when already at latest version", async () => {
    const bareDir = join(tempBase, "already-latest.git");
    const workDir = join(tempBase, "already-latest-work");
    const installDir = join(tempBase, "ext-already-latest");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    const manifest = makeManifest({ name: "latest-ext", version: "1.0.0" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    await installFromGit(`file://${bareDir}`, defaultPerms, { extensionsDir: installDir });

    await expect(updateExtension("latest-ext")).rejects.toThrow(/already at latest/);
  });

  test("throws when checkout fails", async () => {
    const bareDir = join(tempBase, "checkout-fail.git");
    const workDir = join(tempBase, "checkout-fail-work");
    const installDir = join(tempBase, "ext-checkout-fail");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    const manifest = makeManifest({ name: "checkout-fail-ext", version: "1.0.0" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // Add v2.0.0 tag pointing to a real commit BUT we will sabotage the install
    await Bun.write(join(workDir, "index.ts"), 'console.log("v2");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v2.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v2.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    // Install at v1.0.0
    const installed = await installFromGit(`file://${bareDir}@v1.0.0`, defaultPerms, {
      extensionsDir: installDir,
    });

    // Sabotage: remove .git directory from the installed extension so checkout fails
    await rm(join(installed.installPath, ".git"), { recursive: true, force: true });

    await expect(updateExtension("checkout-fail-ext")).rejects.toThrow(/Failed to checkout/);
  });

  test("throws when manifest is invalid after update", async () => {
    const bareDir = join(tempBase, "bad-update.git");
    const workDir = join(tempBase, "bad-update-work");
    const installDir = join(tempBase, "ext-bad-update");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    const manifest = makeManifest({ name: "bad-update-ext", version: "1.0.0" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // Create v2.0.0 with INVALID manifest
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent({ schemaVersion: 1 }));
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v2.0.0 bad"], { cwd: workDir });
    spawn(["git", "tag", "v2.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    await installFromGit(`file://${bareDir}@v1.0.0`, defaultPerms, { extensionsDir: installDir });

    await expect(updateExtension("bad-update-ext")).rejects.toThrow(/Invalid manifest/);
  });

  test("update with no entrypoint: checksum is undefined", async () => {
    const bareDir = join(tempBase, "update-no-ep.git");
    const workDir = join(tempBase, "update-no-ep-work");
    const installDir = join(tempBase, "ext-update-no-ep");
    await mkdir(installDir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    // v1: no entrypoint
    const manifest1 = makeManifest({
      name: "update-no-ep-ext",
      version: "1.0.0",
      entrypoint: undefined,
      tools: undefined,
    });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest1));
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // v2: still no entrypoint
    const manifest2 = makeManifest({
      name: "update-no-ep-ext",
      version: "2.0.0",
      entrypoint: undefined,
      tools: undefined,
    });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest2));
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v2.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v2.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    await installFromGit(`file://${bareDir}@v1.0.0`, defaultPerms, { extensionsDir: installDir });

    const result = await updateExtension("update-no-ep-ext");
    expect(result.from).toBe("1.0.0");
    expect(result.to).toBe("2.0.0");

    // Verify updated record has no checksum
    const updated = Array.from(mockExtensions.values()).find(
      (e: any) => e.name === "update-no-ep-ext",
    );
    expect(updated.manifest.checksum).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// removeExtension — path safety branches
// ═══════════════════════════════════════════════════════════════════════

describe("removeExtension (path safety)", () => {
  test("relative path: rm is called", async () => {
    mockExtensions.set("rel-id", {
      id: "rel-id",
      name: "rel-ext",
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: "data/extensions/rel-ext",
    });

    // Should not throw (rm will fail silently on non-existent path)
    await removeExtension("rel-ext");
    expect(mockExtensions.has("rel-id")).toBe(false);
  });

  test("absolute path WITH /extensions/: rm is called", async () => {
    const absPath = join(tempBase, "extensions", "abs-ext");
    await mkdir(absPath, { recursive: true });
    await Bun.write(join(absPath, "dummy.txt"), "test");

    mockExtensions.set("abs-ext-id", {
      id: "abs-ext-id",
      name: "abs-ext",
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: absPath,
    });

    await removeExtension("abs-ext");
    expect(mockExtensions.has("abs-ext-id")).toBe(false);

    // Verify directory was actually removed
    const exists = await Bun.file(join(absPath, "dummy.txt")).exists();
    expect(exists).toBe(false);
  });

  test("absolute path WITHOUT /extensions/: rm is NOT called (safety check)", async () => {
    const unsafePath = join(tempBase, "unsafe-dir");
    await mkdir(unsafePath, { recursive: true });
    await Bun.write(join(unsafePath, "important.txt"), "do not delete");

    mockExtensions.set("unsafe-id", {
      id: "unsafe-id",
      name: "unsafe-ext",
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: unsafePath, // Absolute, no /extensions/ in path
    });

    await removeExtension("unsafe-ext");
    expect(mockExtensions.has("unsafe-id")).toBe(false);

    // Verify directory was NOT removed
    const exists = await Bun.file(join(unsafePath, "important.txt")).exists();
    expect(exists).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// checkForUpdates — additional branches
// ═══════════════════════════════════════════════════════════════════════

describe("checkForUpdates (additional branches)", () => {
  const env = { ...process.env };
  const spawn = (cmd: string[], opts?: { cwd?: string }) =>
    Bun.spawnSync(cmd, { ...opts, env });

  test("no semver tags in remote returns { available: false }", async () => {
    // Repo with no tags at all
    const bareDir = join(tempBase, "no-semver.git");
    const workDir = join(tempBase, "no-semver-work");

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });
    await Bun.write(join(workDir, "readme.md"), "hi");
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "init"], { cwd: workDir });
    // Only non-semver tag
    spawn(["git", "tag", "latest"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    const result = await checkForUpdates({
      source: `file://${bareDir}`,
      version: "1.0.0",
    });
    expect(result.available).toBe(false);
    expect(result.latestVersion).toBeUndefined();
  });

  test("tags exist but none newer returns { available: false }", async () => {
    const bareDir = join(tempBase, "older-tags.git");
    const workDir = join(tempBase, "older-tags-work");

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });
    await Bun.write(join(workDir, "readme.md"), "hi");
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v0.9.0"], { cwd: workDir });
    spawn(["git", "tag", "v0.9.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    const result = await checkForUpdates({
      source: `file://${bareDir}`,
      version: "1.0.0", // Already ahead of any tag
    });
    expect(result.available).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// parseRepoSpec (private, tested via installFromGitHub error path)
// ═══════════════════════════════════════════════════════════════════════

describe("parseRepoSpec (via installFromGitHub)", () => {
  test("invalid repo spec (no slash) throws", async () => {
    // This should throw before even fetching
    await expect(installFromGitHub("invalidrepo", defaultPerms)).rejects.toThrow(
      /Invalid repo spec/,
    );
  });
});
