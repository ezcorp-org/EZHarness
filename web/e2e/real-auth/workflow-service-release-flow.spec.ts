import { test, expect } from "../fixtures/hydration.js";
import { captureEvidence } from "../fixtures/evidence";
import { buildWorkspace, extensionClient, requestRelease, type CreatedWorkspace } from "../fixtures/extension-v4";
import type { WorkspaceRecord } from "../../../src/extensions/v4/types";

test("a human consents to a sealed service workflow; a real worker cannot fire after revocation @evidence", async ({ page, request, baseURL }, testInfo) => {
  test.setTimeout(300000);
  const { client, key } = await extensionClient(request, baseURL!);
  const name = `service-flow-${Date.now().toString(36)}`;
  const jobRef = crypto.randomUUID();
  const marker = `sealed-service-${crypto.randomUUID()}`;
  const created = await client.extensionControl<CreatedWorkspace>("extensions_workspace", { action: "create", name });
  const manifest = {
    schemaVersion: 4, name, version: "1.0.0", description: "Real service delegation proof", author: { name: "E2E" }, entrypoint: "./extension.ts",
    permissions: { workflows: { names: [], allowDelegated: true }, storage: true, filesystem: ["/data"] },
    tools: ["fire", "observe", "inspect"].map(tool => ({ name: tool, description: tool === "fire" ? "Fire the exact human-consented job" : tool === "inspect" ? "Read the persisted effect count without writes" : "Report the service principal and execute approved storage and data operations", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: { type: "object" } })),
  };
  const workspace = await client.extensionControl<WorkspaceRecord>("extensions_workspace", {
    action: "edit", installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision,
    deletes: ["src/echo.ts", "src/echo.test.ts"],
    writes: {
      "manifest.json": JSON.stringify(manifest),
      "manifest.test.ts": 'import { test, expect } from "bun:test";\nimport manifest from "./manifest.json";\ntest("only exact delegated jobs and bounded data are declared", () => { expect(manifest.permissions.workflows).toEqual({ names: [], allowDelegated: true }); expect(manifest.permissions.storage).toBe(true); expect(manifest.permissions.filesystem).toEqual(["/data"]); expect(manifest.tools.map(tool => tool.name)).toEqual(["fire", "observe", "inspect"]); });\n',
      "extension.ts": `import { createRuntimeExtension, getInvocationContext, serve } from "@ezcorp/sdk/v4";
import { createToolDispatcher, toolResult, Workflows, Storage, fsRead, fsWrite } from "@ezcorp/sdk/runtime";
import manifest from "./manifest.json";
const storage = new Storage("global");
const readState = async () => ({ storage: (await storage.get("proof")).value, file: await fsRead("/data/proof.json") });
const extension = await createRuntimeExtension({ manifest, register: async () => {
  createToolDispatcher({
    fire: async () => toolResult(JSON.stringify(await new Workflows().runFor({ jobRef: ${JSON.stringify(jobRef)}, input: {} }))),
    observe: async () => {
      const previous = await storage.get<{ count: number }>("proof");
      const value = { count: (previous.value?.count ?? 0) + 1, marker: ${JSON.stringify(marker)} };
      await storage.set("proof", value);
      await fsWrite("/data/proof.json", JSON.stringify(value));
      return toolResult(JSON.stringify({ principalId: getInvocationContext()?.principalId, ...await readState() }));
    },
    inspect: async () => toolResult(JSON.stringify(await readState()))
  });
} });
await serve(extension);
`,
      "service.workflow.yaml": `name: service\ndescription: Sealed service identity proof\nsteps:\n  - name: proof\n    kind: transform\n    output:\n      marker: ${marker}\n  - name: identity\n    kind: tool\n    dependsOn: [proof]\n    tool: ${name}__observe\n    input: {}\n`,
    },
  });
  const state = await buildWorkspace(client, { ...created, workspace });
  const approval = await requestRelease(client, state);
  const machineApproval = await fetch(`${baseURL}/api/extensions/releases/${created.installation.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ approvalId: approval.id, decision: true }),
  });
  expect(machineApproval.status).toBe(403);
  await page.goto(created.openUrl);
  const approve = page.getByRole("button", { name: "Approve exact release", exact: true });
  await expect(approve).toBeDisabled();
  await page.getByLabel("I reviewed this release and its permissions.").check();
  await captureEvidence(page, testInfo, "service-workflow-exact-release-review", { fullPage: true });
  await approve.click();
  await page.getByRole("button", { name: "Activate approved release", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable installation", exact: true })).toBeEnabled();

  const serviceResponse = await request.post("/api/service-accounts", { data: { name, scopes: ["read", "write"], maxTokensPerDay: 10000 } });
  expect(serviceResponse.status(), await serviceResponse.text()).toBe(201);
  const { account } = await serviceResponse.json();
  const consent = { extensionId: created.installation.id, workflowName: `${name}:service`, ownerKind: "service", ownerServiceAccountId: account.id, triggerKind: "manual" };
  const preview = await request.post("/api/workflows/delegations/preview", { data: consent });
  expect(preview.status(), await preview.text()).toBe(200);
  const consentBody = { ...consent, jobRef, maxTokensPerRun: 1000, maxRunsPerDay: 10 };
  const forged = await request.post("/api/workflows/delegations", { data: { ...consentBody, extensionReleaseBinding: "forged" } });
  expect(forged.status()).toBe(400);
  const delegated = await request.post("/api/workflows/delegations", { data: consentBody });
  expect(delegated.status(), await delegated.text()).toBe(201);
  const { delegation } = await delegated.json();
  const conversationResponse = await request.post("/api/conversations", { data: { projectId: "global", title: name } });
  expect(conversationResponse.status(), await conversationResponse.text()).toBe(201);
  const conversation = await conversationResponse.json();
  expect((await client.wireExtensions(conversation.id, [name])).wired).toEqual([name]);
  const fired = await client.invokeExtensionTool(conversation.id, name, "fire", {});
  expect(fired.success, JSON.stringify(fired)).toBe(true);
  expect(fired.output).toContain('"started":true');
  const readRuns = async () => {
    const response = await request.get("/api/workflows/delegated-runs");
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json() as { runs: Array<{ id: string; delegationId: string; status: string; runAsKind: string; runAs: string }> }).runs.filter(run => run.delegationId === delegation.id);
  };
  await expect.poll(async () => (await readRuns())[0]?.status ?? "pending", { timeout: 30000 }).not.toMatch(/^(pending|running)$/);
  const runs = await readRuns();
  expect(runs).toHaveLength(1);
  const [run] = runs;
  expect(run).toMatchObject({ runAsKind: "service", runAs: account.id });
  const traceResponse = await request.get(`/api/workflows/runs/${run!.id}`);
  expect(traceResponse.status(), await traceResponse.text()).toBe(200);
  const trace = await traceResponse.json();
  expect(trace.run, JSON.stringify(trace)).toMatchObject({ userId: null, jobRef, status: "success" });
  expect(trace.steps).toHaveLength(2);
  expect(trace.steps.find((step: { stepName: string }) => step.stepName === "proof").output).toEqual({ success: true, output: { marker } });
  const stored = { count: 1, marker };
  const persisted = { storage: stored, file: JSON.stringify(stored) };
  expect(trace.steps.find((step: { stepName: string }) => step.stepName === "identity").output).toEqual({ success: true, output: { principalId: account.id, ...persisted } });
  const inspectState = async () => {
    const result = await client.invokeExtensionTool(conversation.id, name, "inspect", {});
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (typeof result.output !== "string") throw new Error("The real inspection tool must return JSON text");
    return JSON.parse(result.output);
  };
  expect(await inspectState()).toEqual(persisted);
  const revoked = await request.delete(`/api/workflows/delegations/${delegation.id}`);
  expect(revoked.status(), await revoked.text()).toBe(200);
  expect(await revoked.json()).toEqual({ revoked: true });
  const denied = await client.invokeExtensionTool(conversation.id, name, "fire", {});
  expect(denied.success, JSON.stringify(denied)).toBe(false);
  expect((await readRuns()).map(item => item.id)).toEqual([run!.id]);
  expect(await inspectState()).toEqual(persisted);
  await client.extensionControl("extensions_release", { action: "disable", installationId: created.installation.id });
});
