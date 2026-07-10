/**
 * Integration tests for git-based extension install, update, and remove.
 *
 * Uses local bare git repos to avoid network dependency.
 * Mocks the DB layer to isolate installer logic.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import { configContent } from "./helpers/write-config";

// ── Mock DB layer ─────────────────────────────────────────────────────

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

// Mock registry reload to no-op
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
}));

// The env-leak gate writes forensic audit rows before refusing — no live
// DB in this suite, so stub the insert (the gate treats audit failures
// as non-fatal anyway; this keeps the log clean and deterministic).
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => {},
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// Import after mocks
const { installFromGit, updateExtension, removeExtension, checkForUpdates } = await import("../extensions/installer");

// ── Test fixtures ─────────────────────────────────────────────────────

const env = { ...process.env };
const spawn = (cmd: string[], opts?: { cwd?: string }) =>
  Bun.spawnSync(cmd, { ...opts, env });

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-git-ext",
    version: "1.0.0",
    description: "A test git extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: {},
    ...overrides,
  };
}

const defaultPerms: ExtensionPermissions = {
  network: [],
  grantedAt: { network: Date.now() },
};

let tempBase: string;
let bareRepoDir: string;
let installBase: string;

// ── Setup: create bare repo with manifest + entrypoint, tagged v1.0.0 ──

beforeAll(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "git-install-test-"));
  bareRepoDir = join(tempBase, "bare.git");
  installBase = join(tempBase, "extensions");
  await mkdir(installBase, { recursive: true });

  spawn(["git", "init", "--bare", bareRepoDir]);

  const workDir = join(tempBase, "work");
  spawn(["git", "clone", bareRepoDir, workDir]);
  spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
  spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

  const manifest = makeManifest();
  await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
  await Bun.write(join(workDir, "index.ts"), 'console.log("ext");');

  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
  spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

  // Create v1.1.0 tag
  const updatedManifest = makeManifest({ version: "1.1.0" });
  await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(updatedManifest));
  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "v1.1.0"], { cwd: workDir });
  spawn(["git", "tag", "v1.1.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });
});

afterAll(async () => {
  restoreModuleMocks();
  await rm(tempBase, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  mockExtensions.clear();
  // Also clear the filesystem install dir so prior-test leftovers don't cause
  // `mv` to nest into an existing directory. The DB-mock guard doesn't fire when
  // the mock Map was just cleared but a prior test's dir remains on disk.
  await rm(installBase, { recursive: true, force: true }).catch(() => {});
  await mkdir(installBase, { recursive: true });
});

// ── Install tests ─────────────────────────────────────────────────────

describe("installFromGit", () => {
  test("installs from file:// URL", async () => {
    const result = await installFromGit(
      `file://${bareRepoDir}`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    expect(result.name).toBe("test-git-ext");
    expect(result.version).toBe("1.1.0"); // Latest commit is v1.1.0
    expect(result.source).toBe(`file://${bareRepoDir}`);
  });

  test("installs with @ref pinning", async () => {
    const result = await installFromGit(
      `file://${bareRepoDir}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    expect(result.name).toBe("test-git-ext");
    expect(result.version).toBe("1.0.0");
  });

  test("fails if ezcorp.config.ts missing", async () => {
    // Create a bare repo with no manifest
    const noManifestBare = join(tempBase, "no-manifest.git");
    spawn(["git", "init", "--bare", noManifestBare]);
    const noManifestWork = join(tempBase, "no-manifest-work");
    spawn(["git", "clone", noManifestBare, noManifestWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: noManifestWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: noManifestWork });
    await Bun.write(join(noManifestWork, "readme.md"), "hello");
    spawn(["git", "add", "."], { cwd: noManifestWork });
    spawn(["git", "commit", "-m", "no manifest"], { cwd: noManifestWork });
    spawn(["git", "push", "origin", "HEAD"], { cwd: noManifestWork });

    await expect(
      installFromGit(`file://${noManifestBare}`, defaultPerms, { extensionsDir: installBase }),
    ).rejects.toThrow(/No ezcorp\.config\.ts/);
  });

  test("fails with malformed config", async () => {
    const malformedBare = join(tempBase, "malformed-json.git");
    spawn(["git", "init", "--bare", malformedBare]);
    const malformedWork = join(tempBase, "malformed-json-work");
    spawn(["git", "clone", malformedBare, malformedWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: malformedWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: malformedWork });
    await Bun.write(join(malformedWork, "ezcorp.config.ts"), "not valid typescript!!!");
    spawn(["git", "add", "."], { cwd: malformedWork });
    spawn(["git", "commit", "-m", "malformed json"], { cwd: malformedWork });
    spawn(["git", "push", "origin", "HEAD"], { cwd: malformedWork });

    await expect(
      installFromGit(`file://${malformedBare}`, defaultPerms, { extensionsDir: installBase }),
    ).rejects.toThrow();
  });

  test("fails if manifest validation fails", async () => {
    const badManifestBare = join(tempBase, "bad-manifest.git");
    spawn(["git", "init", "--bare", badManifestBare]);
    const badManifestWork = join(tempBase, "bad-manifest-work");
    spawn(["git", "clone", badManifestBare, badManifestWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: badManifestWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: badManifestWork });
    await Bun.write(join(badManifestWork, "ezcorp.config.ts"), configContent({ schemaVersion: 1 }));
    spawn(["git", "add", "."], { cwd: badManifestWork });
    spawn(["git", "commit", "-m", "bad manifest"], { cwd: badManifestWork });
    spawn(["git", "push", "origin", "HEAD"], { cwd: badManifestWork });

    await expect(
      installFromGit(`file://${badManifestBare}`, defaultPerms, { extensionsDir: installBase }),
    ).rejects.toThrow(/Invalid manifest/);
  });

  test("fails on name collision", async () => {
    // Install first
    await installFromGit(
      `file://${bareRepoDir}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    // Try to install again (same name)
    await expect(
      installFromGit(`file://${bareRepoDir}@v1.0.0`, defaultPerms, { extensionsDir: installBase }),
    ).rejects.toThrow(/already installed/);
  });

  test("cleans up temp dir on failure", async () => {
    const badBare = join(tempBase, "cleanup-test.git");
    spawn(["git", "init", "--bare", badBare]);
    const badWork = join(tempBase, "cleanup-test-work");
    spawn(["git", "clone", badBare, badWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: badWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: badWork });
    await Bun.write(join(badWork, "ezcorp.config.ts"), configContent({ bad: true }));
    spawn(["git", "add", "."], { cwd: badWork });
    spawn(["git", "commit", "-m", "bad"], { cwd: badWork });
    spawn(["git", "push", "origin", "HEAD"], { cwd: badWork });

    try {
      await installFromGit(`file://${badBare}`, defaultPerms, { extensionsDir: installBase });
    } catch {
      // expected
    }

    // Verify no orphaned directories in extensions dir for this name
    const glob = new Bun.Glob("**/cleanup-test*");
    const orphans: string[] = [];
    for await (const path of glob.scan({ cwd: installBase })) {
      orphans.push(path);
    }
    // There should be no leftover dirs (name from bad manifest would be undefined)
    expect(orphans.length).toBe(0);
  });
});

