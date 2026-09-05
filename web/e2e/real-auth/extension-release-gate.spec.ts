import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import { extensionClient, buildWorkspace, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import type { InstallationState, LifecycleOperation, WorkspaceRecord } from "../../../src/extensions/v4/types";

async function invokeToolFromComposer(page: Page, name: string): Promise<void> {
  const textarea = page.locator("textarea.chat-textarea");
  await expect(textarea).toBeVisible({ timeout: 30000 });
  const chip = page.locator('[data-mention-kind="extension"][data-mention-name="' + name + '"]');
  if (await chip.count() === 0) {
    await textarea.click();
    await textarea.pressSequentially("!" + name, { delay: 20 });
    const listbox = page.locator("#mention-listbox");
    await expect(listbox).toBeVisible({ timeout: 20000 });
    await listbox.getByText(name, { exact: false }).first().click();
  } else {
    await chip.click();
  }
  await expect(chip).toBeVisible();
  const field = page.locator("#field-text");
  await expect(field).toBeVisible();
  await field.fill("smoke");
  await page.locator("form").getByRole("button", { name: "Add", exact: true }).click();
}

function source(prefix: string): Record<string, string> {
  return {
    "src/echo.ts": "export function echo(input: Record<string, unknown>) { return { text: " + JSON.stringify(prefix) + " + input.text }; }\n",
    "src/echo.test.ts": 'import {expect,test} from "bun:test";import {echo} from "./echo";test("returns the requested output",()=>expect(echo({text:"smoke"})).toEqual({text:' + JSON.stringify(prefix + "smoke") + "}));\n",
  };
}

test("an approved release renders real results, repeats, rejects broken source, and upgrades @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(360000);
  const { client } = await extensionClient(request, baseURL!);
  const name = "release-gate-" + Date.now().toString(36);
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  async function edit(workspace: WorkspaceRecord, writes: Record<string, string>) {
    return client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: workspace.id, expectedRevision: workspace.revision, writes });
  }
  async function approve(state: InstallationState, workspace: WorkspaceRecord) {
    const release = Object.values(state.releases).find(candidate => candidate.workspaceId === workspace.id && candidate.workspaceRevision === workspace.revision)!;
    expect(release).toBeDefined();
    await requestRelease(client, state, release.id);
    await page.goto("/extensions/author?installation=" + created.installation.id + "&workspace=" + workspace.id);
    const button = page.getByRole("button", { name: "Approve exact release", exact: true });
    await expect(button).toBeDisabled();
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await button.click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();
    const active = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(active.installation.activeReleaseId).toBe(release.id);
    return release;
  }
  try {
    created.workspace = await edit(created.workspace, source("Received: "));
    const initial = await buildWorkspace(client, created);
    expect(initial.installation.enabled).toBe(false);
    const release = await approve(initial, created.workspace);
    const toolsResponse = await request.get("/api/extensions/" + name + "/tools");
    expect(toolsResponse.status()).toBe(200);
    const { tools } = await toolsResponse.json();
    expect(tools.map((tool: { name: string }) => tool.name)).toContain("echo");
    const seeded = await request.post("/api/__test/seed", { data: { title: "Real release output and upgrade" } });
    expect(seeded.status(), await seeded.text()).toBe(201);
    const { projectId, conversationId } = await seeded.json();
    expect((await client.wireExtensions(conversationId, [name])).wired).toEqual([name]);
    const chatUrl = "/project/" + projectId + "/chat/" + conversationId;
    await page.goto(chatUrl);
    await invokeToolFromComposer(page, name);
    await expect(page.getByText("Received: smoke", { exact: false }).first()).toBeVisible({ timeout: 90000 });
    await invokeToolFromComposer(page, name);
    await expect(page.getByText("Received: smoke", { exact: false })).toHaveCount(2, { timeout: 90000 });
    await captureEvidence(page, testInfo, "extension-real-repeated-output");

    const fork = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "fork", installationId: created.installation.id, releaseId: release.id });
    fork.workspace = await edit(fork.workspace, { "src/echo.ts": "export function echo( {" });
    const failedBuild = await client.extensionControl<LifecycleOperation>("extensions_build", { installationId: created.installation.id, workspaceId: fork.workspace.id, expectedRevision: fork.workspace.revision, idempotencyKey: crypto.randomUUID() });
    await expect.poll(async () => {
      const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id, operationId: failedBuild.id, waitMs: 1000 });
      return state.operations[failedBuild.id]!.state;
    }, { timeout: 180000, intervals: [1000] }).toBe("failed");
    const failed = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    expect(failed.installation.activeReleaseId).toBe(release.id);
    expect(failed.operations[failedBuild.id]!.diagnostics.length).toBeGreaterThan(0);
    const retained = await client.invokeExtensionTool(conversationId, name, "echo", { text: "smoke" });
    expect(retained.success).toBe(true);
    expect(JSON.stringify(retained.output)).toContain("Received: smoke");

    fork.workspace = await edit(fork.workspace, source("Upgraded: "));
    const repaired = await buildWorkspace(client, fork);
    expect(Object.keys(repaired.releases)).toHaveLength(2);
    expect(repaired.installation.activeReleaseId).toBe(release.id);
    const replacement = await approve(repaired, fork.workspace);
    expect(replacement.releaseDigest).not.toBe(release.releaseDigest);
    await page.goto(chatUrl);
    await invokeToolFromComposer(page, name);
    await expect(page.getByText("Upgraded: smoke", { exact: false }).first()).toBeVisible({ timeout: 90000 });
    await captureEvidence(page, testInfo, "extension-real-upgraded-output");
  } finally {
    await client.extensionControl("extensions_release", { action: "uninstall", installationId: created.installation.id });
  }
});
