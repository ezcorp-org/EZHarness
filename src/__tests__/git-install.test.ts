import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldWorkspace } from "@ezcorp/sdk/scaffold";
import { PodmanRunner, buildLimits, DEFAULT_IMAGE, provisionToolchain, filesDigest } from "@ezcorp/extension-runner";
import type { ReleaseRecord, WorkspaceFiles } from "@ezcorp/extension-contract";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { ExtensionLifecycle, FileBlobStore } from "../extensions/v4";
import { collectGitHubSource } from "../extensions/source-import";
import { createLifecycleAuthorization, publishExtensionGeneration, verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";
import { requestedReleaseGrants } from "../extensions/extension-control";
import { createUser, getUserById } from "../db/queries/users";
import { getExtension, getExtensionByName } from "../db/queries/extensions";
import { getStorageValue, setStorageValue } from "../db/queries/extension-storage";
import { installFromGit, updateExtension, checkForUpdates } from "../extensions/installer";

mockDbConnection();
let root: string;
let repo: string;
let runner: PodmanRunner;
let lifecycle: ExtensionLifecycle;
let ownerId: string;
let installationId: string;
let initialRelease: ReleaseRecord;
let upgradedRelease: ReleaseRecord;
let initialFiles: WorkspaceFiles;
let initialApprovalId: string;
const actor = () => ({ principalId: ownerId, scope: "global", kind: "human" as const });

function git(...args: string[]): Buffer {
  const process = Bun.spawnSync(["git", ...args], { cwd: repo, env: { ...globalThis.process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (process.exitCode !== 0) throw new Error(process.stderr.toString());
  return Buffer.from(process.stdout);
}

async function collect(ref = "v1.0.0", patchTree?: (tree: Record<string, unknown>[]) => Record<string, unknown>[]) {
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/commits/")) {
      const selected = decodeURIComponent(url.pathname.split("/commits/")[1]!);
      return Response.json({ commit: { tree: { sha: git("rev-parse", selected + "^{tree}").toString().trim() } } });
    }
    if (url.pathname.includes("/git/trees/")) {
      const tree = git("ls-tree", "-r", "-l", url.pathname.split("/git/trees/")[1]!).toString().trim().split("\n").filter(Boolean).map(line => {
        const [metadata, path] = line.split("\t");
        const [mode, type, sha, size] = metadata!.trim().split(/\s+/);
        return { path, mode, type, sha, size: Number(size) };
      });
      return Response.json({ truncated: false, tree: patchTree ? patchTree(tree) : tree });
    }
    const sha = url.pathname.split("/git/blobs/")[1]!;
    return Response.json({ encoding: "base64", content: git("cat-file", "blob", sha).toString("base64") });
  }) as typeof fetch;
  return collectGitHubSource({ kind: "github", repository: "fixtures/source", ref }, { fetch: fetcher, resolveHost: async () => ["93.184.216.34"] });
}

async function stage(files: WorkspaceFiles, existingId?: string) {
  const created = await lifecycle.createWorkspace(actor(), { files, ...(existingId ? { installationId: existingId } : {}) });
  const operation = await lifecycle.build(actor(), { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 1, idempotencyKey: crypto.randomUUID() });
  const result = await lifecycle.runBuild(actor(), created.installation.id, operation.id);
  return { ...created, operation: result };
}

async function activate(release: ReleaseRecord) {
  const state = await lifecycle.inspect(actor(), release.installationId);
  const approval = await lifecycle.requestApproval(actor(), { installationId: release.installationId, releaseId: release.id, grants: requestedReleaseGrants(release.manifest), expectedActiveReleaseId: state.installation.activeReleaseId });
  await lifecycle.approve(actor(), release.installationId, approval.id, true);
  const result = await lifecycle.activate(actor(), { installationId: release.installationId, approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
  expect(result.state).toBe("active");
  return approval.id;
}

beforeAll(async () => {
  await setupTestDb();
  const owner = await createUser({ email: "git-owner@example.com", name: "Owner", role: "admin", passwordHash: "test" });
  ownerId = owner.id;
  root = await mkdtemp(join(tmpdir(), "git-lifecycle-"));
  repo = join(root, "source");
  await mkdir(repo);
  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  const seed = scaffoldWorkspace({ name: "git-source-extension", description: "Git source fixture" }).files;
  for (const [path, source] of Object.entries(seed)) await Bun.write(join(repo, path), source);
  const versionOne = seed["extension.ts"]!.replace('"permissions": {}', '"permissions": {"storage":true,"network":["api.example.com","other.example.com"]}');
  await Bun.write(join(repo, "extension.ts"), versionOne);
  git("add", "."); git("commit", "-m", "version one"); git("tag", "v1.0.0");
  await Bun.write(join(repo, "extension.ts"), versionOne.replace('"version": "1.0.0"', '"version": "2.0.0"').replace(',"other.example.com"', ""));
  git("add", "."); git("commit", "-m", "version two"); git("tag", "v2.0.0");
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
  const repository = new DatabaseLifecycleRepository(getTestDb());
  lifecycle = new ExtensionLifecycle({
    repository, blobs: new FileBlobStore(join(root, "blobs")), runner, buildLimits,
    runnerProfile: "podman-v1", runnerImageDigest: DEFAULT_IMAGE, validatorVersion: "runner-v4.1",
    ...createLifecycleAuthorization({
      user: getUserById, installation: async id => (await repository.read(id))?.installation ?? null,
      projectionById: async id => await getExtension(id) ?? null, projectionByName: async name => await getExtensionByName(name) ?? null,
      projectMember: async () => false,
    }),
    verifyCandidate: release => verifyExtensionCandidate(runner, release), publish: publishExtensionGeneration,
  });
  initialFiles = await collect();
  const staged = await stage(initialFiles);
  expect(staged.operation.diagnostics).toEqual([]);
  expect(staged.operation.state).toBe("verified");
  installationId = staged.installation.id;
  const state = await lifecycle.inspect(actor(), installationId);
  initialRelease = state.releases[staged.operation.releaseId!]!;
  expect(state.installation.enabled).toBe(false);
  expect(state.installation.grants).toEqual([]);
  expect(await getExtensionByName("git-source-extension")).toBeNull();
  initialApprovalId = await activate(initialRelease);
}, 120000);
afterAll(async () => { await runner?.close(); restoreModuleMocks(); await closeTestDb(); if (root) await rm(root, { recursive: true, force: true }); });

describe("explicit GitHub source collection", () => {
  test("a selected tag builds and activates only after exact human approval", async () => {
    expect(initialRelease.manifest.version).toBe("1.0.0");
    expect(initialRelease.sourceDigest).toBe(filesDigest(initialFiles));
    expect((await getExtension(installationId))?.source).toBe("release-v4");
  });
  test("branch selection resolves immutable tree content", async () => {
    expect(await collect("main")).toEqual(await collect("v2.0.0"));
    expect(filesDigest(await collect("main"))).not.toBe(initialRelease.sourceDigest);
  });
  test("missing entrypoint is rejected before staging", async () => {
    await expect(collect("v1.0.0", tree => tree.filter(entry => entry.path !== "extension.ts"))).rejects.toThrow("entrypoint");
  });
  test("malformed source fails without changing the active release", async () => {
    const result = await stage({ ...initialFiles, "extension.ts": "export const broken = ;" }, installationId);
    expect(result.operation.state).toBe("failed");
    expect((await lifecycle.inspect(actor(), installationId)).installation.activeReleaseId).toBe(initialRelease.id);
  }, 120000);
  test("invalid manifest fails isolated validation", async () => {
    const invalid = { ...initialFiles, "extension.ts": String(initialFiles["extension.ts"]).replace('"schemaVersion": 4', '"schemaVersion": 2') };
    expect((await stage(invalid, installationId)).operation.state).toBe("failed");
  }, 120000);
  test("a second installation cannot claim an active extension name", async () => {
    const second = await stage(initialFiles);
    expect(second.operation.state).toBe("verified");
    const state = await lifecycle.inspect(actor(), second.installation.id);
    const release = state.releases[second.operation.releaseId!]!;
    await expect(lifecycle.requestApproval(actor(), { installationId: second.installation.id, releaseId: release.id, grants: requestedReleaseGrants(release.manifest), expectedActiveReleaseId: null })).rejects.toThrow("owns this extension name");
    expect(state.installation.enabled).toBe(false);
    expect((await getExtensionByName("git-source-extension"))?.id).toBe(installationId);
  }, 120000);
  test("failed candidates cannot execute host-side configuration", async () => {
    const marker = join(root, "host-marker");
    const files = { ...initialFiles, "ezcorp.config.ts": `await Bun.write(${JSON.stringify(marker)}, "executed"); throw new Error("host forbidden");`, "extension.ts": "this is invalid syntax" };
    expect((await stage(files, installationId)).operation.state).toBe("failed");
    expect(await Bun.file(marker).exists()).toBe(false);
  }, 120000);
});

describe("immutable upgrade behavior", () => {
  test("new remote tags do not update the active installation", async () => {
    expect((await collect("v2.0.0"))["extension.ts"]).toContain('"version": "2.0.0"');
    expect((await getExtension(installationId))?.version).toBe("1.0.0");
  });
  test("repeated collection of the same tag has the same source digest", async () => { expect(filesDigest(await collect())).toBe(initialRelease.sourceDigest); });
  test("HEAD needs no semver scanning and still resolves exact source", async () => { expect(await collect("HEAD")).toEqual(await collect("v2.0.0")); });
  test("legacy automatic update checks reject instead of silently polling a mutable source", async () => { await expect(checkForUpdates({ source: "github:fixtures/source", version: "1.0.0" })).rejects.toThrow("EXTENSION_V4_REQUIRED"); });
  test("an upgrade creates a separate verified release without changing grants", async () => {
    const result = await stage(await collect("v2.0.0"), installationId);
    expect(result.operation.diagnostics).toEqual([]);
    expect(result.operation.state).toBe("verified");
    const state = await lifecycle.inspect(actor(), installationId);
    upgradedRelease = state.releases[result.operation.releaseId!]!;
    expect(upgradedRelease.sourceDigest).not.toBe(initialRelease.sourceDigest);
    expect(state.installation.activeReleaseId).toBe(initialRelease.id);
    expect(state.installation.grants).toEqual(requestedReleaseGrants(initialRelease.manifest));
  }, 120000);
  test("unknown installation updates fail closed", async () => { await expect(lifecycle.createWorkspace(actor(), { installationId: "unknown", files: initialFiles })).rejects.toThrow("not found"); });
  test("generic file Git remotes remain explicitly unsupported", async () => { await expect(installFromGit(`file://${repo}`, { grantedAt: {} })).rejects.toThrow("EXTENSION_V4_REQUIRED"); });
  test("failed upgrades leave the sealed previous source readable", async () => {
    const fork = await lifecycle.createWorkspace(actor(), { installationId, releaseId: initialRelease.id });
    expect((await lifecycle.readWorkspace(actor(), installationId, fork.workspace.id)).files).toEqual(initialFiles);
  });
  test("legacy local update cannot replace source or approvals", async () => { await expect(updateExtension("git-source-extension")).rejects.toThrow("EXTENSION_V4_REQUIRED"); });
  test("old approval and mismatched grants cannot approve new code", async () => {
    await expect(lifecycle.requestApproval(actor(), { installationId, releaseId: upgradedRelease.id, grants: requestedReleaseGrants(initialRelease.manifest), expectedActiveReleaseId: initialRelease.id })).rejects.toThrow("exact declared permissions");
    await expect(lifecycle.activate(actor(), { installationId, approvalId: initialApprovalId, idempotencyKey: crypto.randomUUID() })).rejects.toThrow();
    expect((await lifecycle.inspect(actor(), installationId)).installation.activeReleaseId).toBe(initialRelease.id);
  });
  test("narrowing permissions takes effect only after fresh approval and activation", async () => {
    await activate(upgradedRelease);
    const state = await lifecycle.inspect(actor(), installationId);
    expect(state.installation.activeReleaseId).toBe(upgradedRelease.id);
    expect(state.installation.grants).toEqual(requestedReleaseGrants(upgradedRelease.manifest));
    expect((await getExtension(installationId))?.grantedPermissions.network).toEqual(["api.example.com"]);
  }, 120000);
  test("source recollection cannot silently renew or widen grants", async () => {
    const before = (await lifecycle.inspect(actor(), installationId)).installation;
    await collect("v1.0.0");
    expect((await lifecycle.inspect(actor(), installationId)).installation).toEqual(before);
  });
});

describe("uninstall retains user data and immutable history", () => {
  test("uninstall disables projection but retains data and previous releases", async () => {
    await setStorageValue(installationId, "global", null, "retained", { message: "keep" }, false, Buffer.byteLength(JSON.stringify({ message: "keep" })));
    await lifecycle.uninstall(actor(), installationId);
    const state = await lifecycle.inspect(actor(), installationId);
    expect(state.installation.uninstalled).toBe(true);
    expect(state.installation.enabled).toBe(false);
    expect(state.releases[initialRelease.id]).toEqual(initialRelease);
    expect((await getStorageValue(installationId, "global", null, "retained"))?.value).toEqual({ message: "keep" });
    expect((await getExtension(installationId))?.enabled).toBe(false);
  });
  test("unknown uninstall targets are rejected", async () => { await expect(lifecycle.uninstall(actor(), "unknown")).rejects.toThrow("not found"); });
  test("uninstall never deletes the external source checkout", async () => {
    expect(await Bun.file(join(repo, "extension.ts")).exists()).toBe(true);
    expect(git("rev-parse", "v1.0.0").toString().trim()).toMatch(/^[a-f0-9]{40}$/);
    expect((await lifecycle.inspect(actor(), installationId)).releases[initialRelease.id]?.sourceDigest).toBe(initialRelease.sourceDigest);
  });
});
