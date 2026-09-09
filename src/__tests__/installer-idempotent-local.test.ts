import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { auditLog, users, extensions, projects, projectMembers, extensionStorage } from "../db/schema";
import { getUserById, updateUserStatus } from "../db/queries/users";
import { getExtension, getExtensionByName } from "../db/queries/extensions";
import { getStorageValue, setStorageValue } from "../db/queries/extension-storage";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { ExtensionLifecycle, FileBlobStore, type LifecycleActor } from "../extensions/v4";
import { digestObject } from "../extensions/v4/blobs";
import * as service from "../extensions/extension-lifecycle-service";
import { importExtensionSource, stageExtensionSourceFiles } from "../extensions/source-import";
import { resolveSourceTarget } from "../extensions/source-adoption";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import * as egress from "../search/egress";
import { getProjectMembership } from "../db/queries/project-members";
import { resolveControlActor } from "../../web/src/lib/server/extensions/control-actor";
import { load as loadAuthorPage } from "../../web/src/routes/(app)/extensions/author/+page.server";

mockDbConnection();
const owner: LifecycleActor = { principalId: "owner", scope: "global", kind: "human" };
const administrator: LifecycleActor = { principalId: "admin", scope: "global", kind: "human" };
const files = { "extension.ts": "throw new Error('source must never execute on the host')", "data/example.json": "{\"preserved\":true}" };
let root: string;
let repository: DatabaseLifecycleRepository;
let lifecycle: ExtensionLifecycle;
let restoreService: ReturnType<typeof spyOn>;
let pending: Promise<unknown>[] = [];
function replaceFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }));
}

function githubSourceFetch(sourceFiles: Record<string, string>, options: { treeId?: string; failBlob?: number } = {}) {
  const treeId = options.treeId ?? "a".repeat(40);
  const blobs = Object.entries(sourceFiles).map(([path, content], index) => ({ path, content, sha: (index + 1).toString(16).padStart(40, "0") }));
  let requests = 0;
  return {
    requests: () => requests,
    fetch: async (...args: Parameters<typeof fetch>) => {
      const [input] = args;
      const url = String(input);
      if (url.includes("/commits/")) return Response.json({ commit: { tree: { sha: treeId } } });
      if (url.includes("/git/trees/")) return Response.json({ tree: blobs.map(({ path, sha, content }) => ({ path, mode: "100644", type: "blob", sha, size: content.length })) });
      const blob = blobs.find(({ sha }) => url.endsWith(`/git/blobs/${sha}`));
      if (!blob) return new Response("unexpected blob", { status: 404 });
      requests += 1;
      if (requests === options.failBlob) return new Response("interrupted", { status: 503 });
      return Response.json({ encoding: "base64", content: Buffer.from(blob.content).toString("base64") });
    },
  };
}
beforeEach(async () => {
  await setupTestDb();
  root = await mkdtemp(join(tmpdir(), "source-adoption-"));
  const database = getTestDb();
  for (const id of ["owner", "stranger", "admin"]) await database.insert(users).values({ id, email: `${id}@fixture.test`, passwordHash: "fixture", name: id, status: "active", role: id === "admin" ? "admin" : "member" });
  repository = new DatabaseLifecycleRepository(database);
  lifecycle = new ExtensionLifecycle({ repository, blobs: new FileBlobStore(root), runnerProfile: "test", runnerImageDigest: `sha256:${"a".repeat(64)}`, validatorVersion: "test", buildLimits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024, outputBytes: 1024, timeoutMs: 1000 }, runner: { async build() { throw new Error("Fixture runner unavailable; no source executed"); }, async cancel() {}, async collectArtifacts() { throw new Error("No artifacts"); } }, async verifyCandidate() { throw new Error("No candidate"); }, async publish() { throw new Error("Import must never publish"); }, ...service.createLifecycleAuthorization({ user: getUserById, installation: async (id) => (await repository.read(id))?.installation ?? null, projectionById: getExtension, projectionByName: getExtensionByName, projectMember: async (userId, projectId) => Boolean(await getProjectMembership(userId, projectId)) }) });
  const runBuild = lifecycle.runBuild.bind(lifecycle);
  spyOn(lifecycle, "runBuild").mockImplementation((...args) => { const running = runBuild(...args); pending.push(running); return running; });
  restoreService = spyOn(service, "getExtensionLifecycle").mockResolvedValue(lifecycle);
});
afterEach(async () => { await Promise.allSettled(pending); pending = []; restoreService.mockRestore(); await rm(root, { recursive: true, force: true }); });
afterAll(async () => { await closeTestDb(); mock.restore(); });

