import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { incusManifest } from "../../../extensions/incus-sandbox/manifest";
import checkedRecipe from "../../../scripts/incus/recipe.json";
import { digest, type IncusInventory, type IncusSetupRecipe } from "../../../scripts/incus/model";
import { createSetupPlan } from "../../../scripts/incus/plan";
import { up as addReleases } from "../../db/migrations/add-extension-releases";
import { up as addConnections } from "../../db/migrations/add-provider-connections";
import { up as addSetups } from "../../db/migrations/add-incus-operator-setups";
import { up as addController } from "../../db/migrations/add-sandbox-controller";
import * as schema from "../../db/schema";
import { releaseRuntimeFixture } from "../../__tests__/helpers/release-runtime";
import { ProviderConnectionStore } from "../provider-connections/store";
import { SandboxAdmissionStore } from "../../sandboxes/admission";
import { IncusCapacityService, type IncusCapacityPlan, readCapacityObservation } from "./capacity";

const opened: PGlite[] = [];
const GIB = 1024 ** 3;
const recipe = { ...structuredClone(checkedRecipe), providerClient: { name: "engine", certificateFingerprint: "b".repeat(64),
  certificatePem: "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n", projects: [checkedRecipe.project.name], restricted: true } } as IncusSetupRecipe;
const bootstrap = { sshTarget: "dev@host", sshIdentityFile: "/key", sshKnownHostsFile: "/known",
  sshHostKeySha256: recipe.expected.sshHostKeySha256 };

function inventory(): IncusInventory {
  return { schemaVersion: 1, capturedAt: new Date().toISOString(), connection: { sshTarget: bootstrap.sshTarget,
    sshHostKeySha256: bootstrap.sshHostKeySha256 },
    host: { hostname: recipe.expected.hostname, os: "NixOS", kernel: "6.12", architecture: "x86_64", cpuThreads: 12,
      memoryBytes: 64 * GIB, rootFreeBytes: 200 * GIB, addresses: [recipe.server.httpsAddress.split(":")[0]!],
      cgroupVersion: "v2", ntpSynchronized: true },
    server: { clientVersion: recipe.expected.incusVersion, serverVersion: recipe.expected.incusVersion,
      certificateFingerprint: recipe.expected.serverCertificateFingerprint, apiStatus: "stable", clustered: false,
      firewall: "nftables", serviceActive: true, apiExtensions: [...recipe.expected.requiredApiExtensions],
      storageDrivers: [{ name: "btrfs", version: "6", remote: false }], httpsAddresses: [recipe.server.httpsAddress] },
    routes: [], projects: [{ name: recipe.project.name, description: recipe.project.description, config: recipe.project.config }],
    storagePools: [{ name: recipe.storage.name, driver: recipe.storage.driver, description: "EZHarness owned sandbox storage",
      config: { size: recipe.storage.size, "volume.size": recipe.storage.defaultVolumeSize }, status: "Created" }],
    networks: [{ name: recipe.network.name, project: "default", type: "bridge", managed: true,
      description: "EZHarness sandbox network", config: recipe.network.config, status: "Created" }],
    profiles: [{ name: recipe.profile.name, project: recipe.project.name, description: recipe.profile.description,
      config: recipe.profile.config, devices: recipe.profile.devices }], instances: [],
    trust: [{ fingerprint: recipe.providerClient!.certificateFingerprint, name: "engine", restricted: true,
      projects: [recipe.project.name], type: "client" }],
    images: [{ fingerprint: recipe.guestImage!.fingerprint!, aliases: [recipe.guestImage!.alias] }] };
}

function runner(memoryGib = 48, poolUsedGib = 12) {
  return async (argv: readonly string[]) => {
    const command = argv.join(" ");
    const stdout = command.includes("meminfo") ? `MemAvailable: ${memoryGib * GIB / 1024} kB\n`
      : command.includes("loadavg") ? "0.00 0.00 0.00 1/100 100\n"
      : command.includes("threads-max") ? "100000\n"
      : command.includes("pid_max") ? "100000\n"
      : JSON.stringify({ space: { total: 100 * GIB, used: poolUsedGib * GIB } });
    return { exitCode: 0, stderr: "", stdout };
  };
}

