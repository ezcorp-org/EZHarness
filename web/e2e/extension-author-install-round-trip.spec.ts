/** Preserve dependency metadata through the current workspace/release flow. */
import { test, expect } from "./fixtures/hydration.js";
import { createAndActivateExtension, buildWorkspace, requestRelease, type CreatedWorkspace } from "./fixtures/extension-v4.js";
import type { InstallationState } from "../../src/extensions/v4/types";

test("compose a dependency in source → save → build → approve → activate → durable Uses chip", async ({ page, request, baseURL }) => {
  test.setTimeout(300_000);
  const dependencyName = `dependency-${crypto.randomUUID().slice(0, 8)}`;
  const { client, state: dependencyState } = await createAndActivateExtension({ page, request, baseURL: baseURL!, name: dependencyName });
  const listed = await request.get("/api/extensions");
  expect(listed.status(), await listed.text()).toBe(200);
  const dependencies = await listed.json() as Array<{ id: string; name: string; version: string; enabled: boolean }>;
  const dependency = dependencies.find((candidate) => candidate.id === dependencyState.installation.id);
  if (!dependency) throw new Error("The approved dependency must be installed before composition.");
  expect(dependency.enabled).toBe(true);
  const declared = { [dependency.name]: { source: "local", version: `^${dependency.version}` } };
  const name = `composed-${crypto.randomUUID().slice(0, 8)}`;
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });

  try {
    await page.goto(created.openUrl);
    await expect(page.getByRole("heading", { name: "Extension workspace", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "extension.ts", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Source: extension.ts", exact: true });
    const original = await editor.inputValue();
    expect(original).toContain('"permissions": {}');
    const source = original.replace('"permissions": {}', `"dependencies": ${JSON.stringify(declared)}, "permissions": {}`);
    await editor.fill(source);
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Saved revision");
    await page.reload();
    await page.getByRole("button", { name: "extension.ts", exact: true }).click();
    await expect(editor).toHaveValue(source);

    const saved = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
    created.workspace = saved.workspaces[created.workspace.id]!;
    expect(created.workspace.revision).toBeGreaterThan(1);
    const built = await buildWorkspace(client, created);
    const release = Object.values(built.releases).find((candidate) => candidate.workspaceRevision === created.workspace.revision);
    if (!release) throw new Error("The saved workspace revision must produce a verified release.");
    expect(release.manifest.dependencies).toEqual(declared);
    await requestRelease(client, built, release.id);
    await page.reload();
    const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
    await expect(approve).toBeDisabled();
    await page.getByLabel("I reviewed this release and its permissions.").check();
    await approve.click();
    await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
    await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

    const detail = await request.get(`/api/extensions/${created.installation.id}`);
    expect(detail.status(), await detail.text()).toBe(200);
    expect((await detail.json()).manifest.dependencies).toEqual(declared);
    await page.goto(`/extensions/${created.installation.id}`);
    const chip = page.getByTestId("extension-uses-chip");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute("data-dep-name", dependency.name);
    await expect(chip).toContainText(declared[dependency.name]!.version);
    await page.reload();
    await expect(chip).toBeVisible();
    await expect(chip).toContainText(dependency.name);
  } finally {
    for (const installationId of [created.installation.id, dependencyState.installation.id]) {
      const removed = await request.delete(`/api/extensions/${installationId}`);
      expect(removed.status(), await removed.text()).toBe(204);
    }
  }
});
