// @ezcorp-host-integration
import { expect, mock, test } from "bun:test";
import manifest from "./ezcorp.config";
import { migrationStatus } from "./index";
import { ExtensionControl, extensionControlTools } from "../../../../src/extensions/extension-control";

const actor = { principalId: "author", scope: "global", kind: "human" as const };
const installation = { id: "installation", ownerId: "author", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled" as const, grants: [], acknowledgedGeneration: 0 };
const workspace = { id: "workspace", installationId: installation.id, revision: 1, sourceDigest: "source", createdAt: "now" };

function hostControl() {
  const state = { installation, workspaces: { workspace }, revisions: {}, operations: {}, releases: {}, approvals: {} };
  const lifecycle = {
    createWorkspace: mock(async () => ({ installation, workspace })),
    list: mock(async () => [installation]),
    readWorkspace: mock(async () => ({ workspace, files: {} })),
    editWorkspace: mock(async () => ({ ...workspace, revision: 2 })),
    resolveWorkspaceDependencies: mock(async () => ({ ...workspace, revision: 2 })),
    build: mock(async () => ({ id: "operation", state: "queued" })),
    runBuild: mock(async () => ({ id: "operation", state: "verified" })),
    inspect: mock(async () => state),
    requestApproval: mock(async () => ({ id: "approval" })),
    activate: mock(async () => ({ state: "active" })),
    rollback: mock(async () => ({ state: "active" })),
    disable: mock(async () => undefined),
    uninstall: mock(async () => undefined),
  };
  return { control: new ExtensionControl(lifecycle as never), lifecycle, state };
}



test("migration status names the complete current host authoring flow", () => {
  const status = JSON.parse(migrationStatus().content[0]!.text!);
  expect(status.tools).toEqual(["extensions_describe", "extensions_workspace", "extensions_build", "extensions_inspect", "extensions_release"]);
  expect(status.message).toContain("host");
  expect(status.approval).toContain("user");
  expect(manifest.tools).toHaveLength(1);
});

test("host authoring tools expose no extension-side approval operation", () => {
  const names = extensionControlTools.map((tool) => tool.name);
  expect(names).toContain("extensions_workspace");
  expect(names).toContain("extensions_build");
  expect(names).toContain("extensions_inspect");
  expect(names).toContain("extensions_release");
  expect(names).not.toContain("extensions_approve");
});

test("host describe returns the v4 SDK and human approval rule", async () => {
  const { control } = hostControl();
  const described = await control.execute(actor, "extensions_describe", {});
  expect(described).toMatchObject({ schemaVersion: 4, sdk: "@ezcorp/sdk/v4" });
  expect((described as any).flow).toEqual(["extensions_workspace", "extensions_build", "extensions_inspect", "extensions_release"]);
  expect((described as any).rules).toContain("A human must approve the exact tested release.");
  expect((described as any).template["extension.ts"]).toContain("defineExtension");
});

test("host workspace creation opens an isolated authoring workspace", async () => {
  const { control, lifecycle } = hostControl();
  const result = await control.execute(actor, "extensions_workspace", { action: "create", name: "authoring-example", description: "Current flow" });
  expect(result).toMatchObject({ installation, workspace });
  expect((result as any).openUrl).toContain("installation=installation");
  expect((result as any).openUrl).toContain("workspace=workspace");
  expect(lifecycle.createWorkspace).toHaveBeenCalledTimes(1);
});

test("host workspace edits require the observed revision", async () => {
  const { control, lifecycle } = hostControl();
  await control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "extension.ts": "export {}" } });
  expect(lifecycle.editWorkspace).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, writes: { "extension.ts": "export {}" }, deletes: undefined });
  await expect(control.execute(actor, "extensions_workspace", { action: "edit", installationId: "installation", workspaceId: "workspace", writes: { "extension.ts": "export {}" } })).rejects.toHaveProperty("code", "invalid_input");
  expect(lifecycle.createWorkspace).not.toHaveBeenCalled();
});

test("host dependency resolution is revision-bound and does not build", async () => {
  const { control, lifecycle } = hostControl();
  await control.execute(actor, "extensions_workspace", { action: "resolveDependencies", installationId: "installation", workspaceId: "workspace", expectedRevision: 1 });
  expect(lifecycle.resolveWorkspaceDependencies).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1 });
  expect(lifecycle.build).not.toHaveBeenCalled();
  expect(lifecycle.activate).not.toHaveBeenCalled();
});

