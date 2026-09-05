import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();
const { workflowServiceReleaseFixture } = await import("./helpers/workflow-service-release");
const { createServiceInvocation } = await import("../extensions/service-invocation");
const { assertServiceCapabilities } = await import("../extensions/service-capabilities");
const { requestedReleaseGrants } = await import("../extensions/extension-control");
const { releaseBinding, configureReleaseRuntime } = await import("../extensions/release-process");
const { workflowDelegationReleaseBinding } = await import("../runtime/workflow-release-assets");
const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { workflowDelegations, serviceAccounts, extensions, projects, projectMembers } = await import("../db/schema");
const { buildFullGrantFromManifest } = await import("../extensions/install-grant");
const { createPermissionEngine } = await import("../extensions/permission-engine");
const { EventBus } = await import("../runtime/events");
const { handleStorageRpc, productionStorageRepository } = await import("../extensions/storage-handler");
const { withRuntimeToolContext } = await import("../extensions/runtime-tool-context");
const { registerCallProvenance, releaseCallProvenance } = await import("../extensions/call-provenance");
const { routeReverseRpc } = await import("../extensions/tool-executor/rpc-handlers");
const { handlePiFsWrite } = await import("../extensions/tool-executor/fs-rpc");
const { handleVirtualFilesystemRpc } = await import("../extensions/virtual-filesystem");
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture(projectRoot?: string) {
  const setup = await workflowServiceReleaseFixture();
  const { db, release } = setup;
  const authority = { ...setup.authority, projectId: projectRoot ? "project" : null };
  if (projectRoot) {
    await db.insert(projects).values({ id: "project", name: "Service project", path: projectRoot });
    await db.insert(projectMembers).values({ projectId: "project", userId: "owner", role: "member" });
    await db.update(serviceAccounts).set({ projectId: "project" }).where(eq(serviceAccounts.id, "service"));
    await db.update(workflowDelegations).set({ projectId: "project" }).where(eq(workflowDelegations.id, "delegation"));
  }
  release.snapshot.release.manifest.permissions = { storage: true, filesystem: ["/data", "/project"] };
  release.snapshot.installation.grants = requestedReleaseGrants(release.snapshot.release.manifest);
  release.entry.extensionRelease!.binding = releaseBinding(release.snapshot);
  const capabilities = [{ kind: "tool", value: "write" }, { kind: "storage", value: null }, { kind: "fs.read", value: "/data" }, { kind: "fs.write", value: "/data" }];
  if (projectRoot) capabilities.push({ kind: "fs.read", value: "/project" }, { kind: "fs.write", value: "/project" });
  await db.update(workflowDelegations).set({ capabilitySet: capabilities, extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry) }).where(eq(workflowDelegations.id, "delegation"));
  await db.update(serviceAccounts).set({ scopes: ["write"] }).where(eq(serviceAccounts.id, "service"));
  const manifest = release.snapshot.release.manifest as unknown as import("../extensions/types").ExtensionManifestV2;
  const granted = buildFullGrantFromManifest(manifest);
  await db.update(extensions).set({ source: "release-v4", manifest, grantedPermissions: granted }).where(eq(extensions.id, "installation"));
  await insertWorkflowRun({ id: "run", workflowName: release.entry.definition.name, definitionHash: workflowExecutionHash(release.entry.definition, release.entry.extensionRelease), startedAt: new Date(), input: {}, userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation", projectId: authority.projectId });
  const proof = await createServiceInvocation(release.entry, authority, "run");
  const registry = { getManifest: () => manifest, getGrantedPermissions: () => granted } as unknown as import("../extensions/registry").ExtensionRegistry;
  const engine = createPermissionEngine({ registry, bus: new EventBus<import("../types").AgentEvents>(), db });
  return { ...setup, proof, engine, manifest, granted, registry };
}

test("service consent authorizes approved installation storage without a human identity", async () => {
  const { proof, engine } = await fixture();
  await assertServiceCapabilities(proof, "installation", [{ kind: "storage" }], { toolName: "write", rbacScope: "write" });
  expect(await engine.authorize({ extensionId: "installation", userId: null, conversationId: null, serviceInvocation: proof }, [{ kind: "storage" }])).toMatchObject({ decision: "allow" });
  expect(await engine.authorize({ extensionId: "installation", userId: null, conversationId: null, serviceInvocation: proof }, [{ kind: "fs.write", value: "/data/result" }])).toMatchObject({ decision: "allow" });
  expect(await engine.authorize({ extensionId: "installation", userId: "owner", conversationId: null, serviceInvocation: proof }, [{ kind: "storage" }])).toMatchObject({ decision: "deny" });
});

test("service effects reject forged proofs and capabilities outside exact consent", async () => {
  const { proof } = await fixture();
  await expect(assertServiceCapabilities({ ...proof }, "installation", [])).rejects.toThrow("issued by the host");
  await expect(assertServiceCapabilities(proof, "installation", [], { toolName: "foreign" })).rejects.toThrow("consent closure");
  await expect(assertServiceCapabilities(proof, "installation", [], { rbacScope: "manage" })).rejects.toThrow("RBAC");
  await expect(assertServiceCapabilities(proof, "installation", [{ kind: "fs.write", value: "/project/private" }])).rejects.toThrow("consent");
});

test("a live source delegation cannot authorize a different owner's target installation", async () => {
  const { release, proof } = await fixture();
  const target = structuredClone(release.snapshot);
  target.installation.id = "target";
  target.installation.ownerId = "different-owner";
  target.release.installationId = "target";
  configureReleaseRuntime({ runner: async () => release.runner, resolve: async id => id === "installation" ? release.snapshot : id === "target" ? target : null });
  await expect(assertServiceCapabilities(proof, "target", [{ kind: "storage" }], { toolName: "write" })).rejects.toThrow("cannot access this extension installation");
  target.installation.ownerId = "owner";
  await assertServiceCapabilities(proof, "target", [{ kind: "storage" }], { toolName: "write" });
  target.installation.scope = "project:foreign";
  await expect(assertServiceCapabilities(proof, "target", [{ kind: "storage" }], { toolName: "write" })).rejects.toThrow("cannot access this extension installation");
});

test("service storage uses real SQL and rejects conversation or user buckets", async () => {
  const { proof, engine, manifest, granted } = await fixture();
  const context = { userId: "unknown", conversationId: "unknown", manifest, grantedPermissions: granted, engine };
  await withRuntimeToolContext({ serviceInvocation: proof }, async () => {
    const written = await handleStorageRpc("installation", { jsonrpc: "2.0", id: "set", method: "ezcorp/storage", params: { action: "set", key: "service-proof", value: { actor: "service" } } }, context);
    expect(written.error).toBeUndefined();
    const read = await handleStorageRpc("installation", { jsonrpc: "2.0", id: "get", method: "ezcorp/storage", params: { action: "get", key: "service-proof" } }, context);
    expect(read.result).toMatchObject({ value: { actor: "service" } });
    for (const scope of ["user", "conversation"]) {
      expect((await handleStorageRpc("installation", { jsonrpc: "2.0", id: scope, method: "ezcorp/storage", params: { action: "get", key: "service-proof", scope } }, context)).error?.code).toBe(-32106);
    }
  });
});

test("storage consent is checked in the exact mutation transaction and failure rolls back", async () => {
  const { db, proof, engine, manifest, granted } = await fixture();
  let guarded = false;
  const repository: import("../extensions/storage-handler").StorageRepository = { ...productionStorageRepository, transaction: (extensionId, operation, guard) => productionStorageRepository.transaction(extensionId, operation, async transaction => {
    expect(transaction).not.toBe(db);
    expect(guard).toBeDefined();
    guarded = true;
    await transaction!.execute(sql`UPDATE workflow_delegations SET capability_set='[]'::jsonb WHERE id='delegation'`);
    await guard!(transaction);
  }) };
  const request = { jsonrpc: "2.0" as const, id: "write", method: "ezcorp/storage", params: { action: "set", key: "revoked", value: "must-not-commit" } };
  await expect(withRuntimeToolContext({ serviceInvocation: proof }, () => handleStorageRpc("installation", request, { userId: "unknown", conversationId: "unknown", manifest, grantedPermissions: granted, engine, repository }))).rejects.toThrow("consent");
  expect(guarded).toBe(true);
  const rows = await db.select().from(workflowDelegations).where(eq(workflowDelegations.id, "delegation"));
  expect(rows[0]?.capabilitySet).toContainEqual({ kind: "storage", value: null });
  const { extensionStorage } = await import("../db/schema");
  expect(await db.select().from(extensionStorage).where(eq(extensionStorage.extensionId, "installation"))).toEqual([]);
});

test("reverse service tokens reach only bounded storage and filesystem handlers", async () => {
  const { proof, engine, manifest, granted, registry } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "service-fs-"));
  const token = registerCallProvenance({ onBehalfOf: null, conversationId: null, runId: "run", parentCallId: null, actorExtensionId: "installation", kind: "tool", ownerless: false, serviceInvocation: proof, invocationGuard: async database => { await assertServiceCapabilities(proof, "installation", [], { toolName: "write", database }); } });
  const context = { userId: "unknown", conversationId: "unknown", manifest, grantedPermissions: granted, engine };
  const self = {
    handlePiStorage: (id: string, request: import("../extensions/types").JsonRpcRequest) => handleStorageRpc(id, request, context),
    handlePiFsWrite: (id: string, request: import("../extensions/types").JsonRpcRequest) => handlePiFsWrite({ engine, registry, virtualFilesystem: { roots: async () => ({ data: directory }) } }, id, request),
  } as unknown as import("../extensions/tool-executor/rpc-handlers").ReverseRpcDispatch;
  const request = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0" as const, id: crypto.randomUUID(), method, params: { ...params, _meta: { ezCallId: token } } });
  try {
    expect((await routeReverseRpc(self, "installation", request("ezcorp/storage", { action: "set", key: "from-worker", value: "service" }))).error).toBeUndefined();
    expect((await routeReverseRpc(self, "installation", request("ezcorp/fs.write", { path: "/data/result.txt", content: "service-data" }))).error).toBeUndefined();
    expect(await readFile(join(directory, "result.txt"), "utf8")).toBe("service-data");
    for (const method of ["ezcorp/agent-configs", "ezcorp/spawn-assignment", "ezcorp/api.request", "ezcorp/credentials.read", "ezcorp/env.get", "ezcorp/project.pullRequest"]) {
      expect((await routeReverseRpc(self, "installation", request(method))).error?.code).toBe(-32106);
    }
    expect((await routeReverseRpc(self, "foreign", request("ezcorp/storage", { action: "get", key: "from-worker" }))).error?.code).toBe(-32106);
    expect((await routeReverseRpc(self, "installation", request("ezcorp/fs.write", { path: "/project/foreign", content: "denied" }))).error).toBeDefined();
    proof.close();
    expect((await routeReverseRpc(self, "installation", request("ezcorp/storage", { action: "get", key: "from-worker" }))).error?.code).toBe(-32106);
  } finally { releaseCallProvenance(token); await rm(directory, { recursive: true, force: true }); }
});

