/**
 * Comprehensive coverage tests for src/extensions/installer.ts.
 *
 * Covers branches NOT tested by git-install.test.ts:
 *   - installFromLocal (all paths)
 *   - installFromGitHub (all paths, mocked fetch)
 *   - installFromGit: no-entrypoint branch
 *   - updateExtension: no semver tags, already latest, checkout fail, invalid manifest, no entrypoint
 *   - removeExtension: install-path containment (what the uninstall rm may delete)
 *   - checkForUpdates: no semver tags, tags but none newer
 *   - findManifest: nested manifest discovery (via installFromGitHub)
 */

import { test, expect, describe, beforeEach, afterEach, mock, afterAll, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { useTempProjectRoot } from "./helpers/temp-project-root";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { basename, join, resolve } from "path";
import { tmpdir } from "os";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import { configContent, writeConfig } from "./helpers/write-config";

// ── Mock DB layer (same pattern as git-install.test.ts) ──────────────

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "id", timestamps: true, generateId: () => crypto.randomUUID() });
const mockExtensions = extStore.store;

mock.module("../db/queries/extensions", () => ({
  createExtension: extStore.createExtension,
  getExtensionByName: extStore.getExtensionByName,
  updateExtension: extStore.updateExtension,
  deleteExtension: async (id: string) => {
    uninstallSteps.push("delete-row");
    return extStore.deleteExtension(id);
  },
  listExtensions: extStore.listExtensions,
}));

// Ordered log of the teardown steps an uninstall performs. The ORDER is a
// contract, not an implementation detail — see the "teardown order" describe
// near the bottom of this file.
const uninstallSteps: string[] = [];

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {
        uninstallSteps.push("reload");
      },
    }),
  },
}));

// `removeExtension` reads the `projects` table so it can allow deletes
// under `<project.path>/.ezcorp/extensions/` — where `POST /api/import/commit`
// installs. Default is "no projects registered"; the import-scoped test
// pushes a row and pops it again.
const mockProjectPaths: string[] = [];

mock.module("../db/queries/projects", () => ({
  listProjects: async () => mockProjectPaths.map((path, i) => ({ id: `p${i}`, name: `p${i}`, path })),
}));

// `installFromGitHub()` resolves its install base as the RELATIVE path
// `data/extensions` — i.e. against `process.cwd()`, which for a test IS the
// checkout. Every install below therefore left a real directory behind in
// the working tree (`data/extensions/gh-tagged/…`). Run the file from a
// throwaway root instead; `cleanup()` takes the installs with it.
const TMP_ROOT = useTempProjectRoot("installer-cov-");

afterAll(() => {
  restoreModuleMocks();
  TMP_ROOT.cleanup();
});

// Import after mocks
const {
  installFromLocal,
  installFromGitHub,
  installFromGit,
  updateExtension,
  removeExtension,
  checkForUpdates,
} = await import("../extensions/installer");

