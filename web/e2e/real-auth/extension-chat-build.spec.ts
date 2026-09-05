import { test, expect } from "../fixtures/hydration.js";
import { extensionClient, waitForExtensionBuild } from "../fixtures/extension-v4";
import type { InstallationRecord, InstallationState } from "../../../src/extensions/v4/types";

test("the real chat tool loop creates and builds source but cannot approve itself", async ({ request, baseURL }) => {
  test.setTimeout(300000);
  const { client } = await extensionClient(request, baseURL!);
  const seed = await request.post("/api/__test/seed", { data: { title: "Chat builds its own extension" } });
  expect(seed.status(), await seed.text()).toBe(201);
  const { conversationId } = await seed.json();
  const before = await client.extensionControl<InstallationRecord[]>("extensions_workspace", { action: "list" });
  const name = `chat-${crypto.randomUUID().slice(0, 8)}`;
  const created = await client.runScripted(conversationId, "Create an extension workspace", [
    { toolCalls: [{ name: "extensions_workspace", arguments: { action: "create", name } }] },
    { text: "Source workspace created. It is not approved or active." },
  ], { timeoutMs: 60000 });
  expect(created.outcome, JSON.stringify(created)).toBe("complete");
  const after = await client.extensionControl<InstallationRecord[]>("extensions_workspace", { action: "list" });
  const additions = after.filter((installation) => !before.some((previous) => previous.id === installation.id));
  let state: InstallationState | undefined;
  for (const installation of additions) {
    const candidate = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: installation.id });
    for (const workspace of Object.values(candidate.workspaces)) {
      const source = await client.extensionControl<{ files: Record<string, string> }>("extensions_workspace", { action: "read", installationId: installation.id, workspaceId: workspace.id });
      if (Object.values(source.files).some((contents) => contents.includes(name))) state = candidate;
    }
  }
  expect(state, "The chat must create durable source through the real control tool.").toBeDefined();
  const workspace = Object.values(state!.workspaces)[0]!;
  const built = await client.runScripted(conversationId, "Build the workspace in isolation", [
    { toolCalls: [{ name: "extensions_build", arguments: { installationId: state!.installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, idempotencyKey: crypto.randomUUID() } }] },
    { text: "Build submitted. Human approval is still required." },
  ], { timeoutMs: 60000 });
  expect(built.outcome, JSON.stringify(built)).toBe("complete");
  const pending = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: state!.installation.id });
  const operation = Object.values(pending.operations)[0];
  expect(operation, "The chat must submit an actual isolated build.").toBeDefined();
  const verified = await waitForExtensionBuild(client, state!.installation.id, operation!.id);
  expect(verified.installation.enabled).toBe(false);
  expect(verified.installation.activeReleaseId).toBeNull();
  expect(Object.keys(verified.approvals)).toHaveLength(0);
  await client.extensionControl("extensions_release", { action: "uninstall", installationId: state!.installation.id });
});
