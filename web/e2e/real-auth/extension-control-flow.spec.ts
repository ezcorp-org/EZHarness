import { test, expect } from "../fixtures/hydration.js";
import { extensionClient, buildWorkspace, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import type { InstallationState, LifecycleOperation, WorkspaceRecord } from "../../../src/extensions/v4/types";

test("external harness builds and invokes real code; failed updates retain the approved release", async ({ request, baseURL }) => {
  test.setTimeout(300000);
  const { client } = await extensionClient(request, baseURL!);
  const restricted = (await extensionClient(request, baseURL!, ["read", "chat"])).client;
  await expect(restricted.extensionControl("extensions_workspace", { action: "create", name: "denied" })).rejects.toMatchObject({ status: 403 });
  const name = `harness-${Date.now().toString(36)}`;
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  const state = await buildWorkspace(client, created);
  const approval = await requestRelease(client, state);
  const approved = await request.post(`/api/extensions/releases/${created.installation.id}/approve`, { data: { approvalId: approval.id, decision: true } });
  expect(approved.status(), await approved.text()).toBe(200);
  await client.extensionControl("extensions_release", { installationId: created.installation.id, action: "activate", approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
  const seeded = await request.post("/api/__test/seed", { data: { title: "v4 harness invocation" } });
  expect(seeded.status(), await seeded.text()).toBe(201);
  const { conversationId } = await seeded.json();
  expect((await client.wireExtensions(conversationId, [name])).wired).toEqual([name]);
  const marker = `actual-isolated-result-${crypto.randomUUID()}`;
  const result = await client.invokeExtensionTool(conversationId, name, "echo", { text: marker });
  expect(result.success, JSON.stringify(result)).toBe(true);
  expect(JSON.stringify(result.output)).toContain(marker);
  await expect(restricted.invokeExtensionTool(conversationId, name, "echo", { text: marker })).rejects.toMatchObject({ status: 403 });
  const changed = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, writes: { "src/echo.test.ts": 'import { test, expect } from "bun:test"; test("must fail", () => expect(false).toBe(true));' } });
  await expect(client.extensionControl("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, writes: { "README.md": "stale" } })).rejects.toMatchObject({ status: 409 });
  const operation = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: changed.id, expectedRevision: changed.revision, idempotencyKey: crypto.randomUUID() });
  await expect.poll(async () => {
    const failed = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id, operationId: operation.id, waitMs: 1000 });
    return failed.operations[operation.id]!.state;
  }, { timeout: 180000, intervals: [1000] }).toBe("failed");
  const retained = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
  expect(retained.installation.activeReleaseId).toBe(Object.values(state.releases)[0]!.id);
  expect(Object.keys(retained.releases)).toHaveLength(1);
  expect((await client.invokeExtensionTool(conversationId, name, "echo", { text: marker })).success).toBe(true);
  await client.extensionControl("extensions_release", { action: "disable", installationId: created.installation.id });
  await expect(client.invokeExtensionTool(conversationId, name, "echo", { text: marker })).rejects.toBeDefined();
  await client.extensionControl("extensions_release", { action: "uninstall", installationId: created.installation.id });
  expect((await client.listExtensions()).some((extension) => extension.name === name)).toBe(false);
  const exact = await request.get(`/api/extensions?name=${encodeURIComponent(name)}`);
  expect(exact.status()).toBe(200);
  expect(await exact.json()).toEqual([]);
  for (const reference of [created.installation.id, name]) expect((await request.get(`/api/extensions/${encodeURIComponent(reference)}`)).status()).toBe(404);
  const history = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
  expect(history.installation.uninstalled).toBe(true);
  expect(Object.keys(history.releases)).toEqual(Object.keys(state.releases));
  expect(history.workspaces[created.workspace.id]!.revision).toBe(changed.revision);
});

test("author dependency resolution saves an overridden transitive version in the workspace lock", async ({ page, request, baseURL }) => {
  const { client } = await extensionClient(request, baseURL!);
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", {
    action: "create", name: `override-${crypto.randomUUID().slice(0, 8)}`,
  });
  const initial = await client.extensionControl<{ files: Record<string, string> }>("extensions_workspace", {
    action: "read", installationId: created.installation.id, workspaceId: created.workspace.id,
  });
  const manifest = JSON.parse(initial.files["package.json"]!);
  const packageJson = JSON.stringify({
    ...manifest,
    dependencies: { "is-odd": "3.0.1" },
    overrides: { "is-number": "7.0.0" },
  }, null, 2);

  await page.goto(created.openUrl);
  await page.getByRole("button", { name: "package.json", exact: true }).click();
  await page.getByRole("textbox", { name: "Source: package.json", exact: true }).fill(packageJson);
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Saved revision");

  const edited = await client.extensionControl<InstallationState>("extensions_inspect", {
    installationId: created.installation.id,
  });
  const revision = edited.workspaces[created.workspace.id]!.revision;
  expect(revision).toBeGreaterThan(created.workspace.revision);
  const resolved = await client.extensionControl<WorkspaceRecord>("extensions_workspace", {
    action: "resolveDependencies", installationId: created.installation.id,
    workspaceId: created.workspace.id, expectedRevision: revision,
  });
  expect(resolved.revision).toBe(revision + 1);

  const saved = await client.extensionControl<{ files: Record<string, string> }>("extensions_workspace", {
    action: "read", installationId: created.installation.id, workspaceId: created.workspace.id,
  });
  const lock = JSON.parse(saved.files["package-lock.json"]!) as {
    packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
  };
  expect(lock.packages[""]?.dependencies).toEqual({ "is-odd": "3.0.1" });
  expect(lock.packages["node_modules/is-odd"]?.version).toBe("3.0.1");
  const numberEntries = Object.entries(lock.packages).filter(([path]) => /(?:^|\/)node_modules\/is-number$/.test(path));
  expect(numberEntries).toHaveLength(1);
  expect(numberEntries[0]![1].version).toBe("7.0.0");

  await page.reload();
  await page.getByRole("button", { name: "package-lock.json", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Source: package-lock.json", exact: true })).toHaveValue(/"version": "7\.0\.0"/);
  await expect(page.getByText(`Revision ${resolved.revision} · Saved`)).toBeVisible();
});
