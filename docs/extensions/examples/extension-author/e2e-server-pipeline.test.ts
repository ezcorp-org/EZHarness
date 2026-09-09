// @ezcorp-host-integration
import { expect, test } from "bun:test";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "../../../../src/__tests__/helpers/test-pglite";
import { actor, harness, human } from "../../../../src/__tests__/helpers/durable-lifecycle-fixture";
import { users } from "../../../../src/db/schema";
import { createDatabaseLifecycleRepository } from "../../../../src/db/queries/extension-releases";
import { ExtensionControl } from "../../../../src/extensions/extension-control";
import { getExtensionDeliveryQueue, getExtensionLifecycle, getExtensionReleaseArtifacts, reconcileExtensionLifecycle, recoverExtensionLifecycle } from "../../../../src/extensions/extension-lifecycle-service";
import { ReleaseProcess } from "../../../../src/extensions/release-process";
import { FileBlobStore, putFiles } from "../../../../src/extensions/v4/blobs";
import type { InstallationRecord, LifecycleOperation, WorkspaceRecord } from "../../../../src/extensions/v4/types";
import { releaseRuntimeFixture } from "../../../../src/__tests__/helpers/release-runtime";
import { loadReleaseWorkflowEntries } from "../../../../src/runtime/workflow-release-assets";

mockDbConnection();

function createdWorkspace(value: unknown): { installation: InstallationRecord; workspace: WorkspaceRecord } {
  if (!value || typeof value !== "object" || !("installation" in value) || !("workspace" in value)) throw new Error("Workspace creation returned no installation and workspace.");
  return value as { installation: InstallationRecord; workspace: WorkspaceRecord };
}

function queuedOperation(value: unknown): LifecycleOperation {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw new Error("Build returned no operation ID.");
  return value as LifecycleOperation;
}

function approvalId(value: unknown): string {
  if (!value || typeof value !== "object" || !("approval" in value) || !value.approval || typeof value.approval !== "object" || !("id" in value.approval) || typeof value.approval.id !== "string") throw new Error("Review request returned no approval ID.");
  return value.approval.id;
}