// ── Update tests ──────────────────────────────────────────────────────

describe("checkForUpdates", () => {
  test("detects available update", async () => {
    const ext = await installFromGit(
      `file://${bareRepoDir}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    const result = await checkForUpdates(ext);
    expect(result.available).toBe(true);
    expect(result.latestVersion).toBe("1.1.0");
  });

  test("returns not available when at latest", async () => {
    const ext = await installFromGit(
      `file://${bareRepoDir}`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    const result = await checkForUpdates(ext);
    expect(result.available).toBe(false);
  });

  test("returns not available when repo has no semver tags", async () => {
    // Create a bare repo with only non-semver tags
    const noSemverBare = join(tempBase, "no-semver.git");
    spawn(["git", "init", "--bare", noSemverBare]);
    const noSemverWork = join(tempBase, "no-semver-work");
    spawn(["git", "clone", noSemverBare, noSemverWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: noSemverWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: noSemverWork });
    const m = makeManifest({ name: "no-semver-ext" });
    await Bun.write(join(noSemverWork, "ezcorp.config.ts"), configContent(m));
    await Bun.write(join(noSemverWork, "index.ts"), 'console.log("ext");');
    spawn(["git", "add", "."], { cwd: noSemverWork });
    spawn(["git", "commit", "-m", "initial"], { cwd: noSemverWork });
    spawn(["git", "tag", "latest"], { cwd: noSemverWork });
    spawn(["git", "tag", "nightly"], { cwd: noSemverWork });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: noSemverWork });

    const ext = await installFromGit(
      `file://${noSemverBare}`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    const result = await checkForUpdates(ext);
    expect(result.available).toBe(false);
    expect(result.latestVersion).toBeUndefined();
  });

  test("returns not available for local source", async () => {
    const fakeLocal = {
      source: "local:/tmp/fake",
      version: "1.0.0",
    } as any;

    const result = await checkForUpdates(fakeLocal);
    expect(result.available).toBe(false);
  });
});

