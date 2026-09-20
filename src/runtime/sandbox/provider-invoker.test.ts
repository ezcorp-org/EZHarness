import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { providerMethodSchemas, sha256, type ExtensionManifestV4, type Runner, type SandboxProviderMethodGroup } from "@ezcorp/extension-contract";
import { sql } from "drizzle-orm";
import { configureHostApiTransport } from "../../extensions/host-api-broker";
import { buildFullGrantFromManifest } from "../../extensions/install-grant";
import { _setPermissionEngineForTests } from "../../extensions/permission-engine";
import { releaseBinding, configureReleaseRuntime } from "../../extensions/release-process";
import { ExtensionRegistry } from "../../extensions/registry";
import { requestedReleaseGrants } from "../../extensions/bundled-drift-reapprove";
import { digestObject } from "../../extensions/v4/blobs";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import { mockDbConnection, setupTestDb, closeTestDb, getTestDb } from "../../__tests__/helpers/test-pglite";
import { projectMembers, projects, users } from "../../db/schema";
import { invokeSandboxProvider } from "./provider-invoker";

mockDbConnection();

const call = { operationId: "operation", idempotencyKey: "retry", requestDigest: "a".repeat(64) };
const limits = { memoryBytes: 128 * 1024 * 1024, milliCpu: 500, pids: 64, diskBytes: 32 * 1024 * 1024 };
const groups: SandboxProviderMethodGroup[] = [
  { name: "sandbox.lifecycle.v1", methods: { create: "sandbox/create", inspect: "sandbox/inspect", start: "sandbox/start", stop: "sandbox/stop", destroy: "sandbox/destroy" } },
  { name: "sandbox.process.v1", methods: { start: "process/start", inspect: "process/inspect", readOutput: "process/output", cancel: "process/cancel" } },
  { name: "sandbox.files.v1", methods: { stat: "files/stat", list: "files/list", read: "files/read", write: "files/write", mkdir: "files/mkdir", remove: "files/remove", chmod: "files/chmod" } },
];
const methods = groups.flatMap(group => Object.entries(group.methods).map(([operation, name]) => ({ name, ...providerMethodSchemas(group.name, operation as never), sensitivity: "ordinary" as const })));
const manifest: ExtensionManifestV4 = {
  schemaVersion: 4,
  name: "provider-fixture",
  version: "1.0.0",
  description: "Fixture",
  author: { name: "Test" },
  permissions: { hostApi: { events: false, routes: [{ method: "POST", path: "/api/local-sandbox/operations/:id/execute" }] } },
  methods,
  providers: [{
    id: "local",
    kind: "sandbox",
    protocolMajor: 1,
    minimumHostContract: { major: 4, minor: 0 },
    profiles: ["linux-exec.v1"],
    capabilities: [],
    configSchema: { type: "object", additionalProperties: false },
    requiredPermissions: ["hostApi"],
    methodGroups: groups,
  }],
};

