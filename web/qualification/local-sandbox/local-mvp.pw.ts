/** Hardware qualification. Requires the real rootless runtime and private host
 * config. The model response alone is scripted; application, approval, provider
 * worker, database, native tools, container and filesystem remain real. */
import { test, expect } from "../../e2e/fixtures/hydration.js";
import { captureEvidence } from "../../e2e/fixtures/evidence";
import { importAndActivateBundledExtension } from "../../e2e/fixtures/extension-v4";

test("local native workspace survives browser disconnect and disposes cleanly @evidence", async ({ page, request, baseURL }, testInfo) => {
  const { client, state } = await importAndActivateBundledExtension({ page, request, baseURL: baseURL!, name: "local-sandbox" });
  const providers = await request.get("/api/sandboxes/providers");
  expect(providers.status(), await providers.text()).toBe(200);
  expect((await providers.json()).providers).toContainEqual(expect.objectContaining({ installationId: state.installation.id, providerId: "local", ready: true }));
  await page.goto("/project/global/settings");
  const panel = page.getByTestId("project-sandbox-panel");
  await expect(panel.getByRole("button", { name: /Create a dedicated sandbox/ })).toBeVisible();
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/sandboxes" && response.request().method() === "POST");
  await panel.getByRole("button", { name: /Create a dedicated sandbox/ }).click();
  const created = await createdResponse;
  expect(created.status(), await created.text()).toBe(201);
  const { project } = await created.json();
  await expect(page).toHaveURL(new RegExp(`/project/${project.id}/settings$`));
  await expect(panel.getByText("stopped", { exact: true })).toBeVisible();
  const key = `sandbox-${crypto.randomUUID()}`;
  const marker = `NATIVE_${crypto.randomUUID().replaceAll("-", "")}`;
  const calls = [
    { name: "shell", arguments: { command: `printf '%s\\n' '${marker}' > marker.txt; printf '%s\\n' 'import {test,expect} from "bun:test"; test("sandbox",()=>expect(2+2).toBe(4));' > local.test.ts; bun test`, timeout: 30000 } },
    { name: "readFile", arguments: { path: "marker.txt" } },
    { name: "listFiles", arguments: { path: ".", pattern: "*.txt" } },
    { name: "readDirectory", arguments: { path: "." } },
    { name: "glob", arguments: { pattern: "*.txt" } },
    { name: "grep", arguments: { pattern: marker } },
    { name: "editFile", arguments: { path: "marker.txt", old_string: marker, new_string: `${marker}_EDITED` } },
    { name: "shell", arguments: { command: "cat marker.txt", timeout: 30000 } },
  ];
  const script = await request.post("/api/__test/mock-llm/script", { data: { scriptKey: key, turns: [...calls.map(call => ({ toolCalls: [call] })), { text: "Native checks complete" }] } });
  expect(script.status(), await script.text()).toBe(200);
  const conversation = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${key}`, title: "Local sandbox qualification" });
  const result = await client.runToCompletion(conversation.id, "Run the local native checks", { permissionMode: "yolo", timeoutMs: 240000 });
  expect(result.outcome, JSON.stringify(result)).toBe("complete");
  const messages = await request.get(`/api/conversations/${conversation.id}/messages`);
  expect(messages.status(), await messages.text()).toBe(200);
  const saved = JSON.stringify(await messages.json());
  expect(saved).toContain(`${marker}_EDITED`);
  expect(saved).toContain("1 pass");
  expect(saved).not.toContain("Sandbox workspace is unavailable");
  await page.goto(`/project/${project.id}/chat/${conversation.id}`);
  await page.reload();
  const readKey = `${key}-read`;
  expect((await request.post("/api/__test/mock-llm/script", { data: { scriptKey: readKey, turns: [{ toolCalls: [{ name: "readFile", arguments: { path: "marker.txt" } }] }, { text: "Persistence checked" }] } })).status()).toBe(200);
  const resumed = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${readKey}` });
  expect((await client.runToCompletion(resumed.id, "Read the persisted marker", { permissionMode: "yolo", timeoutMs: 120000 })).outcome).toBe("complete");
  const persisted = await request.get(`/api/conversations/${resumed.id}/messages`);
  expect(JSON.stringify(await persisted.json())).toContain(`${marker}_EDITED`);
  await page.goto(`/project/${project.id}/settings`);
  await captureEvidence(page, testInfo, "local-sandbox-real-desktop", { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureEvidence(page, testInfo, "local-sandbox-real-mobile", { fullPage: true });
  await panel.getByRole("button", { name: "Dispose…" }).click();
  await panel.getByRole("button", { name: "Dispose sandbox", exact: true }).click();
  await expect(panel.getByText("destroyed", { exact: true })).toBeVisible();
});
