/**
 * Gap coverage: installFromGit, installFromGitHub, updateExtension
 * with loadManifest (ezcorp.config.ts) — handler stripping, nested
 * manifest discovery, and re-validation after update.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import { configContent, writeConfig } from "./helpers/write-config";

// ── Mock DB layer ──────────────────────────────────────────────────

const mockExtensions = new Map<string, any>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = { id: crypto.randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() };
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
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ reload: async () => {} }) },
}));

afterAll(() => restoreModuleMocks());

const { installFromGit, installFromGitHub, updateExtension } = await import("../extensions/installer");

// ── Helpers ────────────────────────────────────────────────────────

const env = { ...process.env };
const spawn = (cmd: string[], opts?: { cwd?: string }) => Bun.spawnSync(cmd, { ...opts, env });

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "gap-test-ext",
    version: "1.0.0",
    description: "Gap test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: {},
    ...overrides,
  };
}

const defaultPerms: ExtensionPermissions = { network: [], grantedAt: { network: Date.now() } };

let tempBase: string;

beforeAll(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "installer-gaps-"));
});

afterAll(async () => {
  await rm(tempBase, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => mockExtensions.clear());

/** Create a bare git repo with a config and entrypoint, return bare repo path. */
async function createBareRepo(
  name: string,
  configTs: string,
  entrypointContent = 'console.log("ext");',
): Promise<string> {
  const bareDir = join(tempBase, `${name}.git`);
  const workDir = join(tempBase, `${name}-work`);
  spawn(["git", "init", "--bare", bareDir]);
  spawn(["git", "clone", bareDir, workDir]);
  spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
  spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

  await Bun.write(join(workDir, "ezcorp.config.ts"), configTs);
  await Bun.write(join(workDir, "index.ts"), entrypointContent);
  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "init"], { cwd: workDir });
  spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });
  return bareDir;
}

// ═══════════════════════════════════════════════════════════════════
// installFromGit + loadManifest
// ═══════════════════════════════════════════════════════════════════

describe("installFromGit + loadManifest gaps", () => {
  const installDir = () => join(tempBase, `ext-install-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);

  test("loads ezcorp.config.ts from cloned repo successfully", async () => {
    const manifest = makeManifest({ name: "git-load-ok" });
    const bareDir = await createBareRepo("git-load-ok", configContent(manifest));
    const dir = installDir();
    await mkdir(dir, { recursive: true });

    const result = await installFromGit(`file://${bareDir}`, defaultPerms, { extensionsDir: dir });

    expect(result.name).toBe("git-load-ok");
    expect(result.version).toBe("1.0.0");
    // Phase 1: loadManifest auto-promotes v2 to v3.
    expect(result.manifest.schemaVersion).toBe(3);
    expect((result.manifest as { _inheritedFromV2?: boolean })._inheritedFromV2).toBe(true);
  });

  test("fails with clear error when cloned repo has no ezcorp.config.ts", async () => {
    const bareDir = join(tempBase, "no-config.git");
    const workDir = join(tempBase, "no-config-work");
    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });
    await Bun.write(join(workDir, "readme.md"), "no config here");
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "no config"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD"], { cwd: workDir });

    const dir = installDir();
    await mkdir(dir, { recursive: true });

    await expect(
      installFromGit(`file://${bareDir}`, defaultPerms, { extensionsDir: dir }),
    ).rejects.toThrow(/No ezcorp\.config\.ts/);
  });

  test("strips handler functions from manifest before DB storage", async () => {
    // Write a config that has handler functions on tools
    const configWithHandlers = `export default {
  schemaVersion: 2,
  name: "handler-strip-test",
  version: "1.0.0",
  description: "Tests handler stripping",
  author: { name: "Tester" },
  entrypoint: "index.ts",
  tools: [{
    name: "my-tool",
    description: "A tool",
    inputSchema: { type: "object" },
    handler: async () => ({ result: "hi" }),
  }],
  permissions: {},
};\n`;

    const bareDir = await createBareRepo("handler-strip", configWithHandlers);
    const dir = installDir();
    await mkdir(dir, { recursive: true });

    const result = await installFromGit(`file://${bareDir}`, defaultPerms, { extensionsDir: dir });

    expect(result.name).toBe("handler-strip-test");
    // Handler should be stripped — not present in stored manifest
    const tool = result.manifest.tools![0] as unknown as Record<string, unknown>;
    expect(tool.handler).toBeUndefined();
    expect(tool.name).toBe("my-tool");
    expect(tool.description).toBe("A tool");
  });
});

// ═══════════════════════════════════════════════════════════════════
// installFromGitHub + findManifest
// ═══════════════════════════════════════════════════════════════════