async function fixture() {
  const client = new PGlite(); opened.push(client); await client.waitReady;
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL DEFAULT 'user', icon TEXT, variables JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const db = drizzle(client, { schema });
  await addReleases(db); await addConnections(db); await addSetups(db); await addSetups(db); await addController(db);
  const { snapshot } = releaseRuntimeFixture("installation", incusManifest);
  snapshot.installation.generation = 2; snapshot.installation.acknowledgedGeneration = 2;
  await client.query("INSERT INTO extension_release_installations (id, owner_id, scope, payload) VALUES ($1,$2,$3,$4)",
    [snapshot.installation.id, snapshot.installation.ownerId, "global", JSON.stringify(snapshot.installation)]);
  await client.query("INSERT INTO extension_release_records (installation_id,kind,id,payload) VALUES ($1,'releases',$2,$3)",
    [snapshot.installation.id, snapshot.release.id, JSON.stringify(snapshot.release)]);
  await client.query("INSERT INTO extension_release_records (installation_id,kind,id,payload) VALUES ($1,'approvals',$2,$3)",
    [snapshot.installation.id, "approval", JSON.stringify({ id: "approval", installationId: snapshot.installation.id,
      releaseId: snapshot.release.id, releaseDigest: snapshot.release.releaseDigest,
      principalId: snapshot.installation.ownerId, scope: "global", status: "consumed", expectedGeneration: 1 })]);
  const connection = await new ProviderConnectionStore(db).create({ id: "connection", providerInstallationId: snapshot.installation.id,
    providerReleaseId: snapshot.release.id, endpoint: "https://host:8443", serverCertificatePem: "certificate",
    project: recipe.project.name, configuration: { kind: "incus", profile: "compose", helperVersion: "0.1.0", guestUser: "sandbox" },
    clientCertificatePem: "certificate", privateKeyPem: "private" });
  const observed = inventory();
  const setupPlan = createSetupPlan(recipe, observed);
  await client.query(`INSERT INTO incus_operator_setups (id,provider_installation_id,provider_release_id,provider_release_digest,
    provider_generation,connection_id,connection_revision,planned_by,recipe,plan,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified')`, ["setup", snapshot.installation.id, snapshot.release.id,
    snapshot.release.releaseDigest, 2, connection.id, connection.revision, "admin", JSON.stringify(recipe), JSON.stringify(setupPlan)]);
  let activeRunner = runner();
  let activeInspect = async () => observed;
  let clock = new Date("2026-09-23T12:00:00.000Z");
  const connections = new ProviderConnectionStore(db);
  const dependencies = { database: db, connections, bootstrap, activeRelease: async () => snapshot,
    inspect: async () => activeInspect(), runner: (argv: readonly string[]) => activeRunner(argv),
    verifyPin: async () => {}, now: () => clock };
  const service = new IncusCapacityService(dependencies);
  return { client, db, service, connections, snapshot, dependencies,
    setRunner: (next: ReturnType<typeof runner>) => { activeRunner = next; },
    setInspect: (next: () => Promise<IncusInventory>) => { activeInspect = next; },
    setTime: (next: string) => { clock = new Date(next); } };
}

afterEach(async () => { await Promise.all(opened.splice(0).map(client => client.close())); });

test("protected observation rejects failed and malformed headroom reads", async () => {
  const observed = inventory();
  const good = await readCapacityObservation(bootstrap, observed, recipe.storage.name, runner(), async () => {},
    () => new Date("2026-09-23T12:00:00.000Z"));
  expect(good.availableMemoryBytes).toBe(48 * GIB);
  expect(good.poolFreeBytes).toBe(88 * GIB);
  await expect(readCapacityObservation(bootstrap, observed, recipe.storage.name,
    async () => ({ exitCode: 1, stdout: "", stderr: "failed" }), async () => {})).rejects.toThrow("protected host read failed");
});