test("host build queues an exact revision before any release activation", async () => {
  const { control, lifecycle } = hostControl();
  const operation = await control.execute(actor, "extensions_build", { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, idempotencyKey: "build-1" });
  expect(operation).toEqual({ id: "operation", state: "queued" });
  expect(lifecycle.build).toHaveBeenCalledWith(actor, { installationId: "installation", workspaceId: "workspace", expectedRevision: 1, idempotencyKey: "build-1" });
  expect(lifecycle.runBuild).toHaveBeenCalledWith(actor, "installation", "operation");
  expect(lifecycle.activate).not.toHaveBeenCalled();
});

test("host build rejects an unobserved workspace revision", async () => {
  const { control, lifecycle } = hostControl();
  await expect(control.execute(actor, "extensions_build", { installationId: "installation", workspaceId: "workspace", expectedRevision: -1, idempotencyKey: "build-1" })).rejects.toHaveProperty("code", "invalid_input");
  expect(lifecycle.build).not.toHaveBeenCalled();
  expect(lifecycle.runBuild).not.toHaveBeenCalled();
  expect(lifecycle.activate).not.toHaveBeenCalled();
});

test("host release rejects a nonexistent exact release", async () => {
  const { control, lifecycle } = hostControl();
  await expect(control.execute(actor, "extensions_release", { action: "requestApproval", installationId: "installation", releaseId: "missing", expectedActiveReleaseId: null })).rejects.toHaveProperty("code", "not_found");
  expect(lifecycle.inspect).toHaveBeenCalledWith(actor, "installation");
  expect(lifecycle.requestApproval).not.toHaveBeenCalled();
  expect(lifecycle.activate).not.toHaveBeenCalled();
});

test("host release refuses an author-supplied approval action", async () => {
  const { control, lifecycle } = hostControl();
  await expect(control.execute(actor, "extensions_release", { action: "approve", installationId: "installation" })).rejects.toHaveProperty("code", "invalid_input");
  expect(lifecycle.requestApproval).not.toHaveBeenCalled();
  expect(lifecycle.activate).not.toHaveBeenCalled();
  expect(lifecycle.disable).not.toHaveBeenCalled();
});

test("host release cannot activate without an approval identifier", async () => {
  const { control, lifecycle } = hostControl();
  await expect(control.execute(actor, "extensions_release", { action: "activate", installationId: "installation", idempotencyKey: "activate-1" })).rejects.toHaveProperty("code", "invalid_input");
  expect(lifecycle.activate).not.toHaveBeenCalled();
  expect(lifecycle.rollback).not.toHaveBeenCalled();
  expect(lifecycle.uninstall).not.toHaveBeenCalled();
});

test("host workspace reads use the requested installation and workspace", async () => {
  const { control, lifecycle } = hostControl();
  const result = await control.execute(actor, "extensions_workspace", { action: "read", installationId: "installation", workspaceId: "workspace" });
  expect(result).toEqual({ workspace, files: {} });
  expect(lifecycle.readWorkspace.mock.calls).toEqual([[actor, "installation", "workspace"]]);
  expect(lifecycle.editWorkspace).not.toHaveBeenCalled();
});

test("host workspace listing uses the human author's identity without changing source", async () => {
  const { control, lifecycle } = hostControl();
  expect(await control.execute(actor, "extensions_workspace", { action: "list" })).toEqual([installation]);
  expect(lifecycle.list.mock.calls).toEqual([[actor]]);
  expect(lifecycle.createWorkspace).not.toHaveBeenCalled();
});

test("host release forks name the immutable source release without starting a build", async () => {
  const { control, lifecycle } = hostControl();
  const result = await control.execute(actor, "extensions_workspace", { action: "fork", installationId: "installation", releaseId: "verified-source" });
  expect(result).toMatchObject({ installation, workspace });
  expect(lifecycle.createWorkspace.mock.calls).toEqual([[actor, { installationId: "installation", releaseId: "verified-source" }]]);
  expect(lifecycle.build).not.toHaveBeenCalled();
  expect(lifecycle.runBuild).not.toHaveBeenCalled();
  expect(lifecycle.activate).not.toHaveBeenCalled();
});