describe("installFromGitHub + findManifest gaps", () => {
  const originalFetch = globalThis.fetch;

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  async function createTarball(rootName: string, nestedPath: string, manifest: ExtensionManifestV2, entryContent: string): Promise<string> {
    const srcDir = join(tempBase, "tar-src-gaps", rootName, ...nestedPath.split("/").filter(Boolean));
    await mkdir(srcDir, { recursive: true });
    await writeConfig(srcDir, manifest);
    if (manifest.entrypoint) {
      await Bun.write(join(srcDir, manifest.entrypoint), entryContent);
    }
    const tarPath = join(tempBase, `${rootName}.tar.gz`);
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-src-gaps"), rootName]);
    return tarPath;
  }

  function mockGitHubFetch(tarballPath: string) {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes("api.github.com")) {
        return {
          ok: true,
          statusText: "OK",
          json: async () => ({
            tag_name: "v1.0.0",
            assets: [{ name: "release.tar.gz", browser_download_url: "https://example.com/release.tar.gz" }],
          }),
        } as Response;
      }
      const buf = await Bun.file(tarballPath).arrayBuffer();
      return { ok: true, statusText: "OK", arrayBuffer: async () => buf } as Response;
    }) as typeof fetch;
  }

  test("findManifest locates ezcorp.config.ts in nested directory", async () => {
    const manifest = makeManifest({ name: "nested-find" });
    const tarPath = await createTarball("nested-pkg", "sub/deep", manifest, 'console.log("nested");');
    mockGitHubFetch(tarPath);

    const result = await installFromGitHub("testuser/nested-repo@v1.0.0", defaultPerms);

    expect(result.name).toBe("nested-find");
    expect(result.version).toBe("1.0.0");
  });

  test("fails when no ezcorp.config.ts in extracted content", async () => {
    // Create tarball with no config
    const srcDir = join(tempBase, "tar-src-gaps", "no-config-pkg", "stuff");
    await mkdir(srcDir, { recursive: true });
    await Bun.write(join(srcDir, "readme.md"), "no config");
    const tarPath = join(tempBase, "no-config-pkg.tar.gz");
    Bun.spawnSync(["tar", "-czf", tarPath, "-C", join(tempBase, "tar-src-gaps"), "no-config-pkg"]);
    mockGitHubFetch(tarPath);

    await expect(
      installFromGitHub("testuser/no-config-repo@v1.0.0", defaultPerms),
    ).rejects.toThrow(/No ezcorp\.config\.ts found/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// updateExtension + loadManifest
// ═══════════════════════════════════════════════════════════════════

describe("updateExtension + loadManifest gaps", () => {
  test("re-validates manifest after git checkout succeeds", async () => {
    const bareDir = join(tempBase, "update-revalidate.git");
    const workDir = join(tempBase, "update-revalidate-work");
    const dir = join(tempBase, "ext-update-revalidate");
    await mkdir(dir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    // v1.0.0
    const m1 = makeManifest({ name: "revalidate-ext", version: "1.0.0" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(m1));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // v2.0.0 — valid manifest with updated version
    const m2 = makeManifest({ name: "revalidate-ext", version: "2.0.0", description: "Updated" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(m2));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v2");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v2.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v2.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    // Install v1
    await installFromGit(`file://${bareDir}@v1.0.0`, defaultPerms, { extensionsDir: dir });

    // Update should succeed and pick up v2
    const result = await updateExtension("revalidate-ext");
    expect(result.from).toBe("1.0.0");
    expect(result.to).toBe("2.0.0");
  });

  test("fails if updated manifest is invalid", async () => {
    const bareDir = join(tempBase, "update-invalid.git");
    const workDir = join(tempBase, "update-invalid-work");
    const dir = join(tempBase, "ext-update-invalid");
    await mkdir(dir, { recursive: true });

    spawn(["git", "init", "--bare", bareDir]);
    spawn(["git", "clone", bareDir, workDir]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
    spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

    // v1.0.0 — valid
    const m1 = makeManifest({ name: "update-invalid-ext", version: "1.0.0" });
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(m1));
    await Bun.write(join(workDir, "index.ts"), 'console.log("v1");');
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
    spawn(["git", "tag", "v1.0.0"], { cwd: workDir });

    // v2.0.0 — invalid (missing required fields)
    await Bun.write(join(workDir, "ezcorp.config.ts"), configContent({ schemaVersion: 2, name: "update-invalid-ext" }));
    spawn(["git", "add", "."], { cwd: workDir });
    spawn(["git", "commit", "-m", "v2.0.0 bad"], { cwd: workDir });
    spawn(["git", "tag", "v2.0.0"], { cwd: workDir });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

    // Install v1
    await installFromGit(`file://${bareDir}@v1.0.0`, defaultPerms, { extensionsDir: dir });

    await expect(updateExtension("update-invalid-ext")).rejects.toThrow(/Invalid manifest/);
  });
});
