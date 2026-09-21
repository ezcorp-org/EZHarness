import { strict as assert } from "node:assert";
import { productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import { assertInstallationIdentityPreserved, assertOldProfileRefused, runnerProfileChanged, type ToolInvocationResult } from "./lib/runner-profile-transition";
import type { InstallationState, LifecycleApproval, LifecycleOperation, LifecycleRelease, WorkspaceRecord } from "../src/extensions/v4/types";

type UpgradeState = {
  owner: { id: string; email: string; name: string; role: string };
  installation: Pick<InstallationState["installation"], "id" | "ownerId" | "scope" | "activeReleaseId" | "generation" | "acknowledgedGeneration" | "enabled" | "uninstalled" | "status" | "grants">;
  workspace: WorkspaceRecord;
  release: LifecycleRelease;
  approval: LifecycleApproval;
  conversationId: string;
  wired: { id: string; name: string }[];
  name: string;
  runnerImage: string;
  storage: { key: string; value: string; output: unknown };
};

const mode = required("EZ_UPGRADE_MODE");
const statePath = required("EZ_UPGRADE_STATE_FILE");
const currentRunnerImage = required("EZ_UPGRADE_RUNNER_IMAGE");
const { client, sessionJson, createBuild, waitVerified, approveAndActivate } = await productionLifecycleClient();

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
  assert.equal(release.imageDigest, currentRunnerImage, "Seed release did not use the archived runner profile");
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
  const expected: UpgradeState = { owner, installation: installationSnapshot(finalState), workspace: finalWorkspace, release: finalRelease, approval: finalApproval, conversationId: conversation.id, wired: [{ id: created.installation.id, name }], name, runnerImage: currentRunnerImage, storage: { key: storageKey, value: marker, output: result.output } };
  await Bun.write(statePath, `${JSON.stringify(expected)}\n`);
  console.log("UPGRADE_STATE_SEEDED");
} else if (mode === "assert") {
  const expected = await Bun.file(statePath).json() as UpgradeState;
  assert.equal(expected.release.imageDigest, expected.runnerImage, "Seed receipt runner profile differs from its release evidence");
  assert.deepEqual(ownerSnapshot(await sessionJson("/api/auth/me")), expected.owner, "Exact owner record changed");
  const state = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: expected.installation.id });
  assert.deepEqual(state.workspaces[expected.workspace.id], expected.workspace, "Exact workspace record changed");
  assert.deepEqual(state.releases[expected.release.id], expected.release, "Exact verified release record changed");
  assert.deepEqual(state.approvals[expected.approval.id], expected.approval, "Exact human approval record changed");
  const wired = await client.listWiredExtensions(expected.conversationId);
  assert.deepEqual(wired, expected.wired, "Existing conversation link changed");

  if (runnerProfileChanged(expected.release, currentRunnerImage)) {
    let oldProfileAttempt: ToolInvocationResult;
    try {
      oldProfileAttempt = await client.invokeExtensionTool(expected.conversationId, expected.name, "echo");
    } catch (error) {
      oldProfileAttempt = { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    assertOldProfileRefused(oldProfileAttempt);

    const operation = await client.extensionControl<LifecycleOperation>("extensions_build", {
      installationId: expected.installation.id,
      workspaceId: expected.workspace.id,
      expectedRevision: expected.workspace.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    const verified = await waitVerified(expected.installation.id, operation.id);
    const rebuiltReleaseId = verified.operations[operation.id]?.releaseId;
    assert(rebuiltReleaseId, "Runner-profile rebuild produced no release");
    const rebuiltRelease = verified.releases[rebuiltReleaseId];
    assert(rebuiltRelease, "Runner-profile rebuild release is absent");
    assert.equal(rebuiltRelease.imageDigest, currentRunnerImage, "Rebuilt release did not use the current runner profile");
    assert.notEqual(rebuiltRelease.id, expected.release.id, "Runner-profile rebuild reused the old release");
    const active = await approveAndActivate(expected.installation.id, rebuiltRelease.id, expected.release.id);
    assertInstallationIdentityPreserved(state.installation, active.installation);
    assert.equal(active.installation.activeReleaseId, rebuiltRelease.id, "Rebuilt release is not active");
    assert(Object.values(active.approvals).some(approval => approval.releaseId === rebuiltRelease.id && approval.status === "consumed"), "Rebuilt release lacks a consumed human approval");
    assert.deepEqual(active.approvals[expected.approval.id], expected.approval, "Runner-profile rebuild changed the prior approval record");
    console.log(`RUNNER_PROFILE_REBUILT ${expected.runnerImage} -> ${currentRunnerImage}`);
  } else {
    assert.equal(currentRunnerImage, expected.runnerImage, "Release profile matches but the recorded runner profile changed");
    assert.deepEqual(installationSnapshot(state), expected.installation, "Installation owner, identity, generation, grants, or activation changed");
  }

  const result = await client.invokeExtensionTool(expected.conversationId, expected.name, "echo");
  assert.equal(result.success, true);
  assert.deepEqual(result.output, expected.storage.output, "Stored value or known old-image output changed");
  assert.equal(storedValue(result.output), expected.storage.value, "Stored lifecycle value changed");
  console.log("UPGRADE_STATE_ASSERTED");
} else {
  throw new Error(`Unknown EZ_UPGRADE_MODE: ${mode}`);
}