async function legacy() {
  const [projection] = await getTestDb().insert(extensions).values({ name: `legacy-${crypto.randomUUID()}`, version: "1.0.0", manifest: { schemaVersion: 3, name: "legacy", version: "1.0.0", description: "Legacy metadata", author: { name: "Fixture" }, permissions: { shell: true } }, source: "github:owner/repository", installPath: "/never-read-this-source", enabled: true, creatorUserId: owner.principalId, grantedPermissions: { shell: true, grantedAt: { shell: Date.now() } } }).returning();
  return projection!;
}

test("owner source adoption preserves exact legacy identity, owner and namespace without old grants", async () => {
  const previous = await legacy();
  const previousIds = (await getTestDb().select({ id: extensions.id }).from(extensions)).map((row) => row.id).sort();
  const staged = await stageExtensionSourceFiles(owner, files, { kind: "github", repository: "owner/repository" }, { targetInstallationId: previous.id });
  const state = await repository.read(previous.id);
  expect(staged.installation.id).toBe(previous.id);
  expect(state?.installation).toMatchObject({ ownerId: owner.principalId, enabled: false, activeReleaseId: null, grants: [] });
  expect(state?.approvals).toEqual({});
  const projection = await getExtension(previous.id);
  expect(projection).toMatchObject({ name: previous.name, creatorUserId: owner.principalId, installPath: previous.installPath, enabled: false, grantedPermissions: { grantedAt: {} } });
  const snapshot = await lifecycle.readWorkspace(owner, previous.id, staged.workspace.id);
  expect(snapshot.files).toMatchObject(files);
  expect(snapshot.files["extension-source.json"]).not.toContain("targetInstallationId");
  expect((await getTestDb().select({ id: extensions.id }).from(extensions)).map((row) => row.id).sort()).toEqual(previousIds);
  const repeated = await stageExtensionSourceFiles(owner, files, { kind: "github", repository: "owner/repository" }, { targetInstallationId: previous.id });
  expect(repeated.workspace.id).toBe(staged.workspace.id);
  expect(repeated.operation.id).toBe(staged.operation.id);
});

test("historical installer audit adopts only its matching local, GitHub, or git source", async () => {
  for (const [source, sourceKind] of [["local:/never-read-this-source", "local"], ["github:owner/repository", "github"], ["git:https://example.test/repository", "git"]] as const) {
    const previous = await legacy();
    await getTestDb().update(extensions).set({ creatorUserId: null, source }).where(eq(extensions.id, previous.id));
    await getTestDb().insert(auditLog).values({ userId: owner.principalId, action: "ext:permission-granted", target: previous.id, metadata: { actor: owner.principalId, permission: "install", source: sourceKind, reason: `admin-install from source=${sourceKind}` } });
    await resolveSourceTarget(owner, previous.id);
    expect((await getExtension(previous.id))?.creatorUserId).toBeNull();
    await resolveSourceTarget(owner, previous.id, true);
    expect((await getExtension(previous.id))?.creatorUserId).toBe(owner.principalId);
    await expect(resolveSourceTarget({ ...owner, principalId: "admin" }, previous.id, true)).rejects.toThrow("access denied");
  }
});

