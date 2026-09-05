import { expect, type APIRequestContext } from "@playwright/test";
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
  let state: InstallationState;
  await expect.poll(async () => {
    state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id, operationId: operation.id, waitMs: 1000 });
    return state.operations[operation.id]!.state;
  }, { timeout: 240000, intervals: [1000], message: "The real isolated candidate build must finish." }).not.toMatch(/^(queued|building|verifying)$/);
  expect(state!.operations[operation.id]!.state, JSON.stringify(state!.operations[operation.id]!.diagnostics)).toBe("verified");
  expect(Object.keys(state!.releases)).toHaveLength(1);
  return state!;
}

export async function requestRelease(client: HarnessClient, state: InstallationState): Promise<LifecycleApproval> {
  const release = Object.values(state.releases)[0]!;
  const result = await client.extensionControl<{ approval: LifecycleApproval }>("extensions_release", { installationId: state.installation.id, action: "requestApproval", releaseId: release.id, expectedActiveReleaseId: state.installation.activeReleaseId });
  return result.approval;
}
