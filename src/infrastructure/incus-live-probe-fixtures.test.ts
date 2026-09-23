import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import { up as addQualificationFixtures } from "../db/migrations/add-incus-qualification-fixtures";
import { up as addProjectWorkspaceBindings } from "../db/migrations/add-project-workspace-bindings";
import * as schema from "../db/schema";
import { incusManifest, INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import type { IncusQualificationStore } from "./incus-qualification";
import { IncusLiveProbeFixtureService } from "./incus-live-probe-fixtures";

const active: Array<{ pglite: PGlite; root: string }> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map(async item => {
    await item.pglite.close();
    await rm(item.root, { recursive: true, force: true });
  }));
});

async function fixture() {
  const pglite = new PGlite();
  await pglite.waitReady;
  const root = await mkdtemp(join(tmpdir(), "incus-probe-fixtures-"));
  active.push({ pglite, root });
  await pglite.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  await addQualificationFixtures(db);
  await addProjectWorkspaceBindings(db);
  const scope = { installationId: "installation", releaseId: "release", connectionId: "connection",
    presetId: INCUS_PRESETS[1]!.id };
  const preset = INCUS_PRESETS[1]!;
  const selected = { snapshot: { installation: { id: scope.installationId, activeReleaseId: scope.releaseId },
    release: { id: scope.releaseId, manifest: incusManifest } },
    connection: { revision: 1 }, preset, presetDigest: await sandboxPresetDigest(preset),
    effectiveSettingsDigest: "settings" };
  let authorized = 0;
  let disabled = false;
  const qualifications = { authorizeFixture: async (input: typeof scope) => {
    authorized++;
    if (disabled) throw new Error("release disabled");
    if (JSON.stringify(input) !== JSON.stringify(scope)) throw new Error("scope denied");
    return selected;
  }, load: async () => null } as unknown as IncusQualificationStore;
  await db.insert(schema.sandboxHostCapacities).values({
    providerInstallationId: scope.installationId, connectionId: scope.connectionId,
    allocatableMemoryBytes: 100, allocatableCpuMillicores: 100, allocatablePids: 100,
    allocatableDiskBytes: 100, allocatableExecutionSlots: 100,
    safetyMemoryBytes: 0, safetyCpuMillicores: 0, safetyPids: 0,
    safetyDiskBytes: 0, safetyExecutionSlots: 0,
  });
  const service = new IncusLiveProbeFixtureService({ db, rootDirectory: root, qualifications });
  return { db, root, scope, service, authorized: () => authorized,
    disable: () => { disabled = true; } };
}

test("reviewed plan creates four private AMD canaries and exactly two allocation-free bindings; replay is stable", async () => {
  const { db, root, scope, service } = await fixture();
  const plan = await service.plan(scope, "run-one");
  expect((await readdir(root))).toHaveLength(0);
  expect(Object.keys(plan.config.cases).sort()).toEqual(["drift", "missingControl", "unqualified", "unsupported"]);
  expect(plan.config.unqualifiedPresetId).toBe(INCUS_PRESETS[0]!.id);
  const first = await service.apply(scope, "run-one", plan.digest);
  const second = await service.apply(scope, "run-one", plan.digest);
  expect(second).toEqual(first);
  expect(first.receipt.projectIds).toHaveLength(4);
  expect(first.receipt.bindingIds).toHaveLength(2);
  expect(new Set(first.receipt.canaryPaths).size).toBe(4);
  for (const path of first.receipt.canaryPaths) {
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect(await readFile(path, "utf8")).toContain("AMD control canary");
  }
  expect((await db.select().from(schema.projects)).map((row: { purpose: string }) => row.purpose))
    .toEqual(["user", "user", "user", "user"]);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(2);
  expect(await db.select().from(schema.sandboxOperations)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxReservations)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxProjectQuotas)).toHaveLength(0);
});