test("read-only plan and exact Apply configure capacity once with no reservations", async () => {
  const value = await fixture();
  expect(await value.service.status("setup")).toBeNull();
  const plan = await value.service.plan("setup");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
  expect(plan.capacity.allocatable.memoryBytes).toBe(32 * GIB);
  await expect(value.service.apply(plan, "0".repeat(64), "admin")).rejects.toThrow("exact capacity plan digest");
  const receipt = await value.service.apply(plan, plan.planDigest, "admin");
  expect(receipt.plan.planDigest).toBe(plan.planDigest);
  expect(await value.service.status("setup")).toEqual(receipt);
  expect(await value.service.apply(plan, plan.planDigest, "admin")).toEqual(receipt);
  await expect(value.service.apply({ ...plan, planDigest: "f".repeat(64) }, "f".repeat(64), "admin"))
    .rejects.toThrow("exact capacity plan digest");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(1);
  expect((await value.client.query<{ capacity_receipt: unknown }>("SELECT capacity_receipt FROM incus_operator_setups WHERE id='setup'")).rows[0]!.capacity_receipt).toMatchObject({ plan: { planDigest: plan.planDigest } });
});

test("a receipt write failure rolls back the admission capacity write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  await value.client.query("ALTER TABLE incus_operator_setups ADD CONSTRAINT fail_capacity_receipt CHECK (capacity_receipt IS NULL)");
  await expect(value.service.apply(plan, plan.planDigest, "admin")).rejects.toThrow();
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
  expect((await value.client.query<{ capacity_receipt: unknown }>("SELECT capacity_receipt FROM incus_operator_setups WHERE id='setup'")).rows[0]!.capacity_receipt).toBeNull();
});

test("Apply refuses changed headroom and existing reservations above reviewed usable capacity", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  value.setRunner(runner(20, 80));
  await expect(value.service.apply(plan, plan.planDigest, "admin")).rejects.toThrow("fresh host headroom");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
  value.setRunner(runner());
  await new SandboxAdmissionStore(value.db).configureHostCapacity({ ...plan.capacity,
    allocatable: { ...plan.capacity.allocatable, memoryBytes: 48 * GIB },
    safetyMargin: { ...plan.capacity.safetyMargin, memoryBytes: 0 } });
  await value.client.query("INSERT INTO projects (id,name,path) VALUES ('p','p','/p')");
  await value.client.query(`INSERT INTO sandbox_bindings (id,project_id,provider_installation_id,provider_release_id,
    connection_id,desired_state,observed_state) VALUES ('b','p','installation','release','connection','RUNNING','RUNNING')`);
  await value.client.query(`INSERT INTO sandbox_reservations (binding_id,project_id,provider_installation_id,connection_id,
    generation,memory_bytes,cpu_millicores,pids,disk_bytes,execution_slots,compute_state,disk_state)
    VALUES ('b','p','installation','connection',1,$1,1000,10,1000,1,'RESERVED','RESERVED')`, [32 * GIB]);
  await expect(value.service.apply(plan, plan.planDigest, "admin")).rejects.toThrow("durable reservations");
  expect((await value.client.query<{ capacity_receipt: unknown }>("SELECT capacity_receipt FROM incus_operator_setups WHERE id='setup'")).rows[0]!.capacity_receipt).toBeNull();
});

test("tampered, expired, or mismatched reviewed plan cannot apply", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  await expect(value.service.apply({ ...plan, capacity: { ...plan.capacity, connectionId: "other" } }, plan.planDigest, "admin"))
    .rejects.toThrow("exact capacity plan digest");
  const expired: IncusCapacityPlan = { ...plan, expiresAt: "2026-09-23T11:00:00.000Z" };
  const { planDigest: _unused, ...payload } = expired;
  expired.planDigest = digest(payload);
  await expect(value.service.apply(expired, expired.planDigest, "admin")).rejects.toThrow("expired or clock changed");
});