test("null-owner adoption rejects all provenance mismatches without mutation", async () => {
  const invalidAudits = [
    undefined,
    { userId: owner.principalId, action: "extension:confirmed", metadata: { actor: owner.principalId, permission: "install", source: "local", reason: "admin-install from source=local" } },
    { userId: owner.principalId, action: "ext:permission-granted", metadata: { actor: "admin", permission: "install", source: "local", reason: "admin-install from source=local" } },
    { userId: owner.principalId, action: "ext:permission-granted", metadata: { actor: owner.principalId, permission: "install", source: "github", reason: "admin-install from source=github" } },
    { userId: owner.principalId, action: "ext:permission-granted", metadata: { actor: owner.principalId, source: "local", reason: "admin-install from source=local" } },
    { userId: "admin", action: "ext:permission-granted", metadata: { actor: "admin", permission: "install", source: "local", reason: "admin-install from source=local" } },
  ];
  for (const audit of invalidAudits) {
    const previous = await legacy();
    await getTestDb().update(extensions).set({ creatorUserId: null, source: "local:/never-read-this-source" }).where(eq(extensions.id, previous.id));
    if (audit) await getTestDb().insert(auditLog).values({ ...audit, target: previous.id });
    await expect(resolveSourceTarget(owner, previous.id, true)).rejects.toThrow("access denied");
    expect((await getExtension(previous.id))?.creatorUserId).toBeNull();
    expect(await repository.read(previous.id)).toBeNull();
  }
  const previous = await legacy();
  await getTestDb().update(extensions).set({ creatorUserId: null, source: "local:/never-read-this-source" }).where(eq(extensions.id, previous.id));
  await getTestDb().insert(auditLog).values({ userId: owner.principalId, action: "ext:permission-granted", target: crypto.randomUUID(), metadata: { actor: owner.principalId, permission: "install", source: "local", reason: "admin-install from source=local" } });
  await expect(resolveSourceTarget(owner, previous.id, true)).rejects.toThrow("access denied");
  expect((await getExtension(previous.id))?.creatorUserId).toBeNull();
  expect(await repository.read(previous.id)).toBeNull();
});

test("a null-owner projection cannot bypass an existing lifecycle state", async () => {
  const previous = await legacy();
  await getTestDb().update(extensions).set({ creatorUserId: null, source: "local:/never-read-this-source" }).where(eq(extensions.id, previous.id));
  await getTestDb().insert(auditLog).values({ userId: owner.principalId, action: "ext:permission-granted", target: previous.id, metadata: { actor: owner.principalId, permission: "install", source: "local", reason: "admin-install from source=local" } });
  await repository.create({ installation: { id: previous.id, ownerId: owner.principalId, scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled", grants: [], acknowledgedGeneration: 0 }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
  await expect(resolveSourceTarget(owner, previous.id, true)).rejects.toThrow("ownership requires review");
  expect((await getExtension(previous.id))?.creatorUserId).toBeNull();
});

test("target ownership is checked before any source collection, including administrator requests", async () => {
  const previous = await legacy();
  const network = replaceFetch(async () => { throw new Error("Network must not run"); });
  try {
    for (const principalId of ["stranger", "admin"]) await expect(importExtensionSource({ ...owner, principalId }, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id })).rejects.toThrow("access denied");
    expect(network).not.toHaveBeenCalled();
    expect(await repository.read(previous.id)).toBeNull();
    expect((await getExtension(previous.id))?.enabled).toBe(true);
  } finally { network.mockRestore(); }
});

test("active owner imports build a candidate without changing the active release or approved grants", async () => {
  const previous = await legacy();
  const manifest = { schemaVersion: 4 as const, name: previous.name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts", permissions: {} };
  const { snapshot } = releaseRuntimeFixture(previous.id, manifest, { ownerId: owner.principalId });
  await repository.create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, workspaces: {}, revisions: {}, approvals: {}, operations: {} });
  await stageExtensionSourceFiles(owner, files, { kind: "marketplace", versionId: "version" }, { targetInstallationId: previous.id });
  const state = await repository.read(previous.id);
  expect(state?.installation).toEqual(snapshot.installation);
  expect(state?.releases).toEqual({ [snapshot.release.id]: snapshot.release });
  expect(state?.approvals).toEqual({});
  expect((await getExtension(previous.id))?.enabled).toBe(true);
});

test("a later GitHub blob failure stages nothing and leaves an active installation byte-for-byte unchanged", async () => {
  const previous = await legacy();
  const manifest = { schemaVersion: 4 as const, name: previous.name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts", permissions: {} };
  const { snapshot } = releaseRuntimeFixture(previous.id, manifest, { ownerId: owner.principalId });
  await repository.create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, workspaces: {}, revisions: {}, approvals: {}, operations: {} });
  await setStorageValue(previous.id, "global", null, "known-output", { exact: "retained" }, false, 20);
  const before = structuredClone(await repository.read(previous.id));
  const storageBefore = await getTestDb().select().from(extensionStorage);
  expect(await getStorageValue(previous.id, "global", null, "known-output")).toEqual({ value: { exact: "retained" }, encrypted: false, sizeBytes: 20 });
  const guarded = egress.guardedFetch;
  const guard = spyOn(egress, "guardedFetch").mockImplementation((url, init, options) => guarded(url, init, { ...options, resolveHost: async () => ["93.184.216.34"] }));
  const source = githubSourceFetch({ "extension.ts": "export {};", "later.ts": "export {};" }, { failBlob: 2 });
  const network = replaceFetch(source.fetch);
  try {
    await expect(importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id })).rejects.toMatchObject({ code: "source_fetch_failed" });
    expect(source.requests()).toBe(2);
    expect(await repository.read(previous.id)).toEqual(before);
    expect(await getTestDb().select().from(extensionStorage)).toEqual(storageBefore);
    expect(await getStorageValue(previous.id, "global", null, "known-output")).toEqual({ value: { exact: "retained" }, encrypted: false, sizeBytes: 20 });
  } finally { network.mockRestore(); guard.mockRestore(); }
});

