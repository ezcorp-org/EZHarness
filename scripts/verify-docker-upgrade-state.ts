import { strict as assert } from "node:assert";
import { productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import type { InstallationState, LifecycleApproval, LifecycleRelease, WorkspaceRecord } from "../src/extensions/v4/types";

type UpgradeState = {
  owner: { id: string; email: string; name: string; role: string };
  installation: Pick<InstallationState["installation"], "id" | "ownerId" | "scope" | "activeReleaseId" | "generation" | "acknowledgedGeneration" | "enabled" | "uninstalled" | "status" | "grants">;
  workspace: WorkspaceRecord;
  release: LifecycleRelease;
  approval: LifecycleApproval;
  conversationId: string;
  wired: { id: string; name: string }[];
  name: string;
  storage: { key: string; value: string; output: unknown };
};

const mode = required("EZ_UPGRADE_MODE");
const statePath = required("EZ_UPGRADE_STATE_FILE");
const { client, sessionJson, createBuild, approveAndActivate } = await productionLifecycleClient();

function ownerSnapshot(body: unknown): UpgradeState["owner"] {
  assert(body && typeof body === "object" && "user" in body, "Owner response has no user record");
  assert(body.user && typeof body.user === "object", "Owner response has an invalid user record");
  const user = body.user as Record<string, unknown>;
  const fields = ["id", "email", "name", "role"] as const;
  for (const field of fields) assert.equal(typeof user[field], "string", `Owner ${field} is missing`);
  return { id: user.id as string, email: user.email as string, name: user.name as string, role: user.role as string };
}

function installationSnapshot(state: InstallationState): UpgradeState["installation"] {
  const { id, ownerId, scope, activeReleaseId, generation, acknowledgedGeneration, enabled, uninstalled, status, grants } = state.installation;
  return { id, ownerId, scope, activeReleaseId, generation, acknowledgedGeneration, enabled, uninstalled, status, grants };
}

function storedValue(output: unknown): string | undefined {
  if (typeof output === "object" && output !== null && "text" in output && typeof output.text === "string") return output.text;
  if (typeof output === "string") {
    try {
      const parsed = JSON.parse(output) as { text?: unknown };
      return typeof parsed.text === "string" ? parsed.text : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

if (mode === "seed") {
  const marker = `upgrade-sentinel-${crypto.randomUUID()}`;
  const name = `upgrade-state-${Date.now().toString(36)}`;
  const storageKey = "upgrade-sentinel";
  const manifest = { schemaVersion: 4, name, version: "1.0.0", description: "durable upgrade sentinel", author: { name: "Upgrade verification" }, permissions: { storage: true }, tools: [{ name: "echo", description: "store or read a sentinel", inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }], smokeTest: { tool: "echo", input: { text: "smoke" }, expect: { textIncludes: "smoke" } } };
  const source = `import { defineExtension, serve } from "@ezcorp/sdk/v4";\nimport { Storage } from "@ezcorp/sdk/runtime";\nexport type SentinelStore = { get(key: string): Promise<{ value: string | null; exists: boolean }>; set(key: string, value: string): Promise<unknown> };\nexport function createEcho(storage: SentinelStore) { return async (input: { text?: unknown }) => { if (typeof input.text === "string") await storage.set(${JSON.stringify(storageKey)}, input.text); const saved = await storage.get(${JSON.stringify(storageKey)}); return { text: saved.value ?? "" }; }; }\nconst extension = defineExtension({ manifest: ${JSON.stringify(manifest)}, tools: { echo: createEcho(new Storage("global")) } });\nawait serve(extension);\n`;
  const featureTest = `import { expect, test } from "bun:test";\nimport { createEcho } from "./extension";\ntest("writes and reads the sentinel through its storage boundary", async () => { const values = new Map<string, string>(); const echo = createEcho({ async get(key) { return { value: values.get(key) ?? null, exists: values.has(key) }; }, async set(key, value) { values.set(key, value); } }); expect(await echo({ text: "feature-sentinel" })).toEqual({ text: "feature-sentinel" }); expect(await echo({})).toEqual({ text: "feature-sentinel" }); });\n`;
  const created = await createBuild(name, { "extension.ts": source, "extension.test.ts": featureTest });
  const release = created.release;
  const active = await approveAndActivate(created.installation.id, release.id, null);
  const approval = Object.values(active.approvals).find(approval => approval.releaseId === release.id && approval.status === "consumed");
  assert(approval, "Activation must consume its human approval");
  const conversation = await client.createConversation({ title: "Upgrade lifecycle sentinel" });
  assert.deepEqual((await client.wireExtensions(conversation.id, [name])).wired, [name], "Extension did not wire to the seeded conversation");
  const result = await client.invokeExtensionTool(conversation.id, name, "echo", { text: marker });
  assert.equal(result.success, true);
  assert.equal(storedValue(result.output), marker, "Old image did not store and return the known value");
  const finalState = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: created.installation.id });
  const finalRelease = finalState.releases[release.id];
  const finalApproval = finalState.approvals[approval.id];
  const finalWorkspace = finalState.workspaces[created.workspace.id];
  assert(finalRelease && finalApproval && finalWorkspace, "Seeded lifecycle records are incomplete");
  const owner = ownerSnapshot(await sessionJson("/api/auth/me"));
  assert.equal(owner.id, finalState.installation.ownerId, "Lifecycle installation owner is not the seeded human record");
  const expected: UpgradeState = { owner, installation: installationSnapshot(finalState), workspace: finalWorkspace, release: finalRelease, approval: finalApproval, conversationId: conversation.id, wired: [{ id: created.installation.id, name }], name, storage: { key: storageKey, value: marker, output: result.output } };
  await Bun.write(statePath, `${JSON.stringify(expected)}\n`);
  console.log("UPGRADE_STATE_SEEDED");
} else if (mode === "assert") {
  const expected = await Bun.file(statePath).json() as UpgradeState;
  assert.deepEqual(ownerSnapshot(await sessionJson("/api/auth/me")), expected.owner, "Exact owner record changed");
  const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: expected.installation.id });
  assert.deepEqual(installationSnapshot(state), expected.installation, "Installation owner, identity, generation, grants, or activation changed");
  assert.deepEqual(state.workspaces[expected.workspace.id], expected.workspace, "Exact workspace record changed");
  assert.deepEqual(state.releases[expected.release.id], expected.release, "Exact verified release record changed");
  assert.deepEqual(state.approvals[expected.approval.id], expected.approval, "Exact human approval record changed");
  const wired = await client.listWiredExtensions(expected.conversationId);
  assert.deepEqual(wired, expected.wired, "Existing conversation link changed");
  const result = await client.invokeExtensionTool(expected.conversationId, expected.name, "echo");
  assert.equal(result.success, true);
  assert.deepEqual(result.output, expected.storage.output, "Stored value or known old-image output changed");
  assert.equal(storedValue(result.output), expected.storage.value, "Stored lifecycle value changed");
  console.log("UPGRADE_STATE_ASSERTED");
} else {
  throw new Error(`Unknown EZ_UPGRADE_MODE: ${mode}`);
}
