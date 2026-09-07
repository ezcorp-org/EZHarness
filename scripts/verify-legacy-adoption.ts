import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, productionLifecycleClient, required } from "./lib/production-lifecycle-client";
import { waitForBundledBootstrap, type BundledBootstrapState } from "./lib/shipping-bootstrap-state";
import type { InstallationState, LifecycleOperation } from "../src/extensions/v4/types";

type Receipt = {
  legacySource: string;
  candidateSource: string;
  owner: { id: string; email: string; name: string; role: string };
  installation: { id: string; name: string; ownerId: string; source: string; installPath: string; storageKey: string; value: string };
  conversationId: string;
  runnerCapacity?: BundledBootstrapState;
};

const mode = process.env.EZ_LEGACY_ADOPTION_MODE;
const receiptPath = process.env.EZ_LEGACY_ADOPTION_RECEIPT;
if (!mode || !receiptPath) throw new Error("Missing legacy-adoption lifecycle configuration");

const { client, sessionJson, waitVerified } = await productionLifecycleClient();
async function session<T = unknown>(path: string, body?: unknown): Promise<T> {
  return sessionJson<T>(path, body === undefined ? {} : { body });
}

function owner(body: unknown): Receipt["owner"] {
  assert(body && typeof body === "object" && "user" in body, "Missing authenticated owner");
  const user = body.user as Record<string, unknown>;
  for (const field of ["id", "email", "name", "role"] as const) assert.equal(typeof user[field], "string", `Owner ${field} missing`);
  return { id: user.id as string, email: user.email as string, name: user.name as string, role: user.role as string };
}

function legacyFiles(name: string, storageKey: string) {
  const config = `import { defineExtension } from "@ezcorp/sdk";\nexport default defineExtension({ schemaVersion: 2, name: ${JSON.stringify(name)}, version: "1.0.0", description: "legacy adoption sentinel", author: { name: "Upgrade verification" }, entrypoint: "./index.ts", tools: [{ name: "echo", description: "write and read the legacy sentinel", inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false } }], permissions: { storage: true } });\n`;
  const index = `import { createToolDispatcher, getChannel, Storage, toolResult } from "@ezcorp/sdk/runtime";\nconst store = new Storage("global");\nconst channel = getChannel();\nchannel.start();\ncreateToolDispatcher({ echo: async (input: unknown) => { const text = (input as { text?: unknown })?.text; if (typeof text === "string") await store.set(${JSON.stringify(storageKey)}, text); const result = await store.get<string>(${JSON.stringify(storageKey)}); return toolResult(result.value ?? ""); } });\n`;
  const handler = `export type Store = { get<T>(key: string): Promise<{ value: T | null; exists: boolean }>; set(key: string, value: string): Promise<unknown> };\nexport function createEcho(store: Store) { return async (input: { text?: unknown }) => { if (input.text === "smoke-sentinel") return { text: "smoke-sentinel" }; if (typeof input.text === "string") await store.set(${JSON.stringify(storageKey)}, input.text); const value = await store.get<string>(${JSON.stringify(storageKey)}); return { text: value.value ?? "" }; }; }\n`;
  const v4 = `import { defineExtension, serve } from "@ezcorp/sdk/v4";\nimport { Storage } from "@ezcorp/sdk/runtime";\nimport { createEcho } from "./handler";\nconst extension = defineExtension({ manifest: { schemaVersion: 4, name: ${JSON.stringify(name)}, version: "2.0.0", description: "adopted legacy sentinel", author: { name: "Upgrade verification" }, permissions: { storage: true }, tools: [{ name: "echo", description: "read the adopted sentinel", inputSchema: { type: "object", properties: { text: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }], smokeTest: { tool: "echo", input: { text: "smoke-sentinel" }, expect: { textIncludes: "smoke-sentinel" } } }, tools: { echo: createEcho(new Storage("global")) } });\nawait serve(extension);\n`;
  const test = `import { expect, test } from "bun:test";\nimport { createEcho } from "./handler";\ntest("writes then reads the retained global storage key", async () => { const values = new Map<string, string>(); const echo = createEcho({ async get<T>(key: string) { return { value: (values.get(key) ?? null) as T | null, exists: values.has(key) }; }, async set(key, value) { values.set(key, value); } }); expect(await echo({ text: "feature-sentinel" })).toEqual({ text: "feature-sentinel" }); expect(await echo({})).toEqual({ text: "feature-sentinel" }); });\n`;
  return { config, index, handler, v4, test };
}

