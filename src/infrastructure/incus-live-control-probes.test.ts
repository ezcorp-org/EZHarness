import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { drizzle } from "drizzle-orm/pglite";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import * as schema from "../db/schema";
import type { ActiveExtensionRelease } from "../extensions/release-process";
import { SandboxAdmissionStore } from "../sandboxes/admission";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { digest } from "../../scripts/incus/model";
import type { LiveReadbackContext } from "./incus-transport/live-readback";
import { IncusFeatureService } from "./incus-feature-service";
import type { IncusQualificationStore } from "./incus-qualification";
import type { ProviderConnectionCredentials } from "./provider-connections/store";
import { IncusLiveControlProbes, type IncusControlProbeConfig } from "./incus-live-control-probes";

const active: Array<{ db: PGlite; directory: string }> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map(async item => {
    await item.db.close();
    await rm(item.directory, { recursive: true, force: true });
  }));
});

async function fixture() {
  const pglite = new PGlite();
  await pglite.waitReady;
  const directory = await mkdtemp(join(tmpdir(), "incus-control-"));
  active.push({ db: pglite, directory });
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await addQualificationFixtures(db);
  const preset = INCUS_PRESETS[0]!;
  const presetDigest = await sandboxPresetDigest(preset);
  const effectiveSettingsDigest = digest({ presetDigest, connectionRevision: 1 });
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: preset.id };
  const cases = {} as IncusControlProbeConfig["cases"];
  for (const kind of ["unsupported", "missingControl", "drift", "unqualified"] as const) {
    const projectId = `control-${kind}`;
    await db.insert(schema.projects).values({ id: projectId, name: projectId, path: `/control/${kind}` });
    const canaryPath = join(directory, `${kind}.canary`);
    await writeFile(canaryPath, `AMD:${kind}`);
    cases[kind] = { projectId, canaryPath,
      ...(["missingControl", "drift"].includes(kind) ? { bindingId: `binding-${kind}` } : {}) };
    if (cases[kind].bindingId) await db.insert(schema.sandboxBindings).values({
      id: cases[kind].bindingId!, projectId, providerInstallationId: scope.installationId,
      providerReleaseId: scope.releaseId, connectionId: scope.connectionId, connectionRevision: 1,
      profile: preset.profile, presetId: preset.id, presetDigest, effectiveSettingsDigest,
      resourceKey: cases[kind].bindingId!, desiredState: "STOPPED", observedState: "UNKNOWN",
    });
  }
  const admission = new SandboxAdmissionStore(db);
  await admission.configureHostCapacity({ providerInstallationId: scope.installationId,
    connectionId: scope.connectionId,
    allocatable: { memoryBytes: 4 * preset.limits.memoryBytes, cpuMillicores: 4 * preset.limits.cpuMillis,
      pids: 4 * preset.limits.pids, diskBytes: 4 * preset.limits.diskBytes, executionSlots: 4 },
    safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 } });
  const connection = { id: scope.connectionId, revision: 1,
    providerInstallationId: scope.installationId, providerReleaseId: scope.releaseId,
    configuration: { kind: "incus", profile: "reviewed", guestUser: "sandbox", helperVersion: "0.1.0" },
    revokedAt: null } as ProviderConnectionCredentials;
  const snapshot = { installation: { id: scope.installationId, activeReleaseId: scope.releaseId },
    release: { id: scope.releaseId, manifest: incusManifest } } as ActiveExtensionRelease;
  const qualifications = { authorizeFixture: async () => ({ connection, preset, presetDigest, effectiveSettingsDigest }),
    load: async () => null } as unknown as IncusQualificationStore;
  const feature = new IncusFeatureService({ db, admission,
    activeRelease: async () => snapshot, connectionRevision: async () => 1,
    resolveConnection: async () => connection, loadQualification: async () => null });
  const context = { scope, connection: { ...connection, project: "reviewed", serverCertificatePem: "test" },
    preset, presetDigest, effectiveSettingsDigest,
    recipe: { profile: { name: "reviewed" }, guestImage: { alias: "reviewed-alias" } } } as unknown as LiveReadbackContext;
  let backendIds = ["existing-sandbox"];
  const probes = new IncusLiveControlProbes({ cases, unqualifiedPresetId: INCUS_PRESETS[1]!.id }, {
    db, qualifications, feature, admission, context: async () => context,
    inventory: async () => [...backendIds],
    backendImage: async drifted => {
      if (drifted.recipe.guestImage?.alias !== "reviewed-alias") {
        throw new Error("Incus live backend readback failed: backend image fingerprint, type, or alias changed");
      }
    },
  });
  return { db, preset, scope, cases, probes, setBackendIds: (ids: string[]) => { backendIds = ids; } };
}

