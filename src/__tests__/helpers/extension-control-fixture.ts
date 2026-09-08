import { mock } from "bun:test";
import { createExtensionFiles, ExtensionControl } from "../../extensions/extension-control";
import type { ExtensionLifecycle } from "../../extensions/v4";
import type { InstallationState, LifecycleActor } from "../../extensions/v4/types";
export const controlActor: LifecycleActor = { principalId: "owner", scope: "global", kind: "agent" };
export const controlInstallation = { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: null, generation: 0, enabled: false, uninstalled: false, status: "disabled" as const, grants: [], acknowledgedGeneration: 0 };
export const controlWorkspace = { id: "workspace", installationId: controlInstallation.id, revision: 1, sourceDigest: "source", createdAt: "now" };
export function controlFixture() {
 const state: InstallationState = { installation: controlInstallation, workspaces: { workspace: controlWorkspace }, revisions: {}, operations: {}, releases: {}, approvals: {} };
 const lifecycle = { createWorkspace: mock(async () => ({ installation: controlInstallation, workspace: controlWorkspace })), list: mock(async () => [controlInstallation]), readWorkspace: mock(async () => ({ workspace: controlWorkspace, files: createExtensionFiles() })), editWorkspace: mock(async () => ({ ...controlWorkspace, revision: 2 })), resolveWorkspaceDependencies: mock(async () => ({ ...controlWorkspace, revision: 2 })), build: mock(async () => ({ id: "operation", state: "queued" })), runBuild: mock(async () => ({ id: "operation", state: "verified" })), inspect: mock(async () => state), requestApproval: mock(async () => ({ id: "approval" })), activate: mock(async () => ({ state: "active" })), rollback: mock(async () => ({ state: "active" })), disable: mock(async () => undefined), uninstall: mock(async () => undefined) };
 return { lifecycle, state, control: new ExtensionControl(lifecycle as unknown as ExtensionLifecycle) };
}