const {
  allowedInstallRoots,
  authoredExtensionsDir,
  downloadedExtensionsDir,
  isRemovableInstallPath,
  resolveInstallPath,
} = await import("../extensions/install-roots");

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

  // ── persistPath (bundled install-path portability) ──────────────────
  describe("persistPath override", () => {
    test("persists the override instead of the absolute localPath, in BOTH installPath and source", async () => {
      const extDir = join(tempBase, "portable-ext");
      await mkdir(extDir, { recursive: true });
      await writeConfig(extDir, makeManifest({ name: "portable-ext" }));
      await Bun.write(join(extDir, "index.ts"), 'console.log("hi");');

      const result = await installFromLocal(extDir, defaultPerms, true, {
        isBundled: true,
        persistPath: "docs/extensions/examples/portable-ext",
      });

      expect(result.installPath).toBe("docs/extensions/examples/portable-ext");
      expect(result.source).toBe("local:docs/extensions/examples/portable-ext");
    });

    test("still reads the manifest + computes checksums from the REAL absolute localPath", async () => {
      // The override only changes what's PERSISTED; the files read to
      // build the row must still come from the real on-disk directory.
      const extDir = join(tempBase, "portable-ext-2");
      await mkdir(extDir, { recursive: true });
      await writeConfig(extDir, makeManifest({ name: "portable-ext-2" }));
      await Bun.write(join(extDir, "index.ts"), 'console.log("hi");');

      const result = await installFromLocal(extDir, defaultPerms, true, {
        persistPath: "some/portable/path",
      });

      expect(result.manifest.checksum).toBeDefined();
      expect(result.checksumVerified).toBe(true);
    });

    test("omitting persistPath keeps the historical behavior (persists localPath verbatim)", async () => {
      const extDir = join(tempBase, "unportable-ext");
      await mkdir(extDir, { recursive: true });
      await writeConfig(extDir, makeManifest({ name: "unportable-ext" }));
      await Bun.write(join(extDir, "index.ts"), 'console.log("hi");');

      const result = await installFromLocal(extDir, defaultPerms, true);

      expect(result.installPath).toBe(extDir);
      expect(result.source).toBe(`local:${extDir}`);
    });

    test("a second install with the SAME persistPath hits the refresh-in-place branch, not a collision error", async () => {
      // Mirrors the bundled boot loop: `ensureBundledExtensions()` calls
      // `installFromLocal(resolvedPath, ..., { persistPath: entry.path })`
      // on every startup. The `source` comparison that decides "refresh in
      // place" vs. "different source, same name" must key off the PERSISTED
      // value, or a second boot from a DIFFERENT absolute localPath (e.g. a
      // different checkout, or a rebuilt container layer) would spuriously
      // collide.
      const extDir = join(tempBase, "reinstall-ext");
      await mkdir(extDir, { recursive: true });
      await writeConfig(extDir, makeManifest({ name: "reinstall-ext", version: "1.0.0" }));
      await Bun.write(join(extDir, "index.ts"), 'console.log("hi");');

      const first = await installFromLocal(extDir, defaultPerms, true, {
        isBundled: true,
        persistPath: "extensions/reinstall-ext",
      });
      expect(first.installPath).toBe("extensions/reinstall-ext");

      // A DIFFERENT absolute localPath (simulating a different checkout /
      // container root) but the SAME persistPath.
      const extDir2 = join(tempBase, "reinstall-ext-different-checkout");
      await mkdir(extDir2, { recursive: true });
      await writeConfig(extDir2, makeManifest({ name: "reinstall-ext", version: "1.0.1" }));
      await Bun.write(join(extDir2, "index.ts"), 'console.log("hi v2");');

      const second = await installFromLocal(extDir2, defaultPerms, true, {
        isBundled: true,
        persistPath: "extensions/reinstall-ext",
      });

      expect(second.installPath).toBe("extensions/reinstall-ext");
      expect(second.version).toBe("1.0.1");
      // Exactly one row exists — it was refreshed, not duplicated or
      // rejected as a collision.
      expect(mockExtensions.size).toBe(1);
    });
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
// removeExtension — install-path containment
// ═══════════════════════════════════════════════════════════════════════
//
// `removeExtension` used to `rm -rf` any relative path (so `../../etc`
// passed) and any absolute path containing the substring `/extensions/`.
// 27 of the 28 bundled extensions record a git-tracked SOURCE directory
// containing that substring (`<root>/docs/extensions/examples/<name>`,
// `<root>/extensions/<name>`), so `ezcorp ext remove <bundled-name>`
// deleted the repository's own files. The rule now is containment: delete
// iff the resolved path is strictly inside `data/extensions`,
// `<projectRoot>/.ezcorp/extensions`, or a registered project's
// `<project.path>/.ezcorp/extensions`.
//
// `TMP_ROOT` (module scope) chdir's into a throwaway project root and
// points `getProjectRoot()` at it, so the allowed roots live under a temp
// dir for this file and every assertion below is a real filesystem
// assertion.

describe("removeExtension (install-path containment)", () => {
  /** Create a directory with a marker file inside. Returns the dir. */
  async function seedDir(path: string): Promise<string> {
    await mkdir(path, { recursive: true });
    await Bun.write(join(path, "keep.txt"), "payload");
    return path;
  }

  const survives = (dir: string) => Bun.file(join(dir, "keep.txt")).exists();

  /**
   * Seed a row with `installPath`, uninstall it, and return everything
   * `console.warn` saw. Always asserts the DB row is gone — an uninstall
   * unregisters the extension whether or not it may touch the files.
   */
  async function uninstall(name: string, installPath: string | null): Promise<string[]> {
    const id = `${name}-id`;
    extStore.seed({
      id,
      name,
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath,
    });

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) =>
      warnings.push(args.join(" ")),
    );
    try {
      await removeExtension(name);
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockExtensions.has(id)).toBe(false);
    return warnings;
  }

  /** Assert the refusal was loud and named the path it kept. */
  function expectRefusalWarning(warnings: string[], installPath: string): void {
    const refusal = warnings.find((w) => w.includes(installPath));
    expect(refusal).toBeDefined();
    expect(refusal).toContain("was NOT deleted");
  }

  // ── Allowed: the roots the host itself installs into ────────────────

  test("removes a relative data/extensions/<name> install", async () => {
    const dir = await seedDir(join(TMP_ROOT.root, "data", "extensions", "rel-ext"));

    const warnings = await uninstall("rel-ext", join("data", "extensions", "rel-ext"));

    expect(await survives(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("removes an absolute <cwd>/data/extensions/<name> install", async () => {
    const dir = await seedDir(join(TMP_ROOT.root, "data", "extensions", "abs-ok-ext"));

    const warnings = await uninstall("abs-ok-ext", dir);

    expect(await survives(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("a contained path that does not exist is reported, not silently missed", async () => {
    // A relative `install_path` is resolved against the CURRENT cwd, so it
    // passes containment no matter which cwd installed it. `force: true`
    // then turns the miss into a no-op with nothing logged. The uninstall
    // must say that the directory it meant to delete was not there.
    const missing = join("data", "extensions", "never-installed");
    expect(isRemovableInstallPath(missing)).toBe(true);
    expect(existsSync(join(TMP_ROOT.root, missing))).toBe(false);

    const warnings = await uninstall("never-installed", missing);

    const notice = warnings.find((w) => w.includes(missing));
    expect(notice).toBeDefined();
    expect(notice).toContain("does not exist");
    expect(notice).toContain(join(TMP_ROOT.root, missing));
  });

  test("removes a <projectRoot>/.ezcorp/extensions/<name> install", async () => {
    const dir = await seedDir(join(TMP_ROOT.root, ".ezcorp", "extensions", "authored-ext"));

    const warnings = await uninstall("authored-ext", dir);

    expect(await survives(dir)).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("removes a <project.path>/.ezcorp/extensions/<name> install", async () => {
    // `POST /api/import/commit` installs a synthesized skill under the
    // SELECTED PROJECT's path (`projects.path`), which is not the project
    // root — in the shipped compose stack it is `/repo` against a `/app`
    // working dir. A containment rule built only from `getProjectRoot()`
    // refuses this and orphans the directory, after which re-importing
    // auto-renames to `<name>-2`.
    const projectPath = join(tempBase, "user-project");
    const dir = await seedDir(join(projectPath, ".ezcorp", "extensions", "imported-skill"));
    const outside = await seedDir(join(projectPath, "src"));
    mockProjectPaths.push(projectPath);

    let warnings: string[];
    try {
      warnings = await uninstall("imported-skill", dir);
    } finally {
      mockProjectPaths.length = 0;
    }

    expect(await survives(dir)).toBe(false);
    expect(warnings).toEqual([]);
    // Registering a project widens the rule to that project's
    // `.ezcorp/extensions` ONLY — not to the project directory at large.
    expect(await survives(outside)).toBe(true);
    expect(isRemovableInstallPath(outside, [projectPath])).toBe(false);
  });

  test("refuses a project-scoped install once its project is unregistered", async () => {
    // Same path as the test above, with `mockProjectPaths` left empty:
    // the row's directory is only removable while its project is known.
    const dir = await seedDir(
      join(tempBase, "gone-project", ".ezcorp", "extensions", "orphan-skill"),
    );

    const warnings = await uninstall("orphan-skill", dir);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, dir);
  });

  // ── Refused: everything else ────────────────────────────────────────

  test("refuses a relative path that escapes the project root", async () => {
    // `tempBase` is a sibling temp dir, so a `../<sibling>/…` relative
    // path reaches outside cwd — the exact shape the old
    // "doesn't start with / ⇒ safe" branch accepted.
    const dir = await seedDir(join(tempBase, "precious"));
    const escaping = join("..", basename(tempBase), "precious");
    expect(resolve(TMP_ROOT.root, escaping)).toBe(dir);

    const warnings = await uninstall("escaping-ext", escaping);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, escaping);
  });

  test("refuses an absolute path containing /extensions/ outside the roots", async () => {
    const dir = await seedDir(join(tempBase, "extensions", "abs-ext"));

    const warnings = await uninstall("abs-ext", dir);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, dir);
  });

  test("refuses an absolute path with no /extensions/ segment", async () => {
    const dir = await seedDir(join(tempBase, "unsafe-dir"));

    const warnings = await uninstall("unsafe-ext", dir);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, dir);
  });

  test("refuses a bundled extension's docs/extensions/examples source dir", async () => {
    // The live data-loss case: `installFromLocal` records the path it was
    // handed, so every reference extension's row points at the checkout.
    const dir = await seedDir(
      join(TMP_ROOT.root, "docs", "extensions", "examples", "scratchpad"),
    );

    const warnings = await uninstall("scratchpad", dir);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, dir);
  });

  test("refuses a bundled extension's top-level extensions/<name> source dir", async () => {
    const dir = await seedDir(join(TMP_ROOT.root, "extensions", "ez-factory"));

    const warnings = await uninstall("ez-factory", dir);

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, dir);
  });

  test("refuses data/extensions-backup (prefix, not containment)", async () => {
    const dir = await seedDir(join(TMP_ROOT.root, "data", "extensions-backup"));

    const warnings = await uninstall("backup-ext", join("data", "extensions-backup"));

    expect(await survives(dir)).toBe(true);
    expectRefusalWarning(warnings, join("data", "extensions-backup"));
  });

  // The next two assert an OUTCOME, not a clause: a row whose
  // `install_path` is an install BASE must not take the base and every
  // extension under it. Two clauses independently produce that outcome
  // (`p !== root`, and `startsWith(root + sep)` — `"/a/b"` does not start
  // with `"/a/b/"`), so no test can distinguish them; mutating out either
  // one alone leaves these green. That redundancy is deliberate, and the
  // blast radius is why: the outcome is what must never regress.
  test("keeps the data/extensions base itself, and everything under it", async () => {
    const sibling = await seedDir(join(TMP_ROOT.root, "data", "extensions", "innocent"));

    const warnings = await uninstall("root-ext", join("data", "extensions"));

    expect(await survives(sibling)).toBe(true);
    expectRefusalWarning(warnings, join("data", "extensions"));
  });

  test("keeps the .ezcorp/extensions base itself, and everything under it", async () => {
    const sibling = await seedDir(
      join(TMP_ROOT.root, ".ezcorp", "extensions", "innocent-authored"),
    );
    const root = join(TMP_ROOT.root, ".ezcorp", "extensions");

    const warnings = await uninstall("ezcorp-root-ext", root);

    expect(await survives(sibling)).toBe(true);
    expectRefusalWarning(warnings, root);
  });

  test("MCP-kind row (no installPath): no filesystem work, no warning", async () => {
    const warnings = await uninstall("mcp-ext", null);

    expect(warnings).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// uninstallExtension — the stored-data purge
// ═══════════════════════════════════════════════════════════════════════
//
// The install directory and the DATA directory are separate decisions.
// Deleting the install directory is implied by "uninstall"; deleting
// `.ezcorp/extension-data/<name>/` throws away the user's own content, so
// it happens only when the caller asks. `TMP_ROOT` puts both under a
// throwaway root, so these are real filesystem assertions.

describe("uninstallExtension (stored-data purge)", () => {
  /** Seed an install dir + a data dir for `name`; return both paths. */
  async function seedBoth(name: string): Promise<{ install: string; data: string }> {
    const install = join(TMP_ROOT.root, "data", "extensions", name);
    const data = join(TMP_ROOT.root, ".ezcorp", "extension-data", name);
    for (const dir of [install, data]) {
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "keep.txt"), "payload");
    }
    extStore.seed({
      id: `${name}-id`,
      name,
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: install,
    });
    return { install, data };
  }

  const survives = (dir: string) => Bun.file(join(dir, "keep.txt")).exists();

  test("keeps the data directory by default", async () => {
    const { install, data } = await seedBoth("keeps-data");

    const result = await removeExtension("keeps-data");

    expect(result).toEqual({ installPathRemoved: true, dataRemoved: false });
    expect(await survives(install)).toBe(false);
    // The whole point of the default: a reinstall picks this back up.
    expect(await survives(data)).toBe(true);
  });

  test("deletes the data directory with purgeData", async () => {
    const { install, data } = await seedBoth("purges-data");

    const result = await removeExtension("purges-data", { purgeData: true });

    expect(result).toEqual({ installPathRemoved: true, dataRemoved: true });
    expect(await survives(install)).toBe(false);
    expect(await survives(data)).toBe(false);
    expect(existsSync(data)).toBe(false);
  });

  test("purgeData touches only THIS extension's data directory", async () => {
    const mine = await seedBoth("purge-scoped");
    const theirs = join(TMP_ROOT.root, ".ezcorp", "extension-data", "innocent-bystander");
    await mkdir(theirs, { recursive: true });
    await Bun.write(join(theirs, "keep.txt"), "payload");

    await removeExtension("purge-scoped", { purgeData: true });

    expect(await survives(mine.data)).toBe(false);
    expect(await survives(theirs)).toBe(true);
  });

  test("purgeData on an extension with no data directory is a quiet no-op", async () => {
    const install = join(TMP_ROOT.root, "data", "extensions", "no-data-ext");
    await mkdir(install, { recursive: true });
    extStore.seed({
      id: "no-data-ext-id",
      name: "no-data-ext",
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: install,
    });

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) =>
      warnings.push(args.join(" ")),
    );
    let result: Awaited<ReturnType<typeof removeExtension>>;
    try {
      result = await removeExtension("no-data-ext", { purgeData: true });
    } finally {
      warnSpy.mockRestore();
    }

    // Nothing was there to delete, so `dataRemoved` must not claim otherwise.
    expect(result.dataRemoved).toBe(false);
    expect(warnings).toEqual([]);
  });

  test("refuses — loudly — to purge data for an escaping name", async () => {
    // Unreachable through the installer (`manifest.ts` pins names to a
    // single path segment), but the name arrives from a DB row and the
    // delete is recursive, so the refusal must exist AND be audible: the
    // user asked for the data to go and it did not.
    const escaping = join("..", "extensions", "traversal-ext");
    const victim = join(TMP_ROOT.root, ".ezcorp", "extensions", "traversal-ext");
    await mkdir(victim, { recursive: true });
    await Bun.write(join(victim, "keep.txt"), "payload");
    extStore.seed({
      id: "traversal-id",
      name: escaping,
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: null,
    });

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) =>
      warnings.push(args.join(" ")),
    );
    let result: Awaited<ReturnType<typeof removeExtension>>;
    try {
      result = await removeExtension(escaping, { purgeData: true });
    } finally {
      warnSpy.mockRestore();
    }

    expect(result.dataRemoved).toBe(false);
    expect(await survives(victim)).toBe(true);
    const refusal = warnings.find((w) => w.includes("stored data was NOT deleted"));
    expect(refusal).toBeDefined();
  });

  test("removeExtension still throws on an unknown name", async () => {
    expect(removeExtension("no-such-extension")).rejects.toThrow(
      'Extension "no-such-extension" not found',
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// uninstallExtension — teardown ORDER, and honest result flags
// ═══════════════════════════════════════════════════════════════════════

describe("uninstallExtension (teardown order)", () => {
  async function seedAndUninstall(name: string, opts: { purgeData?: boolean } = {}) {
    const installDir = join(TMP_ROOT.root, "data", "extensions", name);
    const dataDir = join(TMP_ROOT.root, ".ezcorp", "extension-data", name);
    for (const dir of [installDir, dataDir]) {
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "keep.txt"), "payload");
    }
    extStore.seed({
      id: `${name}-id`,
      name,
      source: "github:user/repo@v1.0.0",
      version: "1.0.0",
      installPath: installDir,
    });
    uninstallSteps.length = 0;
    const result = await removeExtension(name, opts);
    return { result, installDir, dataDir };
  }

  test("the row goes, THEN the registry retires it, THEN the files go", async () => {
    // Order is load-bearing in both halves.
    //
    // Row before reload: `reload()` reads the DB, so it can only drop this
    // extension once the row is gone.
    //
    // Reload before `rm`: until the reload the SUBPROCESS IS STILL LIVE, and
    // for an MCP-kind extension the data directory being deleted is the
    // sandbox's only read-write mount — a running child can re-create files
    // underneath the walk, which makes `dataRemoved: true` a claim about a
    // directory that exists again.
    const { installDir } = await seedAndUninstall("order-check", { purgeData: true });

    expect(uninstallSteps).toEqual(["delete-row", "reload"]);
    // The `rm` really did run after both, not merely get skipped.
    expect(existsSync(installDir)).toBe(false);
  });

  test("a failed rm reports `false`, and says so out loud", async () => {
    // `force: true` suppresses only ENOENT. EACCES/EPERM/EROFS reject, and
    // the rejection is swallowed so an uninstall never throws after the row
    // is gone — which is exactly why the flag must not be set optimistically.
    // A "…its files were deleted too" toast over a directory that is still
    // there is the failure this guards.
    const fsPromises = await import("node:fs/promises");
    const rmSpy = spyOn(fsPromises, "rm").mockImplementation(async () => {
      throw new Error("EACCES: permission denied");
    });
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args) =>
      warnings.push(args.join(" ")),
    );

    let result: Awaited<ReturnType<typeof removeExtension>>;
    try {
      ({ result } = await seedAndUninstall("rm-fails", { purgeData: true }));
    } finally {
      rmSpy.mockRestore();
      warnSpy.mockRestore();
    }

    expect(result!.installPathRemoved).toBe(false);
    expect(result!.dataRemoved).toBe(false);
    expect(warnings.some((w) => w.includes("failed to delete install path"))).toBe(true);
    expect(warnings.some((w) => w.includes("failed to delete stored data"))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// resolveInstallPath — bundled install-path portability
// ═══════════════════════════════════════════════════════════════════════

describe("resolveInstallPath", () => {
  test("null / undefined / empty in, null out", () => {
    expect(resolveInstallPath(null)).toBeNull();
    expect(resolveInstallPath(undefined)).toBeNull();
    expect(resolveInstallPath("")).toBeNull();
  });

  test("an already-absolute path is returned unchanged (every genuinely external install)", () => {
    expect(resolveInstallPath("/opt/elsewhere/my-ext")).toBe("/opt/elsewhere/my-ext");
    // Even one that happens to sit under the resolved root: absolute means
    // "trust it verbatim", no reconstruction attempted.
    const underRoot = join(TMP_ROOT.root, "my-ext");
    expect(resolveInstallPath(underRoot)).toBe(underRoot);
  });

  test("a relative path resolves against the DEFAULT root (getProjectRoot())", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search")).toBe(
      join(TMP_ROOT.root, "docs/extensions/examples/web-search"),
    );
    expect(resolveInstallPath("extensions/ez-factory")).toBe(
      join(TMP_ROOT.root, "extensions/ez-factory"),
    );
    expect(resolveInstallPath("packages/@ezcorp/ai-kit")).toBe(
      join(TMP_ROOT.root, "packages/@ezcorp/ai-kit"),
    );
  });

  test("an explicit root argument overrides the default", () => {
    expect(resolveInstallPath("docs/extensions/examples/web-search", "/app")).toBe(
      "/app/docs/extensions/examples/web-search",
    );
  });

  test("this is the exact reconstruction of a bundled entry's resolvedPath", () => {
    // bundled.ts computes `join(getProjectRoot(), entry.path)` to READ the
    // files and persists `entry.path` via `persistPath`. resolveInstallPath
    // must invert that exactly, from whichever root the CURRENT process
    // resolves.
    const entryPath = "docs/extensions/examples/web-search";
    const resolvedAtInstallTime = join(TMP_ROOT.root, entryPath);
    expect(resolveInstallPath(entryPath)).toBe(resolvedAtInstallTime);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// isRemovableInstallPath / allowedInstallRoots — the containment predicate
// ═══════════════════════════════════════════════════════════════════════

describe("install-path containment predicate", () => {
  test("allowedInstallRoots is the host-owned install bases, one per writer", () => {
    expect(allowedInstallRoots()).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
    ]);
    // A registered project adds ITS `.ezcorp/extensions`, appended — the
    // static two are never displaced.
    expect(allowedInstallRoots(["/srv/proj", "relative/proj"])).toEqual([
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      join("/srv/proj", ".ezcorp", "extensions"),
      // A relative `projects.path` resolves against cwd like everything else.
      join(TMP_ROOT.root, "relative/proj", ".ezcorp", "extensions"),
    ]);
  });

  test("downloadedExtensionsDir stays relative (resolved against cwd)", () => {
    expect(downloadedExtensionsDir()).toBe(join("data", "extensions"));
    expect(resolve(process.cwd(), downloadedExtensionsDir())).toBe(
      allowedInstallRoots()[0],
    );
  });

  test("authoredExtensionsDir is `<root>/.ezcorp/extensions`", () => {
    expect(authoredExtensionsDir("/srv/proj")).toBe(join("/srv/proj", ".ezcorp", "extensions"));
    expect(resolve(authoredExtensionsDir(TMP_ROOT.root))).toBe(allowedInstallRoots()[1]);
  });

  test("an empty install path is refused even from INSIDE a root", async () => {
    // `resolve(cwd, "")` is `cwd`. Run from inside an allowed root and a
    // blank `install_path` would resolve to a real, contained directory —
    // i.e. "delete my working directory" — without the explicit
    // empty-string guard. Asserting it from anywhere else proves nothing:
    // a cwd outside every root is refused for the ordinary reason.
    //
    // It has to be the `.ezcorp/extensions` root, not `data/extensions`:
    // that one is cwd-RELATIVE, so chdir'ing into it moves it too.
    const inside = join(TMP_ROOT.root, ".ezcorp", "extensions", "cwd-probe");
    await mkdir(inside, { recursive: true });
    const savedCwd = process.cwd();
    process.chdir(inside);
    try {
      expect(resolve(process.cwd(), "")).toBe(inside);
      expect(isRemovableInstallPath("")).toBe(false);
      expect(isRemovableInstallPath(null)).toBe(false);
      expect(isRemovableInstallPath(undefined)).toBe(false);
      // Same cwd, a non-empty path: still contained, so the guard is
      // rejecting the EMPTY value, not the location.
      expect(isRemovableInstallPath(".")).toBe(true);
    } finally {
      process.chdir(savedCwd);
    }
  });

  test("accepts installs inside either root, at any depth", () => {
    for (const p of [
      join("data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather"),
      join(TMP_ROOT.root, "data", "extensions", "weather", "nested"),
      join(".ezcorp", "extensions", "ai-kit"),
      join(TMP_ROOT.root, ".ezcorp", "extensions", "ai-kit"),
      // Traversal that lands back inside a root is fine — the rule is
      // about where the path RESOLVES, not how it is spelled.
      join("data", "extensions", "x", "..", "weather"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(true);
    }
  });

  test("a registered project's .ezcorp/extensions is accepted, its siblings are not", () => {
    const projectPath = join(tempBase, "proj");
    const roots = [projectPath];

    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"), roots)).toBe(
      true,
    );
    // Base itself, a sibling tree, and the project dir at large stay out.
    for (const p of [
      join(projectPath, ".ezcorp", "extensions"),
      join(projectPath, ".ezcorp", "extension-data", "skill"),
      join(projectPath, "src"),
      projectPath,
    ]) {
      expect(isRemovableInstallPath(p, roots)).toBe(false);
    }
    // …and without the project registered, nothing under it is removable.
    expect(isRemovableInstallPath(join(projectPath, ".ezcorp", "extensions", "skill"))).toBe(false);
  });

  test("refuses every bundled-extension install path shape", () => {
    // The 28 bundled entries resolve to `join(getProjectRoot(), entry.path)`.
    for (const relPath of [
      "docs/extensions/examples/scratchpad",
      "docs/extensions/examples/task-tracking",
      "extensions/ez-factory",
      "extensions/lessons-distiller",
      "extensions/memory-extractor",
      "packages/@ezcorp/ai-kit",
    ]) {
      expect(isRemovableInstallPath(join(TMP_ROOT.root, relPath))).toBe(false);
      expect(isRemovableInstallPath(relPath)).toBe(false);
    }
  });

  test("refuses escapes, near-misses and the roots themselves", () => {
    for (const p of [
      "../../etc",
      "/etc",
      "/home/user/extensions/notes",
      "/var/lib/extensions/",
      join("data", "extensions-backup", "weather"),
      join("data", "extensions"),
      join(TMP_ROOT.root, "data", "extensions"),
      join(TMP_ROOT.root, ".ezcorp", "extensions"),
      // Resolves back OUT of the root.
      join("data", "extensions", "..", "..", "etc"),
    ]) {
      expect(isRemovableInstallPath(p)).toBe(false);
    }
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