test("forged scope and changed review digest cause no local or database effect", async () => {
  const { db, root, scope, service, authorized } = await fixture();
  await expect(service.plan({ ...scope, connectionId: "other" }, "run-one")).rejects.toThrow("scope denied");
  await service.plan(scope, "run-one");
  await expect(service.apply(scope, "run-one", "0".repeat(64))).rejects.toThrow("review digest changed");
  await expect(service.plan(scope, "../escape")).rejects.toThrow("Invalid Incus probe fixture");
  expect(authorized()).toBeGreaterThan(0);
  expect(await readdir(root)).toHaveLength(0);
  expect(await db.select().from(schema.projects)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(0);
});

test("missing host capacity and nonprivate operator roots fail before fixture writes", async () => {
  const { db, root, scope, service } = await fixture();
  await db.delete(schema.sandboxHostCapacities).where(eq(schema.sandboxHostCapacities.connectionId, scope.connectionId));
  await expect(service.plan(scope, "run-one")).rejects.toThrow("host capacity is unavailable");
  expect(await readdir(root)).toHaveLength(0);
  await chmod(root, 0o755);
  await expect(service.plan(scope, "run-one")).rejects.toThrow("not private to the operator");
  expect(await db.select().from(schema.projects)).toHaveLength(0);
});

test("an occupied deterministic project ID is denied before local file creation", async () => {
  const { db, root, scope, service } = await fixture();
  const plan = await service.plan(scope, "run-one");
  await db.insert(schema.projects).values({ id: plan.config.cases.unsupported.projectId,
    name: "unrelated", path: "/unrelated", purpose: "user" });
  await expect(service.apply(scope, "run-one", plan.digest)).rejects.toThrow("ownership changed");
  expect(await readdir(root)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(0);
});

test("cleanup removes only reviewed controls and denied requests; it is idempotent", async () => {
  const { db, root, scope, service, disable } = await fixture();
  const plan = await service.plan(scope, "run-one");
  const { receipt } = await service.apply(scope, "run-one", plan.digest);
  const bindingId = receipt.bindingIds[0]!;
  await db.insert(schema.sandboxAdmissionRequests).values({ id: "denied", bindingId, generation: 1,
    kind: "CREATE", idempotencyScope: "incus-control-probe", idempotencyKey: "denied",
    payloadHash: "digest", memoryBytes: 1, cpuMillicores: 1, pids: 1, diskBytes: 1,
    executionSlots: 1, state: "REJECTED", reason: "PROJECT_QUOTA_NOT_CONFIGURED" });
  disable();
  expect((await service.cleanup(scope, "run-one", plan.digest)).state).toBe("cleaned");
  expect((await service.cleanup(scope, "run-one", plan.digest)).state).toBe("cleaned");
  expect(await readdir(root)).toHaveLength(0);
  expect(await db.select().from(schema.projects)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(0);
  expect(await db.select().from(schema.sandboxAdmissionRequests)).toHaveLength(0);
});

test("cleanup refuses a provider effect or altered canary and keeps all records", async () => {
  const { db, scope, service } = await fixture();
  const plan = await service.plan(scope, "run-one");
  const { receipt } = await service.apply(scope, "run-one", plan.digest);
  await writeFile(receipt.canaryPaths[0]!, "changed");
  await expect(service.cleanup(scope, "run-one", plan.digest)).rejects.toThrow("canary changed");
  expect(await db.select().from(schema.projects)).toHaveLength(4);
  const expected = `EZHarness AMD control canary ${plan.directory.split("/").at(-1)} unsupported\n`;
  await writeFile(receipt.canaryPaths[0]!, expected);
  await db.insert(schema.sandboxOperations).values({ id: "effect", bindingId: receipt.bindingIds[0]!,
    kind: "CREATE", generation: 1, idempotencyScope: "test", idempotencyKey: "effect",
    payloadHash: "digest", requestPayload: {}, state: "JOURNALED" });
  await expect(service.cleanup(scope, "run-one", plan.digest)).rejects.toThrow("provider effect");
  expect(await db.select().from(schema.projects)).toHaveLength(4);
  expect(await db.select().from(schema.sandboxBindings)).toHaveLength(2);
  expect(await db.select().from(schema.sandboxOperations).where(eq(schema.sandboxOperations.id, "effect")))
    .toHaveLength(1);
});