describe("invokeSandboxProvider", () => {
  let userId: string;
  let projectId: string;
  let authorProjectId: string;
  let installationId: string;
  let bindingId: string;
  let reference: { installationId: string; providerId: string; releaseId: string; releaseBinding: string; generation: number };
  let response: unknown;
  let hostResults: Map<string, unknown>;
  let dispatches: number;
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    await setupTestDb();
    ExtensionRegistry.resetInstance();
    _setPermissionEngineForTests(createStubPermissionEngine("allow-all"));
    const db = getTestDb();
    const [user] = await db.insert(users).values({ email: `${crypto.randomUUID()}@test.local`, passwordHash: "fixture", name: "User", role: "member", status: "active" }).returning();
    const [project, authorProject] = await db.insert(projects).values([{ name: "Sandbox Project", path: "/tmp/project" }, { name: "Author Project", path: "/tmp/author-project" }]).returning();
    userId = user!.id;
    dispatches = 0;
    hostResults = new Map();
    projectId = project!.id;
    authorProjectId = authorProject!.id;
    await db.insert(projectMembers).values({ userId, projectId });
    installationId = crypto.randomUUID();
    bindingId = crypto.randomUUID();
    const releaseId = crypto.randomUUID();
    const snapshot = {
      installation: { id: installationId, ownerId: userId, scope: "global", activeReleaseId: releaseId, generation: 1, enabled: true, uninstalled: false, status: "active" as const, acknowledgedGeneration: 1, grants: requestedReleaseGrants(manifest) },
      release: { id: releaseId, installationId, workspaceId: crypto.randomUUID(), workspaceRevision: 1, sourceDigest: digestObject(manifest), artifactDigest: digestObject(manifest), releaseDigest: digestObject(manifest), imageDigest: `sha256:${"a".repeat(64)}`, runnerProfile: "test", policyDigest: "b".repeat(64), manifest, evidence: { protocolVersion: 4 as const, validatorVersion: "test", tests: [{ name: "fixture", passed: true }], discoveryDigest: digestObject(manifest) }, createdAt: new Date().toISOString() },
      limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 30_000 },
    };
    reference = { installationId, providerId: "local", releaseId, releaseBinding: await sha256(releaseBinding(snapshot)), generation: 1 };
    const runner: Runner = {
      async build() { throw new Error("unused"); }, async cancel() {}, async inspect() { return { id: "fixture", state: "running", diagnostics: [] }; }, async collectArtifacts() { throw new Error("unused"); },
      async start(start, reverse) {
        return { workerId: start.workerId, close: async () => {}, onNotification: () => () => {}, request: async (method, params) => {
          if (method === "extension/discover") return manifest;
          if (method !== "extension/dispatch") throw new Error(`Unexpected ${method}`);
          dispatches += 1;
          const dispatch = params as { input: Record<string, unknown>; context: unknown };
          const operationId = String((dispatch.input.call as { operationId: string }).operationId);
          const api = await reverse("ezcorp/api.request", { context: dispatch.context, input: { method: "POST", path: `/api/local-sandbox/operations/${operationId}/execute` } });
          expect(api).toEqual({ status: 200, body: JSON.stringify(response) });
          return response;
        } };
      },
    };
    configureReleaseRuntime({ runner: async () => runner, resolve: async id => id === installationId ? snapshot : null });
    registry = ExtensionRegistry.getInstance();
    registry.setManifestForTest(installationId, manifest);
    registry.setGrantedPermsForTest(installationId, buildFullGrantFromManifest(manifest, 0));
    await db.execute(sql`INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES (${installationId}, ${userId}, 'global', ${JSON.stringify(snapshot.installation)})`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS sandbox_provider_bindings (id TEXT PRIMARY KEY, project_id TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL, installation_id TEXT NOT NULL, provider_id TEXT NOT NULL, release_id TEXT NOT NULL, release_binding TEXT NOT NULL, generation INTEGER NOT NULL, config_revision INTEGER NOT NULL, config_digest TEXT NOT NULL, state TEXT NOT NULL)`);
    await db.execute(sql`INSERT INTO extension_project_bindings (installation_id, payload) VALUES (${installationId}, ${JSON.stringify({ id: crypto.randomUUID(), projectId: authorProjectId, ownerId: userId, releaseId, generation: 1, approvedAt: new Date().toISOString(), writePaths: [] })})`);
    await db.execute(sql`INSERT INTO sandbox_provider_bindings (id, project_id, owner_id, installation_id, provider_id, release_id, release_binding, generation, config_revision, config_digest, state) VALUES (${bindingId}, ${projectId}, ${userId}, ${installationId}, 'local', ${releaseId}, ${reference.releaseBinding}, 1, 1, ${"c".repeat(64)}, 'active')`);
    configureHostApiTransport({ request: async (actingUserId, request) => {
      expect(actingUserId).toBe(userId);
      expect(request).toEqual({ method: "POST", path: expect.stringMatching(/^\/api\/local-sandbox\/operations\/[a-zA-Z0-9_-]+\/execute$/) });
      const operationId = request.path.split("/")[4]!;
      hostResults.set(operationId, response);
      return { status: 200, body: JSON.stringify(response) };
    }, events: async () => ({ cursor: "0", events: [] }) });
  });

  afterEach(async () => { await closeTestDb(); });

  test("runs the reviewed release through the authenticated host API broker", async () => {
    response = { receipt: { ...call, outcome: "succeeded" }, resource: { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits } };
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", { call: { scope: { projectId, bindingId, generation: 1 }, ...call }, profile: "linux-exec.v1", limits })).resolves.toEqual(response);
  });

  test("returns a persisted canonical destroy result through the reviewed reply", async () => {
    const destroyCall = { operationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), requestDigest: "d".repeat(64) };
    response = { receipt: { ...destroyCall, outcome: "succeeded" }, resource: { resourceId: "resource", desiredState: "destroyed", observedState: "destroyed", limits } };
    const input = { call: { scope: { projectId, bindingId, generation: 1 }, ...destroyCall }, resourceId: "resource" };

    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "destroy", input)).resolves.toEqual(response);
    expect(hostResults.get(destroyCall.operationId)).toEqual(response);
  });

  test("denies missing members, inactive users, revoked bindings, and forged provider results", async () => {
    response = { receipt: { ...call, outcome: "succeeded" }, resource: { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits } };
    const input = { call: { scope: { projectId, bindingId, generation: 1 }, ...call }, profile: "linux-exec.v1", limits };
    await getTestDb().delete(projectMembers).where(sql`${projectMembers.userId} = ${userId}`);
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).rejects.toThrow("active project member");
    await getTestDb().insert(projectMembers).values({ userId, projectId });
    await getTestDb().update(users).set({ status: "inactive" }).where(sql`${users.id} = ${userId}`);
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).rejects.toThrow("active project member");
    await getTestDb().update(users).set({ status: "active" }).where(sql`${users.id} = ${userId}`);
    await getTestDb().execute(sql`DELETE FROM sandbox_provider_bindings WHERE project_id = ${projectId}`);
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).rejects.toThrow("not approved");
    await getTestDb().execute(sql`INSERT INTO sandbox_provider_bindings (id, project_id, owner_id, installation_id, provider_id, release_id, release_binding, generation, config_revision, config_digest, state) VALUES (${bindingId}, ${projectId}, ${userId}, ${installationId}, 'local', ${reference.releaseId}, ${reference.releaseBinding}, 1, 1, ${"c".repeat(64)}, 'active')`);
    response = { receipt: { ...call, outcome: "succeeded", operationId: "forged" }, resource: { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits } };
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).rejects.toThrow("receipt changed operationId");
  });

  test("does not dispatch a reviewed provider or its host callback after cancellation", async () => {
    response = { receipt: { ...call, outcome: "succeeded" }, resource: { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits } };
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    const input = { call: { scope: { projectId, bindingId, generation: 1 }, ...call }, profile: "linux-exec.v1" as const, limits };

    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input, controller.signal)).rejects.toThrow("Cancelled");
    expect(dispatches).toBe(0);
  });

  test("accepts the published grant projection but rejects an extra broker route", async () => {
    response = { receipt: { ...call, outcome: "succeeded" }, resource: { resourceId: "resource", desiredState: "stopped", observedState: "stopped", limits } };
    const input = { call: { scope: { projectId, bindingId, generation: 1 }, ...call }, profile: "linux-exec.v1" as const, limits };
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).resolves.toEqual(response);

    const grant = buildFullGrantFromManifest(manifest, 0);
    registry.setGrantedPermsForTest(installationId, { ...grant, hostApi: { events: false, routes: [...grant.hostApi!.routes, { method: "POST", path: "/api/extra" }] } });
    await expect(invokeSandboxProvider(userId, projectId, reference, "sandbox.lifecycle.v1", "create", input)).rejects.toThrow("broker is not bound");
  });
});