test("four production denial paths reject without a reservation, operation, or backend change", async () => {
  const { db, preset, scope, cases, probes } = await fixture();
  const codes = { unsupported: "DENIED_UNSUPPORTED", missingControl: "DENIED_CONTROL",
    drift: "DENIED_DRIFT", unqualified: "DENIED_UNQUALIFIED" } as const;
  for (const kind of ["unsupported", "missingControl", "drift", "unqualified"] as const) {
    const before = await probes.snapshot(kind, scope);
    expect(await probes.attempt(kind, scope, preset)).toBe(codes[kind]);
    const after = await probes.snapshot(kind, scope);
    expect(after.reservationIds).toEqual(before.reservationIds);
    expect(after.operationIds).toEqual(before.operationIds);
    expect(after.backendIds).toEqual(before.backendIds);
    expect(after.canaryBytes).toEqual(before.canaryBytes);
  }
  expect(await db.select().from(schema.sandboxReservations)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxOperations)).toHaveLength(0);
  const denied = await db.select().from(schema.sandboxAdmissionRequests);
  expect(denied.map(item => item.reason).sort()).toEqual(["PROJECT_QUOTA_NOT_CONFIGURED", "STALE_GENERATION"]);
  await db.insert(schema.sandboxReservations).values({
    bindingId: cases.missingControl.bindingId!, projectId: cases.missingControl.projectId,
    providerInstallationId: scope.installationId, connectionId: scope.connectionId, generation: 1,
    memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
    pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1,
    computeState: "RESERVED", diskState: "RESERVED",
  });
  await db.insert(schema.sandboxOperations).values({ id: "durable-operation",
    bindingId: cases.missingControl.bindingId!, kind: "CREATE", generation: 1,
    idempotencyScope: "probe-test", idempotencyKey: "durable", payloadHash: "digest",
    requestPayload: {}, state: "JOURNALED" });
  const durable = await probes.snapshot("unsupported", scope);
  expect(durable.reservationIds).toContain(cases.missingControl.bindingId!);
  expect(durable.operationIds).toContain("durable-operation");
});

test("canary and backend changes are visible, and a missing quota prerequisite fails closed", async () => {
  const { db, preset, scope, cases, probes, setBackendIds } = await fixture();
  const before = await probes.snapshot("missingControl", scope);
  await writeFile(cases.missingControl.canaryPath, "changed");
  setBackendIds(["existing-sandbox", "extra-sandbox"]);
  const after = await probes.snapshot("missingControl", scope);
  expect(after.canaryBytes).not.toEqual(before.canaryBytes);
  expect(after.backendIds).not.toEqual(before.backendIds);
  await db.insert(schema.sandboxProjectQuotas).values({ projectId: cases.missingControl.projectId,
    providerInstallationId: scope.installationId, connectionId: scope.connectionId,
    memoryBytes: preset.limits.memoryBytes, cpuMillicores: preset.limits.cpuMillis,
    pids: preset.limits.pids, diskBytes: preset.limits.diskBytes, executionSlots: 1 });
  await expect(probes.attempt("missingControl", scope, preset)).rejects.toThrow("prerequisites changed");
});

test("configuration requires separate AMD files and a present control project", async () => {
  const { db, preset, scope, cases, probes } = await fixture();
  expect(() => new IncusLiveControlProbes({ cases: { ...cases,
    drift: { ...cases.drift, canaryPath: cases.unsupported.canaryPath } },
    unqualifiedPresetId: INCUS_PRESETS[1]!.id }, { db })).toThrow("four distinct");
  await db.delete(schema.projects).where((await import("drizzle-orm")).eq(schema.projects.id, cases.unsupported.projectId));
  await expect(probes.attempt("unsupported", scope, preset)).rejects.toThrow("not a user project");
});
