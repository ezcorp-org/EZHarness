/** Hardware qualification. Requires the real rootless runtime and private host
 * config. The model response alone is scripted; application, approval, provider
 * worker, database, native tools, container and filesystem remain real. */
import { readFile } from "node:fs/promises";
import { resourcePaths } from "../../../src/runtime/sandbox/local-podman/commands";
import { test, expect } from "../../e2e/fixtures/hydration.js";
import { captureEvidence } from "../../e2e/fixtures/evidence";
import { importAndActivateBundledExtension } from "../../e2e/fixtures/extension-v4";

test("local native workspace survives browser disconnect and disposes cleanly @evidence", async ({ page: initialPage, request, baseURL, context }, testInfo) => {
  let page = initialPage;
  const { client, state } = await importAndActivateBundledExtension({ page, request, baseURL: baseURL!, name: "local-sandbox" });
  const providers = await request.get("/api/sandboxes/providers");
  expect(providers.status(), await providers.text()).toBe(200);
  expect((await providers.json()).providers).toContainEqual(expect.objectContaining({ installationId: state.installation.id, providerId: "local", ready: true }));
  await page.goto("/project/global/settings");
  let panel = page.getByTestId("project-sandbox-panel");
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
  const script = await request.post("/api/__test/mock-llm/script", { data: { scriptKey: key, turns: [...calls.map((call, index) => ({ toolCalls: [{ ...call, id: `${key}-${index}` }] })), { text: "Native checks complete" }] } });
  expect(script.status(), await script.text()).toBe(200);
  const conversation = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${key}`, title: "Local sandbox qualification" });
  const result = await client.runToCompletion(conversation.id, "Run the local native checks", { permissionMode: "yolo", timeoutMs: 240000 });
  expect(result.outcome, JSON.stringify(result)).toBe("complete");
  const messages = await request.get(`/api/conversations/${conversation.id}/messages?withToolCalls=true`);
  expect(messages.status(), await messages.text()).toBe(200);
  const history = await messages.json();
  const actualCalls = [...history.messages.flatMap((message: { toolCalls?: unknown[] }) => message.toolCalls ?? []), ...history.orphanedToolCalls];
  expect(actualCalls).toHaveLength(calls.length);
  expect(actualCalls.every(call => call.status === "success"), JSON.stringify(actualCalls)).toBe(true);
  const saved = actualCalls.map(call => call.fullOutput ?? call.outputSummary).join("\n");
  expect(saved).toContain(`${marker}_EDITED`);
  expect(saved).toContain("1 pass");
  expect(saved).not.toContain("Sandbox workspace is unavailable");
  await page.goto(`/project/${project.id}/chat/${conversation.id}`);
  await page.reload();
  const readKey = `${key}-read`;
  expect((await request.post("/api/__test/mock-llm/script", { data: { scriptKey: readKey, turns: [{ toolCalls: [{ name: "readFile", arguments: { path: "marker.txt" } }] }, { text: "Persistence checked" }] } })).status()).toBe(200);
  const resumed = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${readKey}` });
  expect((await client.runToCompletion(resumed.id, "Read the persisted marker", { permissionMode: "yolo", timeoutMs: 120000 })).outcome).toBe("complete");
  const persisted = await request.get(`/api/conversations/${resumed.id}/messages?withToolCalls=true`);
  expect(JSON.stringify(await persisted.json())).toContain(`${marker}_EDITED`);
  // Observe the real supervisor before disconnecting and cancelling. This
  // reads only the qualification host's owned metadata, never changes it.
  const host = JSON.parse(await readFile(process.env.EZHARNESS_LOCAL_SANDBOX_CONFIG!, "utf8"));
  const status = await (await request.get(`/api/projects/${project.id}/sandbox`)).json();
  const paths = resourcePaths(host.stateRoot, status.resource.resourceId);
  const processStatus = async () => JSON.parse(await readFile(`${paths.output}/process/status.json`, "utf8"));
  const cancelKey = `${key}-cancel`;
  expect((await request.post("/api/__test/mock-llm/script", { data: { scriptKey: cancelKey, turns: [{ toolCalls: [{ name: "shell", arguments: { command: "printf waiting > cancel-started.txt; sleep 120; printf should-not-exist > cancel-failed.txt", timeout: 180000 } }] }, { text: "Cancelled command settled" }] } })).status()).toBe(200);
  const cancellable = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${cancelKey}` });
  const active = await client.sendMessage(cancellable.id, "Run until cancelled", { permissionMode: "yolo" });
  expect(active.runId).toBeTruthy();
  await expect.poll(async () => (await processStatus()).state, { timeout: 60000 }).toBe("running");
  await page.close();
  expect((await processStatus()).state).toBe("running");
  page = await context.newPage();
  panel = page.getByTestId("project-sandbox-panel");
  await page.goto(`/project/${project.id}/settings`);
  expect((await client.cancelRun(active.runId!)).ok).toBe(true);
  expect((await client.awaitRun(active.runId!, 60000)).outcome).toBe("cancel");
  await expect.poll(async () => (await processStatus()).state, { timeout: 30000 }).toBe("cancelled");
  const recoveryKey = `${key}-recovery`;
  expect((await request.post("/api/__test/mock-llm/script", { data: { scriptKey: recoveryKey, turns: [{ toolCalls: [{ name: "shell", arguments: { command: "test ! -e cancel-failed.txt && cat marker.txt", timeout: 30000 } }] }, { text: "Cancellation recovery checked" }] } })).status()).toBe(200);
  const recovered = await client.createConversation({ projectId: project.id, provider: "ezcorp-mock", model: `mock:${recoveryKey}` });
  expect((await client.runToCompletion(recovered.id, "Check the retained workspace", { permissionMode: "yolo", timeoutMs: 120000 })).outcome).toBe("complete");
  expect(JSON.stringify(await (await request.get(`/api/conversations/${recovered.id}/messages?withToolCalls=true`)).json())).toContain(`${marker}_EDITED`);
  await page.reload();
  await captureEvidence(page, testInfo, "local-sandbox-real-desktop", { fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureEvidence(page, testInfo, "local-sandbox-real-mobile", { fullPage: true });
  await panel.getByRole("button", { name: "Dispose…" }).click();
  await panel.getByRole("button", { name: "Dispose sandbox", exact: true }).click();
  await expect(panel.getByText("destroyed", { exact: true })).toBeVisible();
});