test("an identical immutable GitHub retry reuses one candidate while changed source stages a distinct unapproved candidate", async () => {
  const previous = await legacy();
  const manifest = { schemaVersion: 4 as const, name: previous.name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts", permissions: {} };
  const { snapshot } = releaseRuntimeFixture(previous.id, manifest, { ownerId: owner.principalId });
  await repository.create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, workspaces: {}, revisions: {}, approvals: {}, operations: {} });
  const guarded = egress.guardedFetch;
  const guard = spyOn(egress, "guardedFetch").mockImplementation((url, init, options) => guarded(url, init, { ...options, resolveHost: async () => ["93.184.216.34"] }));
  try {
    const immutable = githubSourceFetch({ "extension.ts": "export const revision = 'one';" }, { treeId: "a".repeat(40) });
    const initialNetwork = replaceFetch(immutable.fetch);
    let firstWorkspaceId = "";
    let firstOperationId = "";
    try {
      const first = await importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id });
      const repeated = await importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id });
      firstWorkspaceId = first.workspace.id;
      firstOperationId = first.operation.id;
      const afterRepeat = await repository.read(previous.id);
      expect(repeated.workspace.id).toBe(first.workspace.id);
      expect(repeated.operation.id).toBe(first.operation.id);
      expect(immutable.requests()).toBe(2);
      expect(afterRepeat).toMatchObject({ installation: snapshot.installation, approvals: {}, releases: { [snapshot.release.id]: snapshot.release } });
      expect(Object.keys(afterRepeat?.workspaces ?? {})).toHaveLength(1);
      expect(Object.keys(afterRepeat?.revisions ?? {})).toHaveLength(1);
      expect(Object.keys(afterRepeat?.operations ?? {})).toHaveLength(1);
    } finally { initialNetwork.mockRestore(); }

    const changed = githubSourceFetch({ "extension.ts": "export const revision = 'two';" }, { treeId: "d".repeat(40) });
    const changedNetwork = replaceFetch(changed.fetch);
    try {
      const staged = await importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id });
      const afterChange = await repository.read(previous.id);
      expect(staged.workspace.id).not.toBe(firstWorkspaceId);
      expect(staged.operation.id).not.toBe(firstOperationId);
      expect(changed.requests()).toBe(1);
      expect(afterChange).toMatchObject({ installation: snapshot.installation, approvals: {}, releases: { [snapshot.release.id]: snapshot.release } });
      expect(Object.keys(afterChange?.workspaces ?? {})).toHaveLength(2);
      expect(Object.keys(afterChange?.revisions ?? {})).toHaveLength(2);
      expect(Object.keys(afterChange?.operations ?? {})).toHaveLength(2);
    } finally { changedNetwork.mockRestore(); }
  } finally { guard.mockRestore(); }
});

