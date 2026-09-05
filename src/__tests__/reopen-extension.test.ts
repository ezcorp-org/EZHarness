import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { useTempProjectRoot, type TempProjectRoot } from "./helpers/temp-project-root";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { FileBlobStore, putFiles, digestObject } from "../extensions/v4/blobs";
import type { InstallationState } from "../extensions/v4";
import { reopenInstalledAsDraft } from "../extensions/reopen-extension";

mock.module("../db/connection", () => ({
  getDb: () => {
    const { drizzle } = require("drizzle-orm/pglite");
    return drizzle(getTestPglite(), { schema: require("../db/schema") });
  },
  getPglite: () => getTestPglite(), getDbPath: () => ":memory:", initDb: async () => {}, closeDb: async () => {},
}));

const OWNER = "user-reopen-owner";
const STRANGER = "user-reopen-stranger";
let project: TempProjectRoot;
let repository: DatabaseLifecycleRepository;
let blobs: FileBlobStore;
const environment = { EZCORP_EXTENSION_BLOB_ROOT: process.env.EZCORP_EXTENSION_BLOB_ROOT, EZCORP_EXTENSION_RUNNER_SOCKET: process.env.EZCORP_EXTENSION_RUNNER_SOCKET, EZCORP_EXTENSION_RUNNER_TOKEN: process.env.EZCORP_EXTENSION_RUNNER_TOKEN };
const files = { "extension.ts": "throw new Error('source must never execute during reopen')", "src/nested.ts": "export const value = 42", "assets/help.md": "# Complete source" };

beforeAll(async () => {
  project = useTempProjectRoot("reopen-v4-");
  process.env.EZCORP_EXTENSION_BLOB_ROOT = join(project.root, "blobs");
  process.env.EZCORP_EXTENSION_RUNNER_SOCKET = join(project.root, "unavailable.sock");
  process.env.EZCORP_EXTENSION_RUNNER_TOKEN = "fixture-token-is-at-least-32-bytes";
  await setupTestDb();
  const { getDb } = await import("../db/connection");
  const { users } = await import("../db/schema");
  for (const id of [OWNER, STRANGER]) await getDb().insert(users).values({ id, email: `${id}@test.local`, passwordHash: "fixture", name: id, status: "active", role: "member" }).onConflictDoNothing();
  repository = new DatabaseLifecycleRepository(getDb());
  blobs = new FileBlobStore(process.env.EZCORP_EXTENSION_BLOB_ROOT);
});
afterAll(async () => {
  await closeTestDb();
  project.cleanup();
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

async function seed(name: string, overrides: { owner?: string; modifiable?: boolean; bundled?: boolean; active?: boolean; lifecycleOwner?: string; uninstalled?: boolean } = {}) {
  const { createExtension } = await import("../db/queries/extensions");
  const manifest = { schemaVersion: 4 as const, name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts" };
  const extension = await createExtension({ name, version: "1.0.0", description: "Fixture", manifest, source: "v4:fixture", installPath: null, enabled: true, grantedPermissions: { grantedAt: {} }, checksumVerified: true, consecutiveFailures: 0, creatorUserId: overrides.owner ?? OWNER, modifiable: overrides.modifiable ?? true, isBundled: overrides.bundled ?? false } as never);
  const sourceDigest = await putFiles(blobs, files);
  const releaseId = `release-${extension.id}`;
  const state: InstallationState = {
    installation: { id: extension.id, ownerId: overrides.lifecycleOwner ?? overrides.owner ?? OWNER, scope: "global", activeReleaseId: overrides.active === false ? null : releaseId, generation: 1, enabled: true, uninstalled: overrides.uninstalled ?? false, status: "active", grants: [], acknowledgedGeneration: 1 },
    workspaces: {}, revisions: {}, operations: {}, approvals: {},
    releases: { [releaseId]: { id: releaseId, installationId: extension.id, workspaceId: "original", workspaceRevision: 1, sourceDigest, artifactDigest: sourceDigest, imageDigest: `sha256:${"a".repeat(64)}`, manifest, evidence: { protocolVersion: 4, validatorVersion: "fixture", discoveryDigest: digestObject(manifest), tests: [{ name: "fixture", passed: true }] }, runnerProfile: "fixture", releaseDigest: sourceDigest, policyDigest: sourceDigest, createdAt: new Date().toISOString() } },
  };
  await repository.create(state);
  return { extension, state, sourceDigest };
}

describe("immutable release reopen", () => {
  test("owner can fork complete nested source with no on-disk install path", async () => {
    const { extension, state, sourceDigest } = await seed("reopen-complete");
    const result = await reopenInstalledAsDraft(extension.name, OWNER);
    expect(result.name).toBe(extension.name);
    expect(result.installationId).toBe(extension.id);
    expect(result.revision).toBe(1);
    expect(result.openUrl).toContain(result.workspaceId);
    const after = (await repository.read(extension.id))!;
    expect(after.workspaces[result.workspaceId]?.sourceDigest).toBe(sourceDigest);
    expect(after.installation).toEqual(state.installation);
    expect(after.releases).toEqual(state.releases);
    expect(after.approvals).toEqual({});
    expect(after.operations).toEqual({});
    const { getExtensionLifecycle } = await import("../extensions/extension-lifecycle-service");
    expect((await (await getExtensionLifecycle()).readWorkspace({ principalId: OWNER, scope: "global", kind: "agent" }, extension.id, result.workspaceId)).files).toEqual(files);
  });
  test("id lookup produces independent workspaces without changing the release", async () => {
    const { extension } = await seed("reopen-by-id");
    const first = await reopenInstalledAsDraft(extension.id, OWNER);
    const second = await reopenInstalledAsDraft(extension.id, OWNER);
    expect(first.workspaceId).not.toBe(second.workspaceId);
    expect(Object.keys((await repository.read(extension.id))!.workspaces)).toHaveLength(2);
  });
  test("owner, modifiable, bundled, lifecycle ownership and uninstall gates are opaque", async () => {
    const cases = [
      { name: "reopen-stranger", user: STRANGER, options: {} },
      { name: "reopen-locked", user: OWNER, options: { modifiable: false } },
      { name: "reopen-bundled", user: OWNER, options: { bundled: true } },
      { name: "reopen-wrong-owner", user: OWNER, options: { lifecycleOwner: STRANGER } },
      { name: "reopen-removed", user: OWNER, options: { uninstalled: true } },
    ];
    for (const item of cases) {
      const { extension } = await seed(item.name, item.options);
      await expect(reopenInstalledAsDraft(extension.id, item.user)).rejects.toMatchObject({ code: "NOT_FOUND_OR_NOT_MODIFIABLE" });
      expect((await repository.read(extension.id))!.workspaces).toEqual({});
    }
    await expect(reopenInstalledAsDraft("missing", OWNER)).rejects.toMatchObject({ code: "NOT_FOUND_OR_NOT_MODIFIABLE" });
  });
  test("legacy installation without active release requires explicit source import", async () => {
    const { extension } = await seed("reopen-no-active", { active: false });
    await expect(reopenInstalledAsDraft(extension.id, OWNER)).rejects.toMatchObject({ code: "NO_VERIFIED_RELEASE" });
    expect((await repository.read(extension.id))!.workspaces).toEqual({});
  });
  test("missing immutable source refuses a partial workspace", async () => {
    const { extension, sourceDigest } = await seed("reopen-missing-source");
    rmSync(join(project.root, "blobs", sourceDigest));
    await expect(reopenInstalledAsDraft(extension.id, OWNER)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect((await repository.read(extension.id))!.workspaces).toEqual({});
  });
});