test("service project files use the host-bound project and stop after membership revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "service-project-"));
  try {
    const { db, proof, engine, registry } = await fixture(directory);
    const context = { extensionId: "installation", userId: "unknown", conversationId: "unknown", serviceInvocation: proof, engine, registry };
    const request = { jsonrpc: "2.0" as const, id: "write", method: "ezcorp/fs.write", params: { path: "/project/proof.txt", content: "bounded", projectId: "foreign" } };
    expect((await handleVirtualFilesystemRpc("write", request, context)).error).toBeUndefined();
    expect(await readFile(join(directory, "proof.txt"), "utf8")).toBe("bounded");
    const read = await handleVirtualFilesystemRpc("read", { ...request, method: "ezcorp/fs.read", params: { path: "/project/proof.txt" } }, context);
    expect(read.error).toBeUndefined();
    expect(read.result).toMatchObject({ body: Buffer.from("bounded").toString("base64") });
    expect((await handleVirtualFilesystemRpc("write", { ...request, params: { ...request.params, path: "/project/../escape" } }, context)).error).toBeDefined();
    await db.delete(projectMembers).where(eq(projectMembers.projectId, "project"));
    expect((await handleVirtualFilesystemRpc("write", { ...request, params: { ...request.params, content: "revoked" } }, context)).error).toBeDefined();
    expect(await readFile(join(directory, "proof.txt"), "utf8")).toBe("bounded");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["tool-closure", "rbac-scope"] as const)("a waiting worker loses %s before any reverse storage effect", async mutation => {
  const { db, release, proof, engine, manifest, registry } = await fixture();
  const tool = { name: "write", description: "Write", rbacScope: "write", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const } };
  manifest.tools = [tool];
  release.snapshot.release.manifest.tools = [tool];
  const { ToolExecutor } = await import("../extensions/tool-executor");
  const { ReleaseProcess } = await import("../extensions/release-process");
  const { workflowScopeKey } = await import("../runtime/workflow-scope-key");
  const entered = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  let reverseAttempts = 0;
  configureReleaseRuntime({ resolve: async id => id === "installation" ? release.snapshot : null, runner: async () => ({ ...release.runner, start: async (start, host) => {
    const worker = await release.runner.start(start, host);
    return { ...worker, request: async (method, params) => {
      if (method !== "extension/invoke") return worker.request(method, params);
      entered.resolve();
      await resumed.promise;
      reverseAttempts++;
      return host("ezcorp/storage", { context: start.context, input: { action: "set", key: "after-revocation", value: "forbidden" } });
    } };
  } }) });
  const process = new ReleaseProcess("installation");
  Object.assign(registry, { getRegisteredTool: () => ({ ...tool, extensionId: "installation", originalName: "write" }), getProcess: async () => process });
  const executor = new ToolExecutor(registry, engine);
  const pending = executor.executeToolCall("write", {}, workflowScopeKey("run"), null, { serviceInvocation: proof });
  try {
    await entered.promise;
    if (mutation === "rbac-scope") await db.update(serviceAccounts).set({ scopes: [] }).where(eq(serviceAccounts.id, "service"));
    else await db.update(workflowDelegations).set({ capabilitySet: [{ kind: "storage", value: null }] }).where(eq(workflowDelegations.id, "delegation"));
    resumed.resolve();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(mutation === "rbac-scope" ? "RBAC" : "consent closure");
    expect(reverseAttempts).toBe(1);
    const { extensionStorage } = await import("../db/schema");
    expect(await db.select().from(extensionStorage).where(eq(extensionStorage.extensionId, "installation"))).toEqual([]);
  } finally { resumed.resolve(); proof.close(); }
});

test.each(["capability", "scope", "service", "delegation", "owner", "project", "grants"] as const)("live %s changes revoke service effects", async mutation => {
  const { db, release, proof } = await fixture();
  if (mutation === "capability") await db.update(workflowDelegations).set({ capabilitySet: [] }).where(eq(workflowDelegations.id, "delegation"));
  if (mutation === "scope") await db.update(serviceAccounts).set({ scopes: [] }).where(eq(serviceAccounts.id, "service"));
  if (mutation === "service") await db.update(serviceAccounts).set({ enabled: false }).where(eq(serviceAccounts.id, "service"));
  if (mutation === "delegation") await db.update(workflowDelegations).set({ revokedAt: new Date() }).where(eq(workflowDelegations.id, "delegation"));
  if (mutation === "owner") release.snapshot.installation.ownerId = "foreign";
  if (mutation === "project") release.snapshot.installation.scope = "project:foreign";
  if (mutation === "grants") release.snapshot.installation.grants = [];
  await expect(assertServiceCapabilities(proof, "installation", [{ kind: "storage" }], { toolName: "write", rbacScope: "write" })).rejects.toThrow();
});