test("a deactivated owner cannot activate an administrator-approved release or change its live installation", async () => {
  const previous = await legacy();
  const manifest = { schemaVersion: 4 as const, name: previous.name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts", permissions: {} };
  const { snapshot } = releaseRuntimeFixture(previous.id, manifest, { ownerId: owner.principalId });
  const release = { ...snapshot.release, policyDigest: digestObject({ profile: "test", image: `sha256:${"a".repeat(64)}`, validator: "test", limits: { memoryBytes: 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024, outputBytes: 1024, timeoutMs: 1000 } }) };
  const installation = { ...snapshot.installation, activeReleaseId: null, generation: 0, enabled: false, status: "disabled" as const, acknowledgedGeneration: 0, grants: [] };
  await repository.create({ installation, releases: { [release.id]: release }, workspaces: {}, revisions: {}, approvals: {}, operations: {} });
  await getTestDb().update(extensions).set({ enabled: false, grantedPermissions: { grantedAt: {} } }).where(eq(extensions.id, previous.id));

  const requested = await lifecycle.requestApproval(owner, { installationId: previous.id, releaseId: release.id, grants: [], expectedActiveReleaseId: null });
  const approved = await lifecycle.approve(administrator, previous.id, requested.id, true);
  expect(approved).toMatchObject({ status: "approved", approvedBy: administrator.principalId, releaseId: release.id });
  expect(await updateUserStatus(owner.principalId, "inactive")).toBe(true);
  expect(await getUserById(owner.principalId)).toMatchObject({ status: "inactive" });

  const activation = await lifecycle.activate(administrator, { installationId: previous.id, approvalId: approved.id, idempotencyKey: crypto.randomUUID() });
  expect(activation).toMatchObject({ kind: "activate", state: "failed", approvalId: approved.id, releaseId: release.id, diagnostics: [expect.objectContaining({ code: "unauthorized", stage: "activate" })] });
  const after = await repository.read(previous.id);
  expect(after?.installation).toEqual(installation);
  expect(after?.approvals[approved.id]).toEqual(approved);
  expect((await getExtension(previous.id))?.enabled).toBe(false);
});

test("unknown targets and mismatched persisted owners stay opaque, while an owner's deleted installation reports its tombstone", async () => {
  await expect(resolveSourceTarget(owner, "missing", true)).rejects.toThrow("access denied");
  const created = await lifecycle.createWorkspace(owner, { files });
  await repository.transact(created.installation.id, (state) => { state.installation.uninstalled = true; });
  await expect(resolveSourceTarget(owner, created.installation.id, true)).rejects.toMatchObject({
    code: "uninstalled",
    message: "This installation has been uninstalled. Import source without selecting it to create a new installation. The previous extension name remains reserved; choose a new extension name before activation.",
  });
  await expect(resolveSourceTarget({ ...owner, principalId: "stranger" }, created.installation.id, true)).rejects.toThrow("access denied");
  const previous = await legacy();
  await resolveSourceTarget(owner, previous.id, true);
  await getTestDb().update(extensions).set({ creatorUserId: "stranger" }).where(eq(extensions.id, previous.id));
  await expect(resolveSourceTarget(owner, previous.id)).rejects.toThrow("ownership requires review");

  const tombstonedProjection = await legacy();
  const { snapshot } = releaseRuntimeFixture(tombstonedProjection.id, { schemaVersion: 4, name: tombstonedProjection.name, version: "1.0.0", description: "Fixture", author: { name: "Fixture" }, entrypoint: "extension.ts", permissions: {} }, { ownerId: owner.principalId });
  await repository.create({ installation: { ...snapshot.installation, uninstalled: true }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
  await getTestDb().update(extensions).set({ creatorUserId: "stranger" }).where(eq(extensions.id, tombstonedProjection.id));
  await expect(resolveSourceTarget(owner, tombstonedProjection.id)).rejects.toThrow("ownership requires review");
});

test("members cannot use adoption to read host-local source or create unowned installations", async () => {
  const previous = await legacy();
  await expect(importExtensionSource(owner, { kind: "local", path: "/etc", targetInstallationId: previous.id })).rejects.toThrow("administrator");
  await expect(importExtensionSource(owner, { kind: "github", repository: "owner/repository" })).rejects.toThrow("administrator");
  await expect(stageExtensionSourceFiles({ ...owner, kind: "agent" }, files, { kind: "skill", name: "example" }, { targetInstallationId: previous.id })).rejects.toThrow("administrator");
  expect(await repository.read(previous.id)).toBeNull();
});

test("a member imports GitHub source into their explicit legacy installation through the shared flow", async () => {
  const previous = await legacy();
  const guarded = egress.guardedFetch;
  const guard = spyOn(egress, "guardedFetch").mockImplementation((url, init, options) => guarded(url, init, { ...options, resolveHost: async () => ["93.184.216.34"] }));
  const fetcher = replaceFetch(async (input) => {
    const url = String(input);
    return Response.json(url.includes("/commits/") ? { commit: { tree: { sha: "a".repeat(40) } } } : url.includes("/git/trees/") ? { tree: [{ path: "extension.ts", mode: "100644", type: "blob", sha: "b".repeat(40), size: files["extension.ts"].length }] } : { encoding: "base64", content: Buffer.from(files["extension.ts"]).toString("base64") });
  });
  try {
    const staged = await importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: previous.id });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(staged.installation.id).toBe(previous.id);
    expect(staged.source).toEqual({ kind: "github", repository: "owner/repository" });
    expect((await lifecycle.readWorkspace(owner, previous.id, staged.workspace.id)).files["extension.ts"]).toBe(files["extension.ts"]);
    expect((await repository.read(previous.id))?.installation.activeReleaseId).toBeNull();
  } finally { fetcher.mockRestore(); guard.mockRestore(); }
});

test("lost project membership denies target imports before collecting source", async () => {
  const created = await lifecycle.createWorkspace(owner, { files });
  const state = await repository.read(created.installation.id);
  const projectInstallation = { ...state!, installation: { ...state!.installation, id: crypto.randomUUID(), scope: "project:removed" }, workspaces: {}, revisions: {} };
  await repository.create(projectInstallation);
  const fetcher = replaceFetch(async () => { throw new Error("Must not fetch"); });
  try {
    await expect(importExtensionSource(owner, { kind: "github", repository: "owner/repository", targetInstallationId: projectInstallation.installation.id })).rejects.toThrow("membership");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});

test("a project member imports and opens the real scoped review loader without disclosing foreign source", async () => {
  const database = getTestDb();
  await database.insert(projects).values({ id: "owned-project", name: "Owned project", path: root });
  await database.insert(projectMembers).values({ projectId: "owned-project", userId: owner.principalId, role: "member" });
  const scopedOwner = { ...owner, scope: "project:owned-project" };
  const created = await lifecycle.createWorkspace(scopedOwner, { files });
  const imported = await stageExtensionSourceFiles(owner, files, { kind: "marketplace", versionId: "version" }, { targetInstallationId: created.installation.id });
  const user = (await getUserById(owner.principalId))!;
  expect(await resolveControlActor(user, "human", created.installation.id)).toEqual(scopedOwner);
  const event = { url: new URL(`http://localhost${imported.openUrl}`), locals: { user, authMethod: "session" } } as unknown as Parameters<typeof loadAuthorPage>[0];
  const loaded = await loadAuthorPage(event);
  expect(loaded).toMatchObject({ state: { installation: { scope: scopedOwner.scope, ownerId: owner.principalId } }, workspace: { id: imported.workspace.id }, files });
  const stranger = (await getUserById("stranger"))!;
  await expect(loadAuthorPage({ ...event, locals: { ...event.locals, user: stranger } })).rejects.toMatchObject({ status: 404 });
  await database.delete(projectMembers).where(eq(projectMembers.projectId, "owned-project"));
  await expect(loadAuthorPage(event)).rejects.toMatchObject({ status: 404 });
});

test("the author loader keeps lifecycle history when its real workspace blob is missing", async () => {
  const database = getTestDb();
  await database.update(users).set({ role: "admin" }).where(eq(users.id, owner.principalId));
  const created = await lifecycle.createWorkspace(owner, { files });
  const user = (await getUserById(owner.principalId))!;
  const event = { url: new URL(`http://localhost/extensions/author?installation=${created.installation.id}&workspace=${created.workspace.id}`), locals: { user, authMethod: "session" } } as unknown as Parameters<typeof loadAuthorPage>[0];

  expect(await loadAuthorPage(event)).toMatchObject({ workspace: { id: created.workspace.id }, files, canApprove: true });
  await unlink(join(root, created.workspace.sourceDigest));

  expect(await loadAuthorPage(event)).toMatchObject({ state: { installation: { id: created.installation.id }, workspaces: { [created.workspace.id]: { sourceDigest: created.workspace.sourceDigest } } }, workspace: null, files: {}, sourceUnavailable: { workspaceId: created.workspace.id }, canApprove: false });
});