function outputText(value: unknown): string | undefined {
  if (value && typeof value === "object" && "text" in value && typeof value.text === "string") return value.text;
  if (typeof value === "string") { try { const parsed = JSON.parse(value) as { text?: unknown }; return typeof parsed.text === "string" ? parsed.text : value; } catch { return value; } }
}

if (mode === "seed") {
  const container = required("EZ_PRODUCTION_CONTAINER");
  const name = `legacy-adopt-${Date.now().toString(36)}`;
  const storageKey = "legacy-adoption-sentinel";
  const value = `legacy-value-${crypto.randomUUID()}`;
  const source = await mkdtemp(join(tmpdir(), "ezcorp-legacy-adoption-"));
  try {
    const files = legacyFiles(name, storageKey);
    await Promise.all([writeFile(join(source, "ezcorp.config.ts"), files.config), writeFile(join(source, "index.ts"), files.index), writeFile(join(source, "handler.ts"), files.handler), writeFile(join(source, "extension.ts"), files.v4), writeFile(join(source, "extension.test.ts"), files.test)]);
    const installPath = `/app/.ezcorp/extensions/${name}`;
    await command("docker", ["exec", container, "mkdir", "-p", "/app/.ezcorp/extensions"]);
    await command("docker", ["cp", `${source}/.`, `${container}:${installPath}`]);
    const installed = await session("/api/extensions", { source: "local", path: installPath }) as { id: string; enabled?: boolean };
    assert.equal(typeof installed.id, "string", "Legacy install did not return its ID");
    assert.equal(installed.enabled, false, "Legacy install silently enabled");
    const active = await session(`/api/extensions/${installed.id}/activate`, { grantedPermissions: { storage: true } }) as { enabled?: boolean };
    assert.equal(active.enabled, true, "Legacy supported activation failed");
    const conversation = await client.createConversation({ title: "Legacy adoption sentinel" });
    assert.deepEqual((await client.wireExtensions(conversation.id, [name])).wired, [name], "Legacy extension did not wire");
    const invoked = await client.invokeExtensionTool(conversation.id, name, "echo", { text: value });
    assert.equal(invoked.success, true, `Legacy invocation failed: ${invoked.error}`);
    assert.equal(outputText(invoked.output), value, "Legacy extension did not persist its known value");
    const record = (await client.listExtensions()).find(extension => extension.id === installed.id);
    assert(record, "Installed legacy extension is absent from its supported listing");
    const authenticated = owner(await session("/api/auth/me"));
    // Historical main recorded the installer as governance audit provenance;
    // it intentionally did not populate the later creatorUserId column.
    assert.equal(record.creatorUserId, null, "Historical installation unexpectedly has a row owner");
    const audit = await session(`/api/extensions/${installed.id}/audit?legacy=1`) as { entries?: Array<{ userId?: unknown; action?: unknown; metadata?: unknown }> };
    assert(audit.entries?.some(entry => entry.userId === authenticated.id && entry.action === "ext:permission-granted"), "Legacy install audit does not identify the authenticated human owner");
    assert.equal(record.installPath, installPath, "Legacy interface did not preserve its host-owned source path");
    const receipt: Receipt = { legacySource: process.env.EZ_LEGACY_SOURCE ?? "537f074e7303ecdf3cbef1a7af4fd60a3244b0a3", candidateSource: process.env.EZ_CANDIDATE_SOURCE ?? "26541024", owner: authenticated, installation: { id: installed.id, name, ownerId: authenticated.id, source: String(record.source), installPath, storageKey, value }, conversationId: conversation.id };
    await Bun.write(receiptPath, `${JSON.stringify(receipt)}\n`);
    console.log("LEGACY_ADOPTION_SEEDED");
  } finally { await rm(source, { recursive: true, force: true }); }
} else if (mode === "adopt") {
  const receipt = await Bun.file(receiptPath).json() as Receipt;
  assert.deepEqual(owner(await session("/api/auth/me")), receipt.owner, "Owner identity changed across image upgrade");
  const legacyAttempt = await client.invokeExtensionTool(receipt.conversationId, receipt.installation.name, "echo");
  assert.equal(legacyAttempt.success, false, "Candidate ran a legacy extension before explicit v4 adoption");
  const runnerCapacity = await waitForBundledBootstrap(client);
  await Bun.write(receiptPath, `${JSON.stringify({ ...receipt, runnerCapacity })}\n`);
  assert.equal(runnerCapacity.terminalOperationStates.failed ?? 0, 0, `Candidate bootstrap has failed operations: ${JSON.stringify(runnerCapacity.terminalOperations)}`);
  const container = required("EZ_PRODUCTION_CONTAINER");
  const source = await mkdtemp(join(tmpdir(), "ezcorp-adopted-v4-source-"));
  try {
    const files = legacyFiles(receipt.installation.name, receipt.installation.storageKey);
    await Promise.all([writeFile(join(source, "handler.ts"), files.handler), writeFile(join(source, "extension.ts"), files.v4), writeFile(join(source, "extension.test.ts"), files.test)]);
    await command("docker", ["exec", container, "rm", "-f", `${receipt.installation.installPath}/ezcorp.config.ts`, `${receipt.installation.installPath}/index.ts`]);
    await command("docker", ["cp", `${source}/handler.ts`, `${container}:${receipt.installation.installPath}/handler.ts`]);
    await command("docker", ["cp", `${source}/extension.ts`, `${container}:${receipt.installation.installPath}/extension.ts`]);
    await command("docker", ["cp", `${source}/extension.test.ts`, `${container}:${receipt.installation.installPath}/extension.test.ts`]);
    await command("docker", ["exec", container, "test", "!", "-e", `${receipt.installation.installPath}/ezcorp.config.ts`]);
    await command("docker", ["exec", container, "test", "!", "-e", `${receipt.installation.installPath}/index.ts`]);
    for (const file of ["extension.ts", "handler.ts", "extension.test.ts"]) await command("docker", ["exec", container, "test", "-f", `${receipt.installation.installPath}/${file}`]);
  } finally { await rm(source, { recursive: true, force: true }); }
  const imported = await session("/api/extensions/import-source", { kind: "local", path: receipt.installation.installPath, targetInstallationId: receipt.installation.id }) as { installation: { id: string; ownerId: string }; workspace: { id: string }; operation: LifecycleOperation };
  assert.equal(imported.installation.id, receipt.installation.id, "Adoption replaced the legacy installation ID");
  assert.equal(imported.installation.ownerId, receipt.owner.id, "Adoption changed the legacy owner");
  const verified = await waitVerified(receipt.installation.id, imported.operation.id);
  assert.equal(verified.installation.id, receipt.installation.id, "Verified state changed installation identity");
  assert.equal(verified.installation.ownerId, receipt.owner.id, "Verified state changed installation owner");
  assert.equal(verified.installation.activeReleaseId, null, "Legacy execution silently became an active v4 release");
  assert.equal(verified.installation.enabled, false, "Legacy execution stayed enabled after adoption");
  assert.deepEqual(verified.installation.grants, [], "Legacy grants survived adoption");
  assert.equal(verified.installation.status, "disabled", "Adopted legacy installation is not disabled");
  assert.deepEqual(verified.approvals, {}, "Adoption created an approval before a human requested one");
  const wiredExtensions = await client.listWiredExtensions(receipt.conversationId);
  assert.deepEqual(
    wiredExtensions.filter(({ id }) => id === receipt.installation.id),
    [{ id: receipt.installation.id, name: receipt.installation.name }],
    "Adoption did not retain exactly one legacy conversation link",
  );
  const before = await client.invokeExtensionTool(receipt.conversationId, receipt.installation.name, "echo");
  assert.equal(before.success, false, "Adopted legacy code executed before a new release was approved");
  const releaseId = verified.operations[imported.operation.id]?.releaseId;
  assert(releaseId, "Verified adoption build lacks a release");
  const requested = await client.extensionControl<{ approval: { id: string } }>("extensions_release", { action: "requestApproval", installationId: receipt.installation.id, releaseId, expectedActiveReleaseId: null });
  const pending = await client.extensionControl<InstallationState>("extensions_inspect", { installationId: receipt.installation.id });
  assert.equal(pending.installation.activeReleaseId, null, "Requesting approval silently activated a release");
  await session(`/api/extensions/releases/${receipt.installation.id}/approve`, { approvalId: requested.approval.id, decision: true });
  await client.extensionControl("extensions_release", { action: "activate", installationId: receipt.installation.id, approvalId: requested.approval.id, idempotencyKey: crypto.randomUUID() });
  const output = await client.invokeExtensionTool(receipt.conversationId, receipt.installation.name, "echo");
  assert.equal(output.success, true, `Approved v4 adoption invocation failed: ${output.error}`);
  assert.equal(outputText(output.output), receipt.installation.value, "Approved v4 release did not read the legacy stored value");
  console.log("LEGACY_ADOPTION_ASSERTED");
} else throw new Error(`Unknown EZ_LEGACY_ADOPTION_MODE: ${mode}`);
