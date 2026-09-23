import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import { up as addController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { SandboxController, type SandboxProviderRequest } from "../sandboxes/controller";
import { IncusFeatureService } from "./incus-feature-service";
import { IncusQualificationFixtureService, type IncusQualificationScope, type IncusQualificationStore } from "./incus-qualification";

const opened: PGlite[] = [];
const scope: IncusQualificationScope = { installationId: "installation", releaseId: "release",
  connectionId: "connection", presetId: INCUS_PRESETS[0]!.id };

async function setup(configureHost = true, pendingCreate = false) {
  const client = new PGlite();
  opened.push(client);
  await client.waitReady;
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await client.exec("CREATE TABLE project_workspace_bindings (project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, binding_id TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(client, { schema });
  await addController(db);
  await addQualificationFixtures(db);
  await addQualificationFixtures(db);
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const qualifications = { authorizeFixture: async () => ({ connection: { revision: 1 }, preset,
    presetDigest, effectiveSettingsDigest }) } as unknown as IncusQualificationStore;
  const dispatches: SandboxProviderRequest[] = [];
  const controller = new SandboxController(db, { dispatch: async request => {
    dispatches.push(request);
    if (pendingCreate && request.kind === "CREATE") {
      return { outcome: "PENDING", providerOperationId: `provider-${request.operationId}` };
    }
    return { outcome: "SUCCEEDED", observedState: request.kind === "DESTROY" ? "ABSENT" : "STOPPED" };
  }, inspectOperation: async request => ({ outcome: "SUCCEEDED",
    providerOperationId: request.providerOperationId ?? undefined, observedState: "STOPPED" }) });
  const admission = new SandboxAdmissionStore(db);
  if (configureHost) await admission.configureHostCapacity({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId,
    allocatable: { memoryBytes: 2 * preset.limits.memoryBytes, cpuMillicores: 2 * preset.limits.cpuMillis,
      pids: 2 * preset.limits.pids, diskBytes: 2 * preset.limits.diskBytes, executionSlots: 2 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 },
  });
  const service = new IncusQualificationFixtureService({ db, qualifications, admission, controller });
  return { db, service, dispatches, controller, admission, presetDigest, effectiveSettingsDigest };
}

afterEach(async () => { await Promise.all(opened.splice(0).map(client => client.close())); });

test("host fixture create and destroy use admission and durable controller without a user workspace binding", async () => {
  const { db, service, dispatches, controller, admission, presetDigest, effectiveSettingsDigest } = await setup();
  const created = await service.create(scope, "fixture-1");
  expect(created.state).toBe("SUCCEEDED");
  expect((await service.create(scope, "fixture-1")).id).toBe(created.id);
  expect(dispatches).toHaveLength(1);
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  expect(fixture).toMatchObject({ operationId: "fixture-1", ...scope,
    connectionRevision: 1, presetDigest, effectiveSettingsDigest });
  const [project] = await db.select().from(schema.projects);
  expect(project).toMatchObject({ id: fixture!.projectId, purpose: "incus-qualification" });
  expect(dispatches[0]?.binding).toMatchObject({ id: fixture!.bindingId, projectId: fixture!.projectId,
    connectionRevision: 1, presetDigest, effectiveSettingsDigest });
  expect(await db.select().from(schema.projectWorkspaceBindings)).toEqual([]);
  expect((await admission.getReservation(fixture!.bindingId))?.diskState).toBe("RESERVED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("STOPPED");
  const features = new IncusFeatureService({ db, controller, admission, loadQualification: async () => null });
  await expect(features.prepare({ projectId: fixture!.projectId, installationId: scope.installationId,
    connectionId: scope.connectionId, presetId: scope.presetId })).rejects.toThrow("feature project is unavailable");
  const featureRequest = { bindingId: fixture!.bindingId, idempotencyScope: "feature", idempotencyKey: "attempt" };
  for (const action of [() => features.create(featureRequest), () => features.start(featureRequest),
    () => features.stop(featureRequest), () => features.destroy(featureRequest),
    () => features.destroyRetired(featureRequest)]) {
    await expect(action()).rejects.toThrow("feature binding is unavailable");
  }

  const destroyed = await service.destroy(scope, "fixture-1");
  expect(destroyed.state).toBe("SUCCEEDED");
  expect((await service.destroy(scope, "fixture-1")).id).toBe(destroyed.id);
  expect(dispatches.map(item => item.kind)).toEqual(["CREATE", "DESTROY"]);
  expect((await admission.getReservation(fixture!.bindingId))?.diskState).toBe("RELEASED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("ABSENT");
  await expect(db.delete(schema.projects).where(eq(schema.projects.id, fixture!.projectId)).execute())
    .rejects.toThrow();
});

test("missing host capacity and reused fixture identity fail closed", async () => {
  const { service, dispatches } = await setup(false);
  await expect(service.create(scope, "fixture-2")).rejects.toThrow("Host capacity must be configured first");
  expect(dispatches).toEqual([]);
  await expect(service.create({ ...scope, connectionId: "other" }, "fixture-2"))
    .rejects.toThrow("identity changed");
  await expect(service.destroy({ ...scope, connectionId: "other" }, "fixture-2"))
    .rejects.toThrow("fixture is unavailable");
});

test("an uncertain create remains journaled and replays one provider operation", async () => {
  const { service, controller, dispatches, db } = await setup(true, true);
  const first = await service.create(scope, "fixture-pending");
  expect(first.state).toBe("PROVIDER_PENDING");
  expect((await service.create(scope, "fixture-pending")).id).toBe(first.id);
  expect(dispatches).toHaveLength(1);
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("UNKNOWN");
  await controller.reconcile();
  expect((await controller.getOperation(first.id))?.state).toBe("SUCCEEDED");
  expect((await controller.getBinding(fixture!.bindingId))?.observedState).toBe("STOPPED");
});

test("destroy refuses a binding whose pinned provider scope changed", async () => {
  const { service, db, dispatches } = await setup();
  await service.create(scope, "fixture-tampered");
  const [fixture] = await db.select().from(schema.incusQualificationFixtures);
  await db.update(schema.sandboxBindings).set({ connectionId: "other" })
    .where(eq(schema.sandboxBindings.id, fixture!.bindingId));
  await expect(service.destroy(scope, "fixture-tampered"))
    .rejects.toThrow("fixture binding changed");
  expect(dispatches).toHaveLength(1);
});
