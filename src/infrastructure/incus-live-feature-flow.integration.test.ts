import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sandboxPresetDigest, type SandboxProtocolOperation } from "@ezcorp/extension-contract";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addExtensionReleases } from "../db/migrations/add-extension-releases";
import { up as addProviderConnections } from "../db/migrations/add-provider-connections";
import * as schema from "../db/schema";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController } from "../sandboxes/controller";
import { IncusDispatchAuthorizationError, IncusSandboxProviderDispatcher, type HostAuthorizedIncusMethodCaller } from "../sandboxes/incus-dispatcher";
import { createProviderSandboxWorkspaceBackend } from "../runtime/workspaces/provider-backend";
import { IncusFeatureService } from "./incus-feature-service";
import { IncusWorkspaceCaller } from "./incus-workspace-caller";
import { ProviderConnectionStore } from "./provider-connections/store";

const open: PGlite[] = [];
const now = Date.parse("2026-09-22T12:00:00Z");
const preset = INCUS_PRESETS[0]!;

async function fixture() {
  const pglite = new PGlite();
  open.push(pglite);
  await pglite.waitReady;
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addExtensionReleases(db);
  await addProviderConnections(db);
  await addSandboxController(db);
  await db.insert(schema.projects).values({ id: "project", name: "project", path: "/work/host-canary" });
  const runtime = releaseRuntimeFixture("installation", incusManifest);
  const snapshot = runtime.snapshot;
  const installation = snapshot.installation;
  const release = snapshot.release;
  const approval = { id: "approval", installationId: installation.id, releaseId: release.id,
    releaseDigest: release.releaseDigest, principalId: installation.ownerId, scope: installation.scope,
    status: "consumed", expectedGeneration: 0 };
  await pglite.query("INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES ($1, $2, $3, $4)",
    [installation.id, installation.ownerId, installation.scope, JSON.stringify(installation)]);
  for (const [kind, record] of [["releases", release], ["approvals", approval]] as const) {
    await pglite.query("INSERT INTO extension_release_records (installation_id, kind, id, payload) VALUES ($1, $2, $3, $4)",
      [installation.id, kind, record.id, JSON.stringify(record)]);
  }
  const connections = new ProviderConnectionStore(db);
  await connections.create({ id: "connection", providerInstallationId: installation.id,
    providerReleaseId: release.id, endpoint: "https://incus.example:8443", serverCertificatePem: "server-cert",
    project: "ezharness", configuration: { kind: "incus", profile: "ezharness", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: "client-cert", privateKeyPem: "private-key-canary" });
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  let guestState: "absent" | "stopped" | "running" = "absent";
  let guestGeneration = 1;
  const network: Array<{ method: string; input: Record<string, unknown> }> = [];
  const guestCalls: Array<{ operation: SandboxProtocolOperation; input: Record<string, unknown> }> = [];
  const receipts = new Map<string, { kind: string; observedState: "absent" | "stopped" | "running" }>();
  const activeRelease = async () => snapshot;
  const caller: HostAuthorizedIncusMethodCaller = { call: async (scope, method, input) => {
    // This is the deterministic network/guest boundary. Every dispatch must carry
    // authority from the durable binding and a live, approved connection.
    const binding = await db.query.sandboxBindings.findFirst();
    if (!binding || binding.id !== scope.bindingId || binding.providerReleaseId !== release.id
      || binding.connectionRevision !== scope.connectionRevision || binding.presetDigest !== presetDigest) {
      throw new IncusDispatchAuthorizationError("SCOPE_INVALID");
    }
    try { await connections.resolveForHost({ connectionId: scope.connectionId,
      providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId, revision: scope.connectionRevision }); }
    catch { throw new IncusDispatchAuthorizationError("CONNECTION_REVOKED"); }
    network.push({ method, input });
    if (method === "incus/lifecycle/inspectOperation") {
      const receipt = receipts.get(String(input.operationId));
      if (!receipt) throw new Error("Unknown guest operation");
      return { ok: true, operation: { operationId: input.operationId, kind: receipt.kind,
        sandboxId: input.sandboxId, state: "succeeded", desiredState: receipt.observedState,
        observedState: receipt.observedState, resourceId: null, startedAt: "2026-09-22T12:00:00Z",
        finishedAt: "2026-09-22T12:00:01Z", error: null } };
    }
    const kind = method.endsWith("create") ? "create" : method.endsWith("destroy") ? "destroy" : "setPower";
    guestState = kind === "create" ? "stopped" : kind === "destroy" ? "absent"
      : input.desiredState === "running" ? "running" : "stopped";
    if (kind === "setPower") guestGeneration++;
    const operationId = `guest-${receipts.size + 1}`;
    receipts.set(operationId, { kind, observedState: guestState });
    return { ok: true, receipt: { operationId, kind, requestId: input.requestId,
      idempotencyKey: input.idempotencyKey, sandboxId: input.sandboxId, acceptedAt: "2026-09-22T12:00:00Z" } };
  } };
  const controller = new SandboxController(db, new IncusSandboxProviderDispatcher(caller));
  const admission = new SandboxAdmissionStore(db);
  const service = new IncusFeatureService({ db, controller, admission, activeRelease,
    connectionRevision: async id => (await connections.getMetadata(id))?.revision ?? null,
    resolveConnection: scope => connections.resolveForHost(scope),
    loadQualification: async () => ({ producer: "live-provider", connectionId: "connection", providerId: "incus",
      presetId: preset.id, profile: preset.profile, releaseDigest: release.releaseDigest,
      presetDigest, effectiveSettingsDigest, backendVersion: "6.0.6",
      verifiedAt: "2026-09-22T11:00:00Z", validUntil: "2026-09-23T11:00:00Z", cases: [] }),
    assertReady: async () => {}, now: () => now,
    inspect: async (_installationId, bindingId) => ({ ok: true, sandbox: { sandboxId: bindingId,
      profile: preset.profile, presetId: preset.id, desiredState: guestState, observedState: guestState,
      generation: guestGeneration, bootId: "boot-1", observedAt: "2026-09-22T12:00:00Z" } }),
  });
  const workspaceCaller = new IncusWorkspaceCaller({ db, resolveRelease: activeRelease,
    resolveConnection: scope => connections.resolveForHost(scope), now: () => Date.now(),
    invoke: async (_installationId, _bindingId, operation, input) => {
      guestCalls.push({ operation, input });
      if (operation === "files.stat") return { ok: true, file: { path: input.path, kind: "file",
        revision: "guest-revision", sizeBytes: 5, executable: false } };
      if (operation === "files.readRange") return { ok: true, path: input.path, revision: "guest-revision",
        offsetBytes: input.offsetBytes, dataBase64: btoa("guest"), byteLength: 5, eof: true };
      if (operation === "processes.start") return { ok: true, processId: "process-1", bootId: "boot-1", startedAt: new Date().toISOString() };
      if (operation === "processes.readOutput") return { ok: true,
        chunks: [{ stream: "stdout", offsetBytes: 0, dataBase64: btoa("guest shell\n"), byteLength: 12 }],
        eof: true, nextCursor: { ...(input.cursor as object), offsetBytes: 12 } };
      if (operation === "processes.inspect") return { ok: true, process: { processId: "process-1", bootId: "boot-1",
        sandboxId: input.sandboxId, state: "succeeded", exitCode: 0, signal: null,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() } };
      throw new Error(`Unexpected guest operation: ${operation}`);
    } });
  const backend = createProviderSandboxWorkspaceBackend(workspaceCaller);
  await admission.configureHostCapacity({ providerInstallationId: installation.id, connectionId: "connection",
    allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis,
      pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  await admission.configureProjectQuota({ projectId: "project", providerInstallationId: installation.id,
    connectionId: "connection", limit: { memoryBytes: preset.limits.memoryBytes,
      cpuMillicores: preset.limits.cpuMillis, pids: preset.limits.pids,
      diskBytes: preset.limits.diskBytes, executionSlots: 1 } });
  return { db, pglite, snapshot, approval, connections, service, controller, admission, backend, network, guestCalls,
    presetDigest, effectiveSettingsDigest };
}

afterEach(async () => { await Promise.all(open.splice(0).map(database => database.close())); });

test("approved Incus feature routes file and shell to guest, denies stale pins, and settles destroy", async () => {
  const f = await fixture();
  const binding = await f.service.prepare({ projectId: "project", installationId: "installation",
    connectionId: "connection", presetId: preset.id });
  const request = (key: string) => ({ bindingId: binding.id, idempotencyScope: "feature", idempotencyKey: key });
  const created = await f.service.create(request("create"));
  expect(created.state).toBe("DISPATCHED");
  await f.service.reconcile();
  expect((await f.controller.getBinding(binding.id))?.observedState).toBe("STOPPED");
  await f.service.start(request("start"));
  await f.service.reconcile();
  const current = await f.controller.getBinding(binding.id);
  expect(current?.observedState).toBe("RUNNING");
  const workspace = { projectId: "project", workspaceId: binding.id, connectionId: "connection", providerId: "incus",
    generation: current!.generation, presetId: preset.id, releaseDigest: f.snapshot.release.releaseDigest,
    presetDigest: f.presetDigest, effectiveSettingsDigest: f.effectiveSettingsDigest };
  const read = await f.backend.execute({ binding: workspace, toolName: "readFile", toolCallId: "read",
    params: { path: "src/app.ts" } });
  expect(read.content).toEqual([{ type: "text", text: "guest" }]);
  const shell = await f.backend.execute({ binding: workspace, toolName: "shell", toolCallId: "shell",
    params: { command: "printf guest" } });
  expect(JSON.stringify(shell)).toContain("guest shell");
  expect(f.guestCalls.map(call => call.operation)).toEqual([
    "files.stat", "files.readRange", "processes.start", "processes.readOutput", "processes.inspect",
  ]);
  expect(f.guestCalls[2]?.input.user).toBe("sandbox");
  expect(JSON.stringify(f.guestCalls)).not.toContain("/work/host-canary");
  expect(JSON.stringify(f.network)).not.toContain("private-key-canary");
  const stale = await f.backend.execute({ binding: { ...workspace, releaseDigest: "stale" },
    toolName: "readFile", toolCallId: "stale", params: { path: "src/app.ts" } });
  expect(stale).toMatchObject({ details: { isError: true } });
  expect(JSON.stringify(stale)).toContain("release changed");
  const changedPreset = await f.backend.execute({ binding: { ...workspace, presetDigest: "changed" },
    toolName: "readFile", toolCallId: "changed-preset", params: { path: "src/app.ts" } });
  expect(changedPreset).toMatchObject({ details: { isError: true } });
  await f.pglite.query("UPDATE extension_release_records SET payload = $1 WHERE kind = 'approvals' AND id = 'approval'",
    [JSON.stringify({ ...f.approval, status: "revoked" })]);
  const unapproved = await f.backend.execute({ binding: workspace, toolName: "readFile",
    toolCallId: "unapproved", params: { path: "src/app.ts" } });
  expect(unapproved).toMatchObject({ details: { isError: true } });
  await f.pglite.query("UPDATE extension_release_records SET payload = $1 WHERE kind = 'approvals' AND id = 'approval'",
    [JSON.stringify(f.approval)]);
  expect(f.guestCalls).toHaveLength(5);
  await f.service.stop(request("stop"));
  await f.service.reconcile();
  const stopped = await f.backend.execute({ binding: workspace, toolName: "readFile", toolCallId: "stopped",
    params: { path: "src/app.ts" } });
  expect(stopped).toMatchObject({ details: { isError: true } });
  expect(JSON.stringify(stopped)).toContain("binding is unavailable");
  await f.service.start(request("reconnect"));
  await f.service.reconcile();
  expect((await f.controller.getBinding(binding.id))?.observedState).toBe("RUNNING");
  await f.connections.revoke("connection", 1);
  const revoked = await f.backend.execute({ binding: { ...workspace, generation: (await f.controller.getBinding(binding.id))!.generation },
    toolName: "readFile", toolCallId: "revoked", params: { path: "src/app.ts" } });
  expect(revoked).toMatchObject({ details: { isError: true } });
  expect(f.guestCalls).toHaveLength(5);
  // Restore the approved connection only for cleanup; revocation itself is permanent.
  await f.pglite.exec("UPDATE provider_connections SET revision = 1, revoked_at = NULL WHERE id = 'connection'");
  await f.service.stop(request("final-stop"));
  await f.service.reconcile();
  const destroyed = await f.service.destroy(request("destroy"));
  expect(destroyed.kind).toBe("DESTROY");
  await f.service.reconcile();
  expect((await f.controller.getBinding(binding.id))?.cleanupConfirmedAt).toBeInstanceOf(Date);
  expect((await f.admission.getReservation(binding.id))?.diskState).toBe("RELEASED");
  expect(f.network.map(call => call.method)).toEqual([
    "incus/lifecycle/create", "incus/lifecycle/inspectOperation", "incus/lifecycle/setPower",
    "incus/lifecycle/inspectOperation", "incus/lifecycle/setPower", "incus/lifecycle/inspectOperation",
    "incus/lifecycle/setPower", "incus/lifecycle/inspectOperation", "incus/lifecycle/setPower",
    "incus/lifecycle/inspectOperation", "incus/lifecycle/destroy", "incus/lifecycle/inspectOperation",
  ]);
});