test("production lifecycle edits and empty delivery polling work offline while builds fail closed", async () => {
  const previous = { socket: process.env.EZCORP_EXTENSION_RUNNER_SOCKET, token: process.env.EZCORP_EXTENSION_RUNNER_TOKEN, blobs: process.env.EZCORP_EXTENSION_BLOB_ROOT };
  const directory = await mkdtemp(join(tmpdir(), "offline-extension-"));
  delete process.env.EZCORP_EXTENSION_RUNNER_SOCKET;
  delete process.env.EZCORP_EXTENSION_RUNNER_TOKEN;
  process.env.EZCORP_EXTENSION_BLOB_ROOT = directory;
  await setupTestDb();
  try {
    await reconcileExtensionLifecycle();
    const [user] = await getTestDb().insert(users).values({ email: `${crypto.randomUUID()}@example.test`, name: "Owner", passwordHash: "unused" }).returning();
    const offlineActor = { principalId: user!.id, scope: "global", kind: "agent" as const };
    const lifecycle = await getExtensionLifecycle();
    const created = await lifecycle.createWorkspace(offlineActor, { files: { "extension.ts": "original" } });
    await lifecycle.editWorkspace(offlineActor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 1, writes: { "extension.ts": "edited" } });
    expect((await lifecycle.readWorkspace(offlineActor, created.installation.id, created.workspace.id)).files).toEqual({ "extension.ts": "edited" });
    expect((await lifecycle.inspect(offlineActor, created.installation.id)).installation.enabled).toBe(false);
    expect(await (await getExtensionDeliveryQueue()).claim()).toBeNull();
    const operation = await lifecycle.build(offlineActor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 2, idempotencyKey: "offline-build" });
    const result = await lifecycle.runBuild(offlineActor, created.installation.id, operation.id);
    expect(result.state).toBe("failed");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "runner_unconfigured" }));
    expect(Object.keys((await lifecycle.inspect(offlineActor, created.installation.id)).releases)).toHaveLength(0);
    await recoverExtensionLifecycle();
    expect((await lifecycle.inspect(offlineActor, created.installation.id)).operations[operation.id]?.state).toBe("failed");
    await expect(new ReleaseProcess(created.installation.id).call("tools/list", {})).rejects.toMatchObject({ code: "RELEASE_NOT_ACTIVE" });
    await expect(new ReleaseProcess(created.installation.id).sendNotification("ezcorp/trigger-fire")).rejects.toMatchObject({ code: "invalid_delivery" });
    const active = releaseRuntimeFixture(crypto.randomUUID(), { schemaVersion: 4, name: "offline-catalog", version: "1.0.0", description: "Fixture", author: { name: "Test" }, permissions: {}, tools: [{ name: "read", description: "Read", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] }, { ownerId: user!.id }).snapshot;
    const files = { "review.workflow.yaml": "name: review\ndescription: Review\nsteps:\n  - name: emit\n    kind: transform\n    output:\n      approved: 'false'\n" };
    active.release.artifactDigest = await putFiles(new FileBlobStore(directory), files, "artifact");
    const repository = await createDatabaseLifecycleRepository();
    await repository.create({ installation: active.installation, releases: { [active.release.id]: active.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
    expect((await new ReleaseProcess(active.installation.id).call("tools/list", {})).result).toEqual({ tools: active.release.manifest.tools });
    const readArtifacts = () => getExtensionReleaseArtifacts(active.installation.id, active.release.id);
    expect(await readArtifacts()).toEqual(files);
    const registry = { getAllManifests: () => new Map([[active.installation.id, active.release.manifest]]).entries() };
    const [workflow] = await loadReleaseWorkflowEntries(registry);
    expect(workflow).toMatchObject({ source: "extension", visibility: "private", userId: user!.id, projectId: null, definition: { name: "offline-catalog:review" }, extensionRelease: { installationId: active.installation.id, ownerId: user!.id, scope: "global" } });
    await expect(getExtensionReleaseArtifacts("missing", active.release.id)).rejects.toMatchObject({ code: "release_not_active" });
    await expect(getExtensionReleaseArtifacts(active.installation.id, "missing")).rejects.toMatchObject({ code: "release_not_active" });
    for (const mutation of [{ enabled: false }, { uninstalled: true }, { activeReleaseId: null }]) {
      await repository.transact(active.installation.id, state => { state.installation = { ...active.installation, ...mutation }; });
      await expect(readArtifacts()).rejects.toMatchObject({ code: "release_not_active" });
    }
    await repository.transact(active.installation.id, state => { state.installation = { ...active.installation, status: "reconciling", acknowledgedGeneration: active.installation.generation - 1 }; });
    expect(await readArtifacts()).toEqual(files);
    expect(await loadReleaseWorkflowEntries(registry)).toHaveLength(1);
    for (const mutation of [null, { id: "foreign-release" }, { installationId: "foreign-installation" }]) {
      const installationId = crypto.randomUUID();
      await repository.create({ installation: { ...active.installation, id: installationId }, releases: mutation ? { [active.release.id]: { ...active.release, installationId, ...mutation } } : {}, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
      await expect(getExtensionReleaseArtifacts(installationId, active.release.id)).rejects.toMatchObject({ code: "release_not_active" });
    }
    const artifactPath = join(directory, active.release.artifactDigest);
    await unlink(artifactPath);
    await writeFile(artifactPath, JSON.stringify({ "workflows/review.yaml": "tampered" }));
    await expect(readArtifacts()).rejects.toMatchObject({ code: "artifact_corrupt" });
  } finally {
    for (const [key, value] of [["EZCORP_EXTENSION_RUNNER_SOCKET", previous.socket], ["EZCORP_EXTENSION_RUNNER_TOKEN", previous.token], ["EZCORP_EXTENSION_BLOB_ROOT", previous.blobs]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await closeTestDb();
    await rm(directory, { recursive: true, force: true });
  }
});

test("author control drives an owned durable lifecycle without granting an agent approval authority", async () => {
  const setup = harness();
  const control = new ExtensionControl(setup.lifecycle);
  const created = createdWorkspace(await control.execute(actor, "extensions_workspace", { action: "create", name: "durable-author", description: "Durable author journey" }));
  expect(created.installation).toMatchObject({ ownerId: actor.principalId, scope: actor.scope, enabled: false, activeReleaseId: null });
  expect(created.workspace.revision).toBe(1);
  expect((await setup.lifecycle.list(actor)).map((installation) => installation.id)).toEqual([created.installation.id]);
  expect((await setup.lifecycle.readWorkspace(actor, created.installation.id, created.workspace.id)).files["extension.ts"]).toContain("defineExtension");
  expect((await setup.lifecycle.readWorkspace(actor, created.installation.id, created.workspace.id)).files["src/echo.test.ts"]).toContain("expect");

  const edited = await control.execute(actor, "extensions_workspace", {
    action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision,
    writes: { "src/author-tool.ts": "export const authorTool = 'durable';" },
  });
  expect(edited).toMatchObject({ id: created.workspace.id, revision: 2 });
  const editedSource = await setup.lifecycle.readWorkspace(actor, created.installation.id, created.workspace.id);
  expect(editedSource.workspace.sourceDigest).not.toBe(created.workspace.sourceDigest);
  expect(editedSource.files["src/author-tool.ts"]).toBe("export const authorTool = 'durable';");
  expect(editedSource.files["extension.ts"]).toContain("defineExtension");

  const foreignOwner = { ...actor, principalId: "foreign-owner" };
  const foreignScope = { ...actor, scope: "project:other" };
  for (const forbiddenActor of [foreignOwner, foreignScope]) {
    await expect(control.execute(forbiddenActor, "extensions_workspace", {
      action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 2,
      writes: { "src/author-tool.ts": "export const authorTool = 'foreign';" },
    })).rejects.toMatchObject({ code: "not_found" });
  }
  await expect(control.execute(actor, "extensions_workspace", {
    action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 1,
    writes: { "src/author-tool.ts": "export const authorTool = 'stale';" },
  })).rejects.toMatchObject({ code: "revision_conflict" });

  const queued = queuedOperation(await control.execute(actor, "extensions_build", {
    installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: 2, idempotencyKey: "author-build-v1",
  }));
  const built = await control.execute(actor, "extensions_inspect", { installationId: created.installation.id, operationId: queued.id, waitMs: 30_000 });
  expect(built).toMatchObject({ operations: { [queued.id]: { state: "verified", workspaceRevision: 2 } } });
  const verified = await setup.lifecycle.inspect(actor, created.installation.id);
  const releaseId = verified.operations[queued.id]?.releaseId;
  expect(releaseId).toBeDefined();
  expect(verified.operations[queued.id]?.events.map((event) => event.state)).toEqual(["queued", "building", "verifying", "verified"]);
  expect(verified.releases[releaseId!]).toMatchObject({ installationId: created.installation.id, workspaceId: created.workspace.id, workspaceRevision: 2, manifest: { schemaVersion: 4, entrypoint: "extension.js" } });
  expect(setup.builds).toHaveLength(1);
  expect(setup.builds[0]?.["src/author-tool.ts"]).toBe("export const authorTool = 'durable';");

  const requested = await control.execute(actor, "extensions_release", {
    action: "requestApproval", installationId: created.installation.id, releaseId: releaseId!, expectedActiveReleaseId: null,
  });
  const pendingApprovalId = approvalId(requested);
  expect(requested).toMatchObject({ openUrl: `/extensions/author?installation=${created.installation.id}`, approval: { status: "pending", releaseId } });
  expect(verified.installation.activeReleaseId).toBeNull();
  await expect(setup.lifecycle.approve(actor, created.installation.id, pendingApprovalId, true)).rejects.toMatchObject({ code: "human_approval_required" });
  expect(await setup.lifecycle.approve(human, created.installation.id, pendingApprovalId, true)).toMatchObject({ status: "approved", approvedBy: human.principalId });
  const approvedState = await setup.lifecycle.inspect(actor, created.installation.id);
  expect(approvedState.approvals[pendingApprovalId]).toMatchObject({ principalId: actor.principalId, scope: actor.scope, expectedActiveReleaseId: null, expectedGeneration: 0, grants: [] });

  const activated = await control.execute(actor, "extensions_release", {
    action: "activate", installationId: created.installation.id, approvalId: pendingApprovalId, idempotencyKey: "author-activate-v1",
  });
  expect(activated).toMatchObject({ state: "active", releaseId });
  const active = await setup.lifecycle.inspect(actor, created.installation.id);
  expect(active.installation).toMatchObject({ activeReleaseId: releaseId, enabled: true, status: "active", generation: 1 });
  expect(active.approvals[pendingApprovalId]).toMatchObject({ status: "consumed", approvedBy: human.principalId });
  expect(active.operations[queued.id]).toMatchObject({ state: "verified", releaseId });
  expect(setup.published).toEqual([1]);

  const next = createdWorkspace(await control.execute(actor, "extensions_workspace", {
    action: "fork", installationId: created.installation.id, releaseId: releaseId!,
  }));
  expect(next.installation.id).toBe(created.installation.id);
  const candidate = await control.execute(actor, "extensions_workspace", {
    action: "edit", installationId: next.installation.id, workspaceId: next.workspace.id, expectedRevision: 1,
    writes: { "src/author-tool.ts": "export const authorTool = 'failed-candidate';" },
  });
  expect(candidate).toMatchObject({ id: next.workspace.id, revision: 2 });
  expect((await setup.lifecycle.readWorkspace(actor, next.installation.id, next.workspace.id)).files["src/author-tool.ts"]).toBe("export const authorTool = 'failed-candidate';");
  const healthyBuild = setup.dependencies.runner.build;
  setup.dependencies.runner.build = async () => { throw new Error("controlled candidate runner failure"); };
  const failedQueued = queuedOperation(await control.execute(actor, "extensions_build", {
    installationId: next.installation.id, workspaceId: next.workspace.id, expectedRevision: 2, idempotencyKey: "author-build-failed-candidate",
  }));
  const failedState = await control.execute(actor, "extensions_inspect", { installationId: next.installation.id, operationId: failedQueued.id, waitMs: 30_000 });
  expect(failedState).toMatchObject({ installation: { activeReleaseId: releaseId, enabled: true }, operations: { [failedQueued.id]: { state: "failed" } } });
  const stateAfterFailure = await setup.lifecycle.inspect(actor, created.installation.id);
  expect(Object.keys(stateAfterFailure.releases)).toEqual([releaseId]);
  expect(stateAfterFailure.operations[failedQueued.id]?.diagnostics).toContainEqual(expect.objectContaining({ code: "operation_failed", stage: "build" }));
  expect(stateAfterFailure.operations[failedQueued.id]?.events.map((event) => event.state)).toEqual(["queued", "building", "failed"]);
  setup.dependencies.runner.build = healthyBuild;

  await control.execute(actor, "extensions_release", { action: "disable", installationId: created.installation.id });
  const disabled = await setup.lifecycle.inspect(actor, created.installation.id);
  expect(disabled.installation).toMatchObject({ activeReleaseId: releaseId, enabled: false, uninstalled: false, status: "disabled" });
  expect(disabled.installation).toMatchObject({ generation: 2, acknowledgedGeneration: 2, grants: [] });
  await control.execute(actor, "extensions_release", { action: "uninstall", installationId: created.installation.id });
  const uninstalled = await setup.lifecycle.inspect(actor, created.installation.id);
  expect(uninstalled.installation).toMatchObject({ activeReleaseId: releaseId, enabled: false, uninstalled: true, status: "disabled" });
  expect(uninstalled.releases[releaseId!]).toBeDefined();
  expect(uninstalled.approvals[pendingApprovalId]).toMatchObject({ status: "consumed" });
  expect(uninstalled.operations[queued.id]).toMatchObject({ state: "verified" });
  expect(uninstalled.installation).toMatchObject({ generation: 3, acknowledgedGeneration: 3, grants: [] });
  expect(uninstalled.workspaces[next.workspace.id]).toMatchObject({ revision: 2 });

  // The durable repository, blobs, and lifecycle are real. The fixture injects
  // a deterministic runner, so this test does not claim an isolated-container build.
  expect(setup.builds).toHaveLength(1);
  expect(setup.published).toEqual([1, 2, 3]);
});
