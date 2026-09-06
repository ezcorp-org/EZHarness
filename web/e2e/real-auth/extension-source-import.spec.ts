import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import { extensionClient, buildWorkspace, waitForExtensionBuild, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import { threadMessages } from "../fixtures/composer";
import type { InstallationState, LifecycleOperation, WorkspaceRecord } from "../../../src/extensions/v4/types";

async function invokeImportedTool(page: import("@playwright/test").Page, name: string, input: string, output: string): Promise<void> {
  const textarea = page.locator("textarea.chat-textarea");
  await expect(textarea).toBeVisible({ timeout: 30_000 });
  const chip = page.locator(`[data-mention-kind="extension"][data-mention-name="${name}"]`);
  if (await chip.count() === 0) {
    await textarea.click();
    await textarea.pressSequentially(`!${name}`, { delay: 20 });
    const listbox = page.locator("#mention-listbox");
    await expect(listbox).toBeVisible({ timeout: 20_000 });
    await listbox.getByText(name, { exact: false }).first().click();
  } else await chip.click();
  await expect(chip).toBeVisible();
  const field = page.locator("#field-text");
  await expect(field).toBeVisible();
  await field.fill(input);
  await page.locator("form").getByRole("button", { name: "Add", exact: true }).click();
  await expect(threadMessages(page).getByText(output, { exact: false })).toBeVisible({ timeout: 90_000 });
}

async function approveAndActivate(page: import("@playwright/test").Page, installationId: string, workspaceId: string): Promise<void> {
  await page.goto(`/extensions/author?installation=${installationId}&workspace=${workspaceId}`);
  const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I reviewed this release and its permissions.").check();
  await approve.click();
  await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();
}

test("member imports verified marketplace source, an administrator approves it, and the installed release works @evidence", async ({ browser, page: adminPage, request, baseURL }, testInfo) => {
  test.setTimeout(360000);
  const email = `source-import-${Date.now()}@example.test`;
  const invitation = await request.post("/api/auth/invite", { data: { email, role: "member" } });
  expect(invitation.status(), await invitation.text()).toBe(201);
  const { invite } = await invitation.json();
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  let cleanup: (() => Promise<unknown>) | undefined;
  let reinstalledCleanup: (() => Promise<unknown>) | undefined;
  try {
    const accepted = await context.request.post(`/api/auth/invite/${invite.token}`, { data: { name: "Source Import Member", email, password: "Source-Import-E2e-9x!" } });
    expect(accepted.status(), await accepted.text()).toBe(201);
    const profile = await context.request.get("/api/auth/me");
    const { user } = await profile.json();
    expect(user.role).toBe("member");
    const onboarded = await context.request.post("/api/onboarding/complete");
    expect(onboarded.status(), await onboarded.text()).toBe(204);
    const { client } = await extensionClient(context.request, baseURL!);
    const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name: `source-import-${Date.now().toString(36)}` });
    cleanup = () => client.extensionControl("extensions_release", { action: "uninstall", installationId: created.installation.id, idempotencyKey: crypto.randomUUID() });
    created.workspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, writes: {
      "src/echo.ts": "export function echo(input: Record<string, unknown>) { return { text: `Imported source output: " + "$" + "{input.text}` }; }\n",
      "src/echo.test.ts": 'import { expect, test } from "bun:test"; import { echo } from "./echo"; test("returns imported output", () => expect(echo({ text: "hello" })).toEqual({ text: "Imported source output: hello" }));\n',
    } });
    const initial = await buildWorkspace(client, created);
    const original = Object.values(initial.releases)[0]!;
    const seeded = await context.request.post("/api/__test/marketplace-release", { data: { installationId: created.installation.id, releaseId: original.id } });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const { versionId } = await seeded.json();
    const memberPage = await context.newPage();
    await memberPage.goto(`/extensions/import-source?installation=${created.installation.id}`);
    await expect(memberPage.getByRole("heading", { name: "Import extension source", exact: true })).toBeVisible();
    expect(await memberPage.getByLabel("Installation").inputValue()).toBe(created.installation.id);
    await expect(memberPage.getByRole("option", { name: "Create a new installation" })).toHaveCount(0);
    await memberPage.getByLabel("Source type").selectOption("marketplace");
    await memberPage.getByLabel("Marketplace version ID").fill(versionId);
    await captureEvidence(memberPage, testInfo, "extension-source-import-form");
    await memberPage.setViewportSize({ width: 390, height: 844 });
    expect(await memberPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await captureEvidence(memberPage, testInfo, "extension-source-import-mobile", { fullPage: true });
    await memberPage.setViewportSize({ width: 1280, height: 900 });
    const importedResponse = memberPage.waitForResponse((response) => response.url().endsWith("/api/extensions/import-source") && response.request().method() === "POST");
    await memberPage.getByRole("button", { name: "Import and build candidate", exact: true }).click();
    const imported = await importedResponse;
    expect(imported.status(), await imported.text()).toBe(200);
    const staged = await imported.json() as { installation: InstallationState["installation"]; workspace: WorkspaceRecord; operation: LifecycleOperation };
    expect(staged.installation.id).toBe(created.installation.id);
    expect(staged.installation.ownerId).toBe(user.id);
    await expect(memberPage).toHaveURL(new RegExp(`/extensions/author\\?installation=${created.installation.id}&workspace=${staged.workspace.id}`));
    const state = await waitForExtensionBuild(client, created.installation.id, staged.operation.id);
    expect(state.installation).toMatchObject({ ownerId: user.id, enabled: false, activeReleaseId: null, grants: [] });
    expect(state.approvals).toEqual({});
    expect(Object.values(state.releases)).toHaveLength(2);
    const release = state.releases[state.operations[staged.operation.id]!.releaseId!]!;
    expect(release.manifest.name).toBe(original.manifest.name);
    const approval = await requestRelease(client, state, release.id);
    await memberPage.reload();
    await expect(memberPage.getByRole("button", { name: "Approve exact release", exact: true })).toBeDisabled();
    await expect(memberPage.getByText("An administrator must review this release in a human session. API keys cannot approve.")).toBeVisible();
    const forbidden = await context.request.post(`/api/extensions/releases/${created.installation.id}/approve`, { data: { approvalId: approval.id, decision: true } });
    expect(forbidden.status()).toBe(403);
    await memberPage.getByRole("button", { name: "Approve exact release", exact: true }).scrollIntoViewIfNeeded();
    await captureEvidence(memberPage, testInfo, "extension-source-import-review");
    expect((await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id })).installation.activeReleaseId).toBeNull();

    // The marketplace version is published from this test's own ephemeral
    // workspace through the opt-in local test surface. No external repository
    // or marketplace account is used by this browser flow.
    await approveAndActivate(adminPage, created.installation.id, staged.workspace.id);
    const active = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(active.installation).toMatchObject({ enabled: true, activeReleaseId: release.id });
    const { client: adminClient } = await extensionClient(request, baseURL!);
    const seededConversation = await request.post("/api/__test/seed", { data: { title: "Marketplace source import output" } });
    expect(seededConversation.status(), await seededConversation.text()).toBe(201);
    const { projectId, conversationId } = await seededConversation.json();
    expect((await adminClient.wireExtensions(conversationId, [release.manifest.name])).wired).toEqual([release.manifest.name]);
    const marker = `marketplace-source-input-${crypto.randomUUID()}`;
    const output = `Imported source output: ${marker}`;
    await adminPage.goto(`/project/${projectId}/chat/${conversationId}`);
    await invokeImportedTool(adminPage, release.manifest.name, marker, output);
    await captureEvidence(adminPage, testInfo, "extension-source-import-visible-output");

    const importedWorkspace = active.workspaces[staged.workspace.id]!;
    const source = await client.extensionControl<{ files: Record<string, string> }>("extensions_workspace", { action: "read", installationId: created.installation.id, workspaceId: importedWorkspace.id });
    const permissionedEntrypoint = source.files["extension.ts"]!.replace('"permissions": {},', '"permissions": { "storage": true },');
    expect(permissionedEntrypoint).not.toBe(source.files["extension.ts"]);
    const permissionedWorkspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: importedWorkspace.id, expectedRevision: importedWorkspace.revision, writes: { "extension.ts": permissionedEntrypoint } });
    const permissionedState = await buildWorkspace(client, { installation: created.installation, workspace: permissionedWorkspace, openUrl: staged.openUrl });
    const permissionedRelease = Object.values(permissionedState.releases).find(candidate => candidate.workspaceId === permissionedWorkspace.id && candidate.workspaceRevision === permissionedWorkspace.revision)!;
    expect(permissionedRelease.manifest.permissions.storage).toBe(true);
    await requestRelease(client, permissionedState, permissionedRelease.id);
    await adminPage.goto(`/extensions/author?installation=${created.installation.id}&workspace=${permissionedWorkspace.id}`);
    await adminPage.getByText('"storage": true', { exact: true }).scrollIntoViewIfNeeded();
    await captureEvidence(adminPage, testInfo, "extension-source-import-permission-update");
    await adminPage.getByLabel("I reviewed this release and its permissions.").check();
    await adminPage.getByRole("button", { name: "Approve exact release", exact: true }).click();
    await adminPage.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(adminPage.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();
    const permissionedActive = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(permissionedActive.installation.activeReleaseId).toBe(permissionedRelease.id);
    expect(permissionedActive.installation.grants).not.toEqual(active.installation.grants);

    const invalidWorkspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: permissionedWorkspace.id, expectedRevision: permissionedWorkspace.revision, writes: { "src/echo.test.ts": 'import { expect, test } from "bun:test"; test("fails", () => expect(false).toBe(true));' } });
    const failedUpdate = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: invalidWorkspace.id, expectedRevision: invalidWorkspace.revision, idempotencyKey: crypto.randomUUID() });
    await expect.poll(async () => (await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id, operationId: failedUpdate.id, waitMs: 1000 })).operations[failedUpdate.id]!.state, { timeout: 180_000, intervals: [1000] }).toBe("failed");
    const retained = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(retained.installation.activeReleaseId).toBe(permissionedRelease.id);
    const retainedOutput = await adminClient.invokeExtensionTool(conversationId, release.manifest.name, "echo", { text: marker });
    expect(retainedOutput.success).toBe(true);
    expect(JSON.stringify(retainedOutput.output)).toContain(output);

    await adminPage.goto(`/extensions/${created.installation.id}`);
    await adminPage.getByTestId("extension-detail-uninstall-button").click();
    const dialog = adminPage.getByTestId("uninstall-dialog");
    await expect(dialog).toContainText("release history, settings, secrets, stored data and files are kept");
    await dialog.getByTestId("uninstall-confirm").click();
    await expect(adminPage).toHaveURL(/\/extensions$/);
    expect((await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id })).installation.uninstalled).toBe(true);
    cleanup = undefined;

    await adminPage.goto("/extensions/import-source");
    await adminPage.getByLabel("Source type").selectOption("marketplace");
    await adminPage.getByLabel("Marketplace version ID").fill(versionId);
    const reimportResponse = adminPage.waitForResponse(response => response.url().endsWith("/api/extensions/import-source") && response.request().method() === "POST");
    await adminPage.getByRole("button", { name: "Import and build candidate", exact: true }).click();
    const reimport = await reimportResponse;
    expect(reimport.status(), await reimport.text()).toBe(200);
    const reinstalled = await reimport.json() as { installation: InstallationState["installation"]; workspace: WorkspaceRecord; operation: LifecycleOperation };
    const { client: reinstalledClient } = await extensionClient(request, baseURL!);
    reinstalledCleanup = () => reinstalledClient.extensionControl("extensions_release", { action: "uninstall", installationId: reinstalled.installation.id, idempotencyKey: crypto.randomUUID() });
    expect(reinstalled.installation.id).not.toBe(created.installation.id);
    const reinstalledState = await waitForExtensionBuild(reinstalledClient, reinstalled.installation.id, reinstalled.operation.id);
    const reinstalledRelease = reinstalledState.releases[reinstalledState.operations[reinstalled.operation.id]!.releaseId!]!;
    await requestRelease(reinstalledClient, reinstalledState, reinstalledRelease.id);
    await approveAndActivate(adminPage, reinstalled.installation.id, reinstalled.workspace.id);
    expect((await reinstalledClient.extensionControl<InstallationState>("extensions_inspect", { installationId: reinstalled.installation.id })).installation).toMatchObject({ enabled: true, activeReleaseId: reinstalledRelease.id });
    await expect(reinstalledClient.extensionControl("extensions_release", { action: "activate", installationId: reinstalled.installation.id, approvalId: approval.id, idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ status: 404 });
    const reinstalledInvocation = await reinstalledClient.invokeExtensionTool(conversationId, reinstalledRelease.manifest.name, "echo", { text: marker });
    expect(reinstalledInvocation.success).toBe(true);
    expect(JSON.stringify(reinstalledInvocation.output)).toContain(output);
  } finally { await reinstalledCleanup?.(); await cleanup?.(); await context.close(); }
});
