import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../__tests__/helpers/test-pglite";
import { users, extensions, projects, projectMembers } from "../../db/schema";
import { getUserById } from "../../db/queries/users";
import { getExtension, getExtensionByName } from "../../db/queries/extensions";
import { DatabaseLifecycleRepository } from "../../db/queries/extension-releases";
import { ExtensionLifecycle, FileBlobStore, type LifecycleActor } from "../v4";
import * as service from "../extension-lifecycle-service";
import { importExtensionSource, stageExtensionSourceFiles } from "../source-import";
import { resolveSourceTarget } from "../source-adoption";
import { releaseRuntimeFixture } from "../../__tests__/helpers/release-runtime";
import * as egress from "../../search/egress";
import { getProjectMembership } from "../../db/queries/project-members";
import { resolveControlActor } from "../../../web/src/lib/server/extensions/control-actor";
import { load as loadAuthorPage } from "../../../web/src/routes/(app)/extensions/author/+page.server";

mockDbConnection();
const owner: LifecycleActor = { principalId: "owner", scope: "global", kind: "human" };
const files = { "extension.ts": "throw new Error('source must never execute on the host')", "data/example.json": "{\"preserved\":true}" };
let root: string;
let repository: DatabaseLifecycleRepository;
let lifecycle: ExtensionLifecycle;
let restoreService: ReturnType<typeof spyOn>;
let pending: Promise<unknown>[] = [];
function replaceFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }));
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

test("unknown targets, deleted installations and mismatched persisted owners cannot be adopted", async () => {
  await expect(resolveSourceTarget(owner, "missing", true)).rejects.toThrow("access denied");
  const created = await lifecycle.createWorkspace(owner, { files });
  await repository.transact(created.installation.id, (state) => { state.installation.uninstalled = true; });
  await expect(resolveSourceTarget(owner, created.installation.id, true)).rejects.toThrow("access denied");
  const previous = await legacy();
  await resolveSourceTarget(owner, previous.id, true);
  await getTestDb().update(extensions).set({ creatorUserId: "stranger" }).where(eq(extensions.id, previous.id));
  await expect(resolveSourceTarget(owner, previous.id)).rejects.toThrow("ownership requires review");
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
