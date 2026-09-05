import { test, expect } from "../fixtures/hydration.js";
import { extensionClient, buildWorkspace, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import type { WorkspaceRecord } from "@ezcorp/extension-contract";

test("private browser cancellation reaches the actual HTTP worker and prevents later effects", async ({ page, request, baseURL }) => {
  test.setTimeout(180000);
  const { client } = await extensionClient(request, baseURL!);
  const name = `browser-cancel-${Date.now().toString(36)}`;
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  const manifest = { schemaVersion: 4, name, version: "1.0.0", description: "Actual cancellation boundary", author: { name: "Tests" }, permissions: { storage: true }, tools: ["hold", "read", "echo"].map(tool => ({ name: tool, description: tool, inputSchema: { type: "object" }, outputSchema: { type: "object" } })) };
  try {
    created.workspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", { action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, writes: {
      "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4';await serve(defineExtension({manifest:validateManifest(${JSON.stringify(manifest)}),tools:{echo:async(input)=>input,hold:async(_input,ctx)=>{await ctx.call('ezcorp/storage',{action:'set',scope:'user',key:'started',value:true});await Bun.sleep(4000);await ctx.call('ezcorp/storage',{action:'set',scope:'user',key:'late',value:true});return {done:true};},read:async(_input,ctx)=>({started:await ctx.call('ezcorp/storage',{action:'get',scope:'user',key:'started'}),late:await ctx.call('ezcorp/storage',{action:'get',scope:'user',key:'late'})})}}));`,
      "ezcorp.browser.json": JSON.stringify({ schemaVersion: 1, entrypoint: "app.js", html: "index.html", styles: [], tools: ["hold", "read"] }),
      "index.html": '<button id="start">Start held tool</button><button id="cancel">Cancel held tool</button><output id="result"></output>',
      "app.js": `import {createCanvasBridge} from '@ezcorp/sdk/browser';const client=createCanvasBridge(window);let controller;document.querySelector('#start').onclick=()=>{controller=new AbortController();client.request('tool.invoke',{toolName:'hold',input:{}},{signal:controller.signal}).then(()=>document.querySelector('#result').textContent='completed',error=>document.querySelector('#result').textContent=error.message);};document.querySelector('#cancel').onclick=()=>controller?.abort();`,
    } });
    const state = await buildWorkspace(client, created);
    const approval = await requestRelease(client, state);
    expect((await request.post(`/api/extensions/releases/${created.installation.id}/approve`, { data: { approvalId: approval.id, decision: true } })).status()).toBe(200);
    await client.extensionControl("extensions_release", { action: "activate", installationId: created.installation.id, approvalId: approval.id, idempotencyKey: crypto.randomUUID() });
    await page.goto(`/extensions/${name}/preview`);
    const select = page.getByLabel("New conversation project");
    await select.selectOption((await select.locator("option:not([disabled])").first().getAttribute("value"))!);
    await page.getByRole("button", { name: "Create preview conversation", exact: true }).click();
    await expect(page).toHaveURL(/conversationId=/);
    const conversationId = new URL(page.url()).searchParams.get("conversationId")!;
    await client.wireExtensions(conversationId, [name]);
    const frame = page.frameLocator("iframe");
    await frame.getByRole("button", { name: "Start held tool" }).press("Enter");
    await expect.poll(async () => {
      const result = await client.invokeExtensionTool(conversationId, name, "read", {});
      expect(result.success, JSON.stringify(result)).toBe(true);
      return JSON.parse(String(result.output)).started.value;
    }, { timeout: 10000, intervals: [100] }).toBe(true);
    await frame.getByRole("button", { name: "Cancel held tool" }).press("Enter");
    await expect(frame.locator("output")).toHaveText(/cancelled|abort/i);
    await new Promise(resolve => setTimeout(resolve, 5000));
    const final = await client.invokeExtensionTool(conversationId, name, "read", {});
    expect(final.success).toBe(true);
    expect(JSON.parse(String(final.output)).late).toEqual({ value: null, exists: false });
  } finally { await client.extensionControl("extensions_release", { action: "uninstall", installationId: created.installation.id, idempotencyKey: crypto.randomUUID() }); }
});
