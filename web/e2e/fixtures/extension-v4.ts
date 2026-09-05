import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "./hydration.js";
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";
import type { InstallationState, LifecycleOperation, WorkspaceRecord, InstallationRecord, LifecycleApproval } from "../../../src/extensions/v4/types";

export interface CreatedWorkspace { installation: InstallationRecord; workspace: WorkspaceRecord; openUrl: string }

export async function extensionClient(request: APIRequestContext, baseURL: string, scopes = ["read", "chat", "extensions"]): Promise<{ client: HarnessClient; key: string }> {
  const response = await request.post("/api/settings/developer/api-keys", { data: { name: `extension-v4-${crypto.randomUUID()}`, scopes } });
  expect(response.status(), await response.text()).toBe(201);
  const { key } = await response.json();
  return { client: new HarnessClient({ baseUrl: baseURL, apiKey: key }), key };
}

export async function buildWorkspace(client: HarnessClient, created: CreatedWorkspace): Promise<InstallationState> {
  const operation = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: crypto.randomUUID() });
  return waitForExtensionBuild(client, created.installation.id, operation.id);
}

export async function waitForExtensionBuild(client: HarnessClient, installationId: string, operationId: string): Promise<InstallationState> {
  let state: InstallationState;
  await expect.poll(async () => {
    state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId, operationId, waitMs: 1000 });
    return state.operations[operationId]!.state;
  }, { timeout: 240000, intervals: [1000], message: "The real isolated candidate build must finish." }).not.toMatch(/^(queued|building|verifying)$/);
  expect(state!.operations[operationId]!.state, JSON.stringify(state!.operations[operationId]!.diagnostics)).toBe("verified");
  expect(state!.releases[state!.operations[operationId]!.releaseId!]).toBeDefined();
  return state!;
}

export async function requestRelease(client: HarnessClient, state: InstallationState, releaseId?: string): Promise<LifecycleApproval> {
  const release = releaseId ? state.releases[releaseId]! : Object.values(state.releases)[0]!;
  const result = await client.extensionControl<{ approval: LifecycleApproval }>("extensions_release", { installationId: state.installation.id, action: "requestApproval", releaseId: release.id, expectedActiveReleaseId: state.installation.activeReleaseId });
  return result.approval;
}

export async function importAndActivateBundledExtension({ page, request, baseURL, name }: {
  page: Page; request: APIRequestContext; baseURL: string; name: string;
}): Promise<{ client: HarnessClient; state: InstallationState }> {
  const { client } = await extensionClient(request, baseURL);
  const listed = await request.get(`/api/extensions?name=${encodeURIComponent(name)}`);
  expect(listed.status(), await listed.text()).toBe(200);
  const existing = (await listed.json() as Array<{ id: string; name: string }>).find(extension => extension.name === name);
  const imported = await request.post("/api/extensions/import-source", {
    data: { kind: "bundled", name, ...(existing ? { targetInstallationId: existing.id } : {}) },
  });
  expect(imported.status(), await imported.text()).toBe(200);
  const created = await imported.json() as CreatedWorkspace & { operation: LifecycleOperation };
  const state = await waitForExtensionBuild(client, created.installation.id, created.operation.id);
  const release = state.releases[state.operations[created.operation.id]!.releaseId!]!;
  expect(release.manifest.name).toBe(name);
  await requestRelease(client, state, release.id);
  await page.goto(created.openUrl);
  const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I reviewed this release and its permissions.").check();
  await approve.click();
  await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();
  const active = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
  expect(active.installation.activeReleaseId).toBe(release.id);
  expect(active.installation.enabled).toBe(true);
  const tools = await request.get(`/api/extensions/${encodeURIComponent(name)}/tools`);
  expect(tools.status(), await tools.text()).toBe(200);
  expect((await tools.json()).tools.map((tool: { name: string }) => tool.name).sort()).toEqual((release.manifest.tools ?? []).map(tool => tool.name).sort());
  return { client, state: active };
}