describe("updateExtension", () => {
  test("updates to latest version", async () => {
    await installFromGit(
      `file://${bareRepoDir}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    const result = await updateExtension("test-git-ext");
    expect(result.from).toBe("1.0.0");
    expect(result.to).toBe("1.1.0");
  });

  test("throws if extension not found", async () => {
    await expect(updateExtension("nonexistent")).rejects.toThrow(/not found/);
  });

  test("throws when repo has no semver tags", async () => {
    // Create a bare repo with only non-semver tags
    const noSemverBare2 = join(tempBase, "no-semver-update.git");
    spawn(["git", "init", "--bare", noSemverBare2]);
    const noSemverWork2 = join(tempBase, "no-semver-update-work");
    spawn(["git", "clone", noSemverBare2, noSemverWork2]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: noSemverWork2 });
    spawn(["git", "config", "user.name", "Test"], { cwd: noSemverWork2 });
    const m = makeManifest({ name: "no-semver-update-ext" });
    await Bun.write(join(noSemverWork2, "ezcorp.config.ts"), configContent(m));
    await Bun.write(join(noSemverWork2, "index.ts"), 'console.log("ext");');
    spawn(["git", "add", "."], { cwd: noSemverWork2 });
    spawn(["git", "commit", "-m", "initial"], { cwd: noSemverWork2 });
    spawn(["git", "tag", "latest"], { cwd: noSemverWork2 });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: noSemverWork2 });

    await installFromGit(
      `file://${noSemverBare2}`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    await expect(updateExtension("no-semver-update-ext")).rejects.toThrow(/No semver tags/);
  });

  test("throws on invalid manifest after checkout to new version", async () => {
    // Create a bare repo: v1.0.0 valid, v2.0.0 has invalid manifest
    const badUpdateBare = join(tempBase, "bad-update.git");
    spawn(["git", "init", "--bare", badUpdateBare]);
    const badUpdateWork = join(tempBase, "bad-update-work");
    spawn(["git", "clone", badUpdateBare, badUpdateWork]);
    spawn(["git", "config", "user.email", "test@test.com"], { cwd: badUpdateWork });
    spawn(["git", "config", "user.name", "Test"], { cwd: badUpdateWork });

    // v1.0.0 - valid manifest
    const validManifest = makeManifest({ name: "bad-update-ext", version: "1.0.0" });
    await Bun.write(join(badUpdateWork, "ezcorp.config.ts"), configContent(validManifest));
    await Bun.write(join(badUpdateWork, "index.ts"), 'console.log("ext");');
    spawn(["git", "add", "."], { cwd: badUpdateWork });
    spawn(["git", "commit", "-m", "v1.0.0"], { cwd: badUpdateWork });
    spawn(["git", "tag", "v1.0.0"], { cwd: badUpdateWork });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: badUpdateWork });

    // v2.0.0 - invalid manifest (missing required fields)
    await Bun.write(join(badUpdateWork, "ezcorp.config.ts"), configContent({ schemaVersion: 2, name: "bad-update-ext" }));
    spawn(["git", "add", "."], { cwd: badUpdateWork });
    spawn(["git", "commit", "-m", "v2.0.0"], { cwd: badUpdateWork });
    spawn(["git", "tag", "v2.0.0"], { cwd: badUpdateWork });
    spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: badUpdateWork });

    // Install v1.0.0
    await installFromGit(
      `file://${badUpdateBare}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    // Update should fail on manifest validation
    await expect(updateExtension("bad-update-ext")).rejects.toThrow(/Invalid manifest/);
  });

  test("throws if source is local", async () => {
    // Manually insert a local extension
    mockExtensions.set("local-id", {
      id: "local-id",
      name: "local-ext",
      source: "local:/tmp/fake",
      version: "1.0.0",
      installPath: "/tmp/fake",
    });

    await expect(updateExtension("local-ext")).rejects.toThrow(/local/i);
  });
});

// ── fix-wave B Phase 2: env-leak gate on update + grant re-clamp ──────

/** Build a bare repo whose history carries one tagged commit per entry
 *  of `versions` (each with its own manifest). Returns the file:// URL. */
async function makeVersionedRepo(
  slug: string,
  versions: Array<Partial<ExtensionManifestV2> & { version: string }>,
): Promise<string> {
  const bare = join(tempBase, `${slug}.git`);
  spawn(["git", "init", "--bare", bare]);
  const work = join(tempBase, `${slug}-work`);
  spawn(["git", "clone", bare, work]);
  spawn(["git", "config", "user.email", "test@test.com"], { cwd: work });
  spawn(["git", "config", "user.name", "Test"], { cwd: work });
  for (const overrides of versions) {
    const m = makeManifest(overrides);
    await Bun.write(join(work, "ezcorp.config.ts"), configContent(m));
    await Bun.write(join(work, "index.ts"), 'console.log("ext");');
    spawn(["git", "add", "."], { cwd: work });
    spawn(["git", "commit", "-m", `v${overrides.version}`], { cwd: work });
    spawn(["git", "tag", `v${overrides.version}`], { cwd: work });
  }
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: work });
  return `file://${bare}`;
}

describe("updateExtension — env-leak gate (v1.4 parity with install)", () => {
  test("new-tag manifest declaring FOO_API_TOKEN env is refused; DB + disk stay at old version", async () => {
    const url = await makeVersionedRepo("leaky-update", [
      { name: "leaky-update-ext", version: "1.0.0", permissions: {} },
      { name: "leaky-update-ext", version: "1.1.0", permissions: { env: ["FOO_API_TOKEN"] } },
    ]);

    const installed = await installFromGit(`${url}@v1.0.0`, defaultPerms, {
      extensionsDir: installBase,
      enabled: true,
    });
    expect(installed.version).toBe("1.0.0");

    await expect(updateExtension("leaky-update-ext")).rejects.toThrow(
      /credential-shaped env name/,
    );

    // DB row untouched — old version, old manifest, still enabled.
    const row = Array.from(mockExtensions.values()).find(
      (e: any) => e.name === "leaky-update-ext",
    );
    expect(row.version).toBe("1.0.0");
    expect(row.manifest.permissions?.env).toBeUndefined();
    expect(row.enabled).toBe(true);

    // Disk restored — the subprocess spawns from disk, so a refused
    // update must NOT leave the new tag checked out.
    const onDisk = await Bun.file(join(row.installPath, "ezcorp.config.ts")).text();
    expect(onDisk.includes("FOO_API_TOKEN")).toBe(false);
    expect(onDisk.includes("1.0.0")).toBe(true);
  });
});

describe("updateExtension — grant re-clamp against the new manifest", () => {
  const wideGrant: ExtensionPermissions = {
    network: ["api.example.com", "cdn.example.com"],
    shell: true,
    grantedAt: { network: 111, shell: 222 },
  };
  const widePerms = {
    network: ["api.example.com", "cdn.example.com"],
    shell: true,
  };

  test("narrowing manifest drops granted shell + the removed network host", async () => {
    const url = await makeVersionedRepo("narrow-update", [
      { name: "narrow-update-ext", version: "1.0.0", permissions: widePerms },
      // v1.1.0 drops shell entirely and removes cdn.example.com.
      { name: "narrow-update-ext", version: "1.1.0", permissions: { network: ["api.example.com"] } },
    ]);

    await installFromGit(`${url}@v1.0.0`, wideGrant, {
      extensionsDir: installBase,
      enabled: true,
    });

    const result = await updateExtension("narrow-update-ext");
    expect(result.to).toBe("1.1.0");

    const row = Array.from(mockExtensions.values()).find(
      (e: any) => e.name === "narrow-update-ext",
    );
    // Stale looser sandbox closed: shell gone, cdn host gone.
    expect(row.grantedPermissions.shell).toBeUndefined();
    expect(row.grantedPermissions.network).toEqual(["api.example.com"]);
    // grantedAt timestamps survive the clamp.
    expect(row.grantedPermissions.grantedAt.network).toBe(111);
    // Enabled state preserved — re-clamp never flips consent.
    expect(row.enabled).toBe(true);
  });

  test("unchanged manifest = no-op on the stored grants", async () => {
    const url = await makeVersionedRepo("noop-update", [
      { name: "noop-update-ext", version: "1.0.0", permissions: widePerms },
      // v1.1.0 bumps the version only — permissions identical.
      { name: "noop-update-ext", version: "1.1.0", permissions: widePerms },
    ]);

    await installFromGit(`${url}@v1.0.0`, wideGrant, {
      extensionsDir: installBase,
      enabled: true,
    });

    const result = await updateExtension("noop-update-ext");
    expect(result.to).toBe("1.1.0");

    const row = Array.from(mockExtensions.values()).find(
      (e: any) => e.name === "noop-update-ext",
    );
    expect(row.grantedPermissions.network).toEqual([
      "api.example.com",
      "cdn.example.com",
    ]);
    expect(row.grantedPermissions.shell).toBe(true);
    expect(row.grantedPermissions.grantedAt).toEqual({ network: 111, shell: 222 });
    expect(row.enabled).toBe(true);
  });
});

// ── Remove tests ──────────────────────────────────────────────────────

describe("removeExtension", () => {
  test("removes extension from DB and cleans up files", async () => {
    const _ext = await installFromGit(
      `file://${bareRepoDir}@v1.0.0`,
      defaultPerms,
      { extensionsDir: installBase },
    );

    await removeExtension("test-git-ext");

    // Verify DB record gone
    const remaining = Array.from(mockExtensions.values()).find(
      (e: any) => e.name === "test-git-ext",
    );
    expect(remaining).toBeUndefined();
  });

  test("throws if extension not found", async () => {
    await expect(removeExtension("nonexistent")).rejects.toThrow(/not found/);
  });

  test("does not remove install path outside extensions directory", async () => {
    // Simulate an extension whose installPath is an absolute path NOT containing /extensions/
    const dangerousPath = join(tempBase, "precious-data");
    await mkdir(dangerousPath, { recursive: true });
    await Bun.write(join(dangerousPath, "important.txt"), "do not delete");

    mockExtensions.set("dangerous-id", {
      id: "dangerous-id",
      name: "dangerous-ext",
      source: `file://${bareRepoDir}`,
      version: "1.0.0",
      installPath: dangerousPath, // absolute path without /extensions/
    });

    await removeExtension("dangerous-ext");

    // DB record should be gone
    expect(mockExtensions.has("dangerous-id")).toBe(false);

    // But the directory should NOT have been removed (safety check)
    const file = Bun.file(join(dangerousPath, "important.txt"));
    expect(await file.exists()).toBe(true);
  });
});