test("Plan fails closed when the host cannot retain external and admission margins", async () => {
  const value = await fixture();
  value.setRunner(runner(10, 96));
  await expect(value.service.plan("setup")).rejects.toThrow("no safe capacity");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
});

test("Plan expiry is anchored to the protected observation even if the clock advances while planning", async () => {
  const value = await fixture();
  let reads = 0;
  value.dependencies.now = () => new Date(reads++ === 0 ? "2026-09-23T12:00:00.000Z" : "2026-09-23T12:00:20.000Z");
  const plan = await value.service.plan("setup");
  expect(plan.observation.capturedAt).toBe("2026-09-23T12:00:00.000Z");
  expect(plan.expiresAt).toBe("2026-09-23T12:10:00.000Z");
});

test("connection revocation during paused SSH inspection blocks the capacity write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  value.setInspect(async () => { entered(); await paused; return inventory(); });
  const applying = value.service.apply(plan, plan.planDigest, "admin");
  await inspecting;
  await value.connections.revoke("connection", 1);
  resume();
  await expect(applying).rejects.toThrow("Provider connection changed during capacity review");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
});

test("release replacement during paused SSH inspection blocks the capacity write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  value.setInspect(async () => { entered(); await paused; return inventory(); });
  const applying = value.service.apply(plan, plan.planDigest, "admin");
  await inspecting;
  const changed = { ...value.snapshot.installation, activeReleaseId: "replacement", generation: 3, acknowledgedGeneration: 3 };
  await value.client.query("UPDATE extension_release_installations SET payload=$1 WHERE id=$2",
    [JSON.stringify(changed), value.snapshot.installation.id]);
  resume();
  await expect(applying).rejects.toThrow("Provider release is not active and approved");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
});

test("approval withdrawal during paused SSH inspection blocks the capacity write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  let entered!: () => void;
  let resume!: () => void;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  value.setInspect(async () => { entered(); await paused; return inventory(); });
  const applying = value.service.apply(plan, plan.planDigest, "admin");
  await inspecting;
  await value.client.query("UPDATE extension_release_records SET payload=(payload::jsonb || '{\"status\":\"rejected\"}'::jsonb)::text WHERE installation_id=$1 AND kind='approvals' AND id='approval'",
    [value.snapshot.installation.id]);
  resume();
  await expect(applying).rejects.toThrow("Provider release is not active and approved");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
});

test("plan expiry after fresh SSH read but before transaction authority check blocks the write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  const real = value.connections;
  let entered!: () => void;
  let resume!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  value.dependencies.connections = {
    resolveForHost: real.resolveForHost.bind(real),
    assertCurrentScope: async (...args: Parameters<ProviderConnectionStore["assertCurrentScope"]>) => {
      entered(); await paused; return real.assertCurrentScope(...args);
    },
  } as ProviderConnectionStore;
  const applying = value.service.apply(plan, plan.planDigest, "admin");
  await checking;
  value.setTime("2026-09-23T12:10:01.000Z");
  resume();
  await expect(applying).rejects.toThrow("capacity plan expired or clock changed");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
});

test("plan expiry while capacity admission waits rolls back its write", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  let reads = 0;
  value.dependencies.now = () => new Date(++reads >= 4 ? "2026-09-23T12:10:01.000Z" : "2026-09-23T12:00:00.000Z");
  await expect(value.service.apply(plan, plan.planDigest, "admin")).rejects.toThrow("capacity plan expired or clock changed");
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(0);
  expect((await value.client.query<{ capacity_receipt: unknown }>("SELECT capacity_receipt FROM incus_operator_setups WHERE id='setup'")).rows[0]!.capacity_receipt).toBeNull();
});

test("competing exact Apply requests converge on one saved receipt", async () => {
  const value = await fixture();
  const plan = await value.service.plan("setup");
  const [first, second] = await Promise.all([
    value.service.apply(plan, plan.planDigest, "admin"),
    value.service.apply(plan, plan.planDigest, "admin"),
  ]);
  expect(second).toEqual(first);
  expect((await value.client.query("SELECT * FROM sandbox_host_capacities")).rows).toHaveLength(1);
});
