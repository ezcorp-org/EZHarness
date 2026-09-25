import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates } from "../../__tests__/helpers/factory-certificates";
import { parseFactoryPoolProcessConfig, runConfiguredFactoryPoolProcess, runFactoryPoolMain, startFactoryPoolMain, type FactoryPoolProcessDependencies } from "./process";
import type { FactoryPoolReadinessUpdate } from "./readiness";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// Key generation is the slow part of a fixture, and a fixture only reads these, so one set serves the file.
const shared: string[] = [];
let certs: Awaited<ReturnType<typeof certificates>>;
const rsaKeys = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
let keys: ReturnType<typeof rsaKeys>;
beforeAll(async () => { certs = await certificates(shared); keys = rsaKeys(); });
afterAll(async () => { await Promise.all(shared.map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(overrides: Record<string, unknown> = {}) {
  const certificateRoot = shared[0]!;
  const root = await mkdtemp(join(process.env.HOME!, ".factory-pool-process-")); directories.push(root);
  await Promise.all(["server.key", "server.pem", "ca.pem"].map(name => copyFile(join(certificateRoot, name), join(root, name))));
  await Promise.all(["server.key", "server.pem", "ca.pem"].map(name => chmod(join(root, name), 0o600)));
  const paths = { config: join(root, "pool.json"), database: join(root, "database.json"), publicKey: join(root, "token.pem"), readiness: join(root, "ready.json") };
  await Promise.all([
    writeFile(paths.database, JSON.stringify({ databaseUrl: "postgres://pool_role:private-secret@localhost:5432/pool_db" }), { mode: 0o600 }),
    writeFile(paths.publicKey, keys.publicKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 }),
  ]);
  const config = {
    schemaVersion: "factory.pool-process.v1", poolId: "pool-a", hostname: "127.0.0.1", port: 8443,
    database: { credentialsPath: paths.database, expectedDatabase: "pool_db", expectedRole: "pool_role" },
    tls: { privateKeyPath: join(root, "server.key"), certificatePath: join(root, "server.pem"), caPath: join(root, "ca.pem") },
    tokens: { issuer: "factory-test", audience: "factory-pool", publicKeyPaths: { test: paths.publicKey } },
    identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: {} },
    resources: { capacities: { cpu: 4 }, gpuHosts: [] }, readinessFilePath: paths.readiness, readinessHeartbeatMs: 1_000,
    ...overrides,
  };
  await writeFile(paths.config, JSON.stringify(config), { mode: 0o600 });
  return { config, paths, certs };
}

class ProcessDatabase {
  readonly resources = new Map<string, number>();
  readonly hosts = new Set<string>();
  identity: { pool_id: string } | undefined;
  databaseChecks = 0;
  closed = false;
  failCheckAfter = Number.POSITIVE_INFINITY;
  resultRowsObject = false;
  invalidRows = false;
  failClose = false;
  async begin<Result>(work: (database: ProcessDatabase) => Promise<Result>): Promise<Result> { return work(this); }
  async unsafe(query: string, params: readonly unknown[] = []): Promise<unknown> {
    if (query.includes("current_database")) { this.databaseChecks++; if (this.databaseChecks > this.failCheckAfter) throw new Error("secret database error"); if (this.invalidRows) return {}; const value = [{ database: "pool_db", role: "pool_role" }]; return this.resultRowsObject ? { rows: value } : value; }
    if (query.startsWith("INSERT INTO factory_pool_identity")) { this.identity ??= { pool_id: String(params[0]) }; return []; }
    if (query.startsWith("SELECT pool_id FROM factory_pool_identity")) return this.identity ? [this.identity] : [];
    if (query === "SELECT resource_class FROM factory_pool_resources ORDER BY resource_class") return [...this.resources.keys()].map(resource_class => ({ resource_class }));
    if (query === "SELECT host_id FROM factory_pool_hosts ORDER BY host_id") return [...this.hosts].map(host_id => ({ host_id }));
    if (query.includes("FROM factory_pool_resources WHERE resource_class = $1 FOR UPDATE")) { const total = this.resources.get(String(params[0])); return total === undefined ? [] : [{ resource_class: params[0], total_units: total, allocated_units: 0 }]; }
    if (query.includes("COALESCE(SUM(minimum_units)")) return [{ units: 0 }];
    if (query.startsWith("INSERT INTO factory_pool_resources")) { const resource = query.includes("'gpu-host'") ? "gpu-host" : String(params[0]); this.resources.set(resource, resource === "gpu-host" ? (this.resources.get(resource) ?? 0) + 1 : Number(params[1])); return []; }
    if (query.includes("FROM factory_pool_hosts WHERE host_id = $1 FOR UPDATE")) return this.hosts.has(String(params[0])) ? [{ host_id: params[0], state: "available", reservation_id: null, holder_generation: null }] : [];
    if (query.startsWith("INSERT INTO factory_pool_hosts")) { this.hosts.add(String(params[0])); return []; }
    return [];
  }
  async close(): Promise<void> { this.closed = true; if (this.failClose) throw new Error("secret close failure"); }
}

function dependencies(database: ProcessDatabase, controller: AbortController, updates: FactoryPoolReadinessUpdate[], options: { startError?: boolean; stopError?: boolean; heartbeatError?: boolean; heartbeatSuccess?: boolean } = {}): FactoryPoolProcessDependencies {
  if (options.heartbeatError) database.failCheckAfter = 1;
  return {
    connect: () => database,
    readiness: () => ({ async write(update) { updates.push(update); return { schemaVersion: "factory.pool-readiness.v2", poolId: "p", observedAtMs: 1, ...update }; } }),
    start: async input => { expect(input).toMatchObject({ hostname: "127.0.0.1", port: 8443 }); if (options.startError) throw new Error("secret listener error"); if (options.heartbeatSuccess) setTimeout(() => controller.abort(), 1_010); else if (!options.heartbeatError) controller.abort(); return { url: "https://127.0.0.1:8443", stop() { if (options.stopError) throw new Error("secret listener close failure"); updates.push({ lifecycle: "stopped", databaseReady: false, schemaReady: false, listenerReady: false }); } }; },
    ...(options.heartbeatSuccess ? {} : { wait: async (_milliseconds: number, signal: AbortSignal) => { if (!signal.aborted && !options.heartbeatError) controller.abort(); } }),
  };
}

describe("factory pool process config", () => {
  test("snapshots the exact bounded reference-only configuration", async () => {
    const { config } = await fixture();
    const parsed = parseFactoryPoolProcessConfig(config);
    config.poolId = "mutated";
    expect(parsed).toMatchObject({ poolId: "pool-a", resources: { capacities: { cpu: 4 }, gpuHosts: [] } });
    // A pool serves every installation of its fleet (C12), so its config names none.
    expect(parseFactoryPoolProcessConfig({ ...config, poolId: "pool-a" })).not.toHaveProperty("installationId");
  });

  test("rejects unknown, relative, empty, oversized, ambiguous, and unsupported configuration", async () => {
    const { config } = await fixture();
    const invalid = [
      { ...config, extra: true }, { ...config, schemaVersion: "other" }, { ...config, installationId: "installation-a" }, { ...config, poolId: "" }, { ...config, port: 0 },
      { ...config, resources: { ...config.resources, gpuProfilesPath: "relative.json" } },
      { ...config, readinessFilePath: "relative.json" }, { ...config, readinessHeartbeatMs: 999 },
      { ...config, database: { ...config.database, credentialsPath: "relative.json" } },
      { ...config, tls: { ...config.tls, caPath: "relative.pem" } },
      { ...config, tokens: { ...config.tokens, publicKeyPaths: {} } },
      { ...config, resources: { capacities: {}, gpuHosts: [] } },
      { ...config, resources: { capacities: { gpu: 1 }, gpuHosts: [] } },
      { ...config, resources: { capacities: { cpu: -1 }, gpuHosts: [] } },
      { ...config, resources: { capacities: { cpu: 1 }, gpuHosts: ["gpu-a", "gpu-a"] } },
      { ...config, identities: { tenants: {}, supervisors: {} } },
      { ...config, identities: { tenants: config.identities.tenants, supervisors: { "tenant-a": { supervisorId: "s", tokenSubject: "s", hostIds: [] } } } },
      { ...config, identities: { tenants: config.identities.tenants, supervisors: { supervisor: { supervisorId: "s", tokenSubject: "s", hostIds: ["missing"] } } } },
      // An ordinary host must still be well formed, unique, and not also a
      // whole-host allocation: one host declared as each would be two different
      // things under one name.
      { ...config, resources: { capacities: { cpu: 1 }, gpuHosts: [], hosts: [""] } },
      { ...config, resources: { capacities: { cpu: 1 }, gpuHosts: [], hosts: ["cpu-a", "cpu-a"] } },
      { ...config, resources: { capacities: { cpu: 1 }, gpuHosts: ["gpu-a"], hosts: ["gpu-a"] } },
      { ...config, resources: { capacities: { cpu: 1 }, gpuHosts: [], hosts: "cpu-a" } },
    ];
    for (const value of invalid) expect(() => parseFactoryPoolProcessConfig(value)).toThrow("factory pool config is invalid");
  });

  test("a supervisor may be authorized for an ordinary host, which is how a CPU stop ever settles", () => {
    // The ledger records a host only for a whole-host allocation, so a CPU
    // reservation has none and this pool tracks no such host. C03 still settles
    // a CPU stop only on a trusted supervisor's word, and the supervisor must be
    // authorized for the host it names — so with nowhere to declare an ordinary
    // host, a CPU-only installation could register no supervisor at all and
    // every signed stop was refused with "cannot be acknowledged before a
    // supervisor confirms it". Measured on a real run.
    const base = {
      schemaVersion: "factory.pool-process.v1", poolId: "pool-a",
      hostname: "127.0.0.1", port: 8443,
      database: { credentialsPath: "/tmp/pool-db.json", expectedDatabase: "pool", expectedRole: "pool" },
      tls: { privateKeyPath: "/tmp/server.key", certificatePath: "/tmp/server.pem", caPath: "/tmp/ca.pem" },
      tokens: { issuer: "issuer", audience: "audience", publicKeyPaths: { key: "/tmp/key.pem" } },
      readinessFilePath: "/tmp/pool-readiness.json",
    };
    const parsed = parseFactoryPoolProcessConfig({
      ...base,
      identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: { supervisor: { supervisorId: "supervisor-a", tokenSubject: "supervisor", hostIds: ["cpu-a"] } } },
      resources: { capacities: { cpu: 4 }, gpuHosts: [], hosts: ["cpu-a"] },
    });
    expect(parsed.resources.hosts).toEqual(["cpu-a"]);
    // Declaring the host grants nothing: a typo is still refused.
    expect(() => parseFactoryPoolProcessConfig({
      ...base,
      identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: { supervisor: { supervisorId: "supervisor-a", tokenSubject: "supervisor", hostIds: ["cpu-b"] } } },
      resources: { capacities: { cpu: 4 }, gpuHosts: [], hosts: ["cpu-a"] },
    })).toThrow("factory pool config is invalid");
  });
});

describe("factory pool process lifecycle", () => {
  test("validates, initializes, binds resources, listens, and closes truthfully", async () => {
    const { paths } = await fixture({ resources: { capacities: { cpu: 4, memory: 8 }, gpuHosts: ["gpu-a"] }, identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: { supervisor: { supervisorId: "supervisor-a", tokenSubject: "supervisor", hostIds: ["gpu-a"] } } } });
    const database = new ProcessDatabase(); const controller = new AbortController(); const updates: FactoryPoolReadinessUpdate[] = [];
    await runConfiguredFactoryPoolProcess(paths.config, controller.signal, dependencies(database, controller, updates));
    // The pool database is bound to the pool alone: one pool serves every installation on its host.
    expect(database.identity).toEqual({ pool_id: "pool-a" });
    expect(Object.fromEntries(database.resources)).toEqual({ cpu: 4, memory: 8, "gpu-host": 1 });
    expect([...database.hosts]).toEqual(["gpu-a"]);
    expect(database.closed).toBe(true);
    expect(updates.some(value => value.lifecycle === "ready" && value.listenerReady)).toBe(true);
    expect(updates.at(-1)).toMatchObject({ lifecycle: "stopped", databaseReady: false });
  });

  test("accepts Bun row objects and publishes a successful production heartbeat before shutdown", async () => {
    const { paths } = await fixture(); const database = new ProcessDatabase(); database.resultRowsObject = true;
    const controller = new AbortController(); const updates: FactoryPoolReadinessUpdate[] = [];
    await runConfiguredFactoryPoolProcess(paths.config, controller.signal, dependencies(database, controller, updates, { heartbeatSuccess: true }));
    expect(database.databaseChecks).toBeGreaterThanOrEqual(2);
    expect(updates.filter(value => value.lifecycle === "ready")).toHaveLength(2);
  });

  test("reports generic configuration, database, resource, listener, and heartbeat failures", async () => {
    const badMaterial = await fixture(); await writeFile(badMaterial.paths.publicKey, "private-secret", { mode: 0o600 });
    const badDatabase = new ProcessDatabase(); const badController = new AbortController(); const badUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(badMaterial.paths.config, badController.signal, dependencies(badDatabase, badController, badUpdates))).rejects.toThrow("configuration_unavailable");
    expect(badUpdates.at(-1)).toMatchObject({ lifecycle: "degraded", errorCode: "configuration_unavailable" });

    const wrongIdentity = await fixture({ database: { credentialsPath: badMaterial.paths.database, expectedDatabase: "wrong", expectedRole: "pool_role" } });
    const identityDatabase = new ProcessDatabase(); const identityController = new AbortController(); const identityUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(wrongIdentity.paths.config, identityController.signal, dependencies(identityDatabase, identityController, identityUpdates))).rejects.toThrow("database_unavailable");

    const mismatch = await fixture(); const mismatchDatabase = new ProcessDatabase(); mismatchDatabase.resources.set("provider", 1);
    const mismatchController = new AbortController(); const mismatchUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(mismatch.paths.config, mismatchController.signal, dependencies(mismatchDatabase, mismatchController, mismatchUpdates))).rejects.toThrow("schema_unavailable");

    // GPU host profiles load before the listener binds: a missing or invalid declaration keeps the pool degraded by name.
    const profiles = await fixture(); const profilesPath = join(profiles.paths.database, "..", "gpu-profiles.json");
    const invalidProfiles = await fixture({ resources: { capacities: { cpu: 4 }, gpuHosts: [], gpuProfilesPath: profilesPath } });
    await writeFile(profilesPath, JSON.stringify({ schemaVersion: "factory.gpu-host-profiles.v1", hosts: [{ hostId: "gpu-unoffered", tier: "trusted-local", devices: [], cdiDevices: [] }] }), { mode: 0o600 });
    const profilesController = new AbortController(); const profilesUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(invalidProfiles.paths.config, profilesController.signal, dependencies(new ProcessDatabase(), profilesController, profilesUpdates))).rejects.toThrow("gpu_profiles_unavailable");
    expect(profilesUpdates.at(-1)).toMatchObject({ lifecycle: "degraded", errorCode: "gpu_profiles_unavailable", listenerReady: false });
    await writeFile(profilesPath, JSON.stringify({ schemaVersion: "factory.gpu-host-profiles.v1", hosts: [] }), { mode: 0o600 });
    const validController = new AbortController(); const validUpdates: FactoryPoolReadinessUpdate[] = [];
    await runConfiguredFactoryPoolProcess(invalidProfiles.paths.config, validController.signal, dependencies(new ProcessDatabase(), validController, validUpdates));
    expect(validUpdates.some((update) => update.lifecycle === "ready" && update.listenerReady)).toBe(true);

    const listener = await fixture(); const listenerDatabase = new ProcessDatabase(); const listenerController = new AbortController(); const listenerUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(listener.paths.config, listenerController.signal, dependencies(listenerDatabase, listenerController, listenerUpdates, { startError: true }))).rejects.toThrow("listener_unavailable");

    const heartbeat = await fixture(); const heartbeatDatabase = new ProcessDatabase(); const heartbeatController = new AbortController(); const heartbeatUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(heartbeat.paths.config, heartbeatController.signal, dependencies(heartbeatDatabase, heartbeatController, heartbeatUpdates, { heartbeatError: true }))).rejects.toThrow("database_unavailable");
    expect(heartbeatUpdates.at(-1)).toMatchObject({ lifecycle: "degraded", errorCode: "database_unavailable", listenerReady: false });

    const invalidRowsFixture = await fixture(); const invalidRowsDatabase = new ProcessDatabase(); invalidRowsDatabase.invalidRows = true;
    const invalidRowsController = new AbortController(); const invalidRowsUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(invalidRowsFixture.paths.config, invalidRowsController.signal, dependencies(invalidRowsDatabase, invalidRowsController, invalidRowsUpdates))).rejects.toThrow("database_unavailable");

    const badCredential = await fixture(); await writeFile(badCredential.paths.database, JSON.stringify({ databaseUrl: "https://private-secret" }), { mode: 0o600 });
    const credentialController = new AbortController(); const credentialUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(badCredential.paths.config, credentialController.signal, dependencies(new ProcessDatabase(), credentialController, credentialUpdates))).rejects.toThrow("configuration_unavailable");

    const wrongPool = await fixture(); const wrongPoolDatabase = new ProcessDatabase(); wrongPoolDatabase.identity = { pool_id: "other" };
    const wrongPoolController = new AbortController(); const wrongPoolUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(wrongPool.paths.config, wrongPoolController.signal, dependencies(wrongPoolDatabase, wrongPoolController, wrongPoolUpdates))).rejects.toThrow("database_unavailable");

    const closeFailure = await fixture(); const closeDatabase = new ProcessDatabase(); closeDatabase.failClose = true;
    const closeController = new AbortController(); const closeUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(closeFailure.paths.config, closeController.signal, dependencies(closeDatabase, closeController, closeUpdates))).rejects.toThrow("database_close_failed");
    expect(closeUpdates.at(-1)).toMatchObject({ lifecycle: "degraded", errorCode: "database_close_failed" });

    const stopFailure = await fixture(); const stopDatabase = new ProcessDatabase(); const stopController = new AbortController(); const stopUpdates: FactoryPoolReadinessUpdate[] = [];
    await expect(runConfiguredFactoryPoolProcess(stopFailure.paths.config, stopController.signal, dependencies(stopDatabase, stopController, stopUpdates, { stopError: true }))).rejects.toThrow("listener_close_failed");
    expect(stopDatabase.closed).toBe(true);
  });

  test("rejects inaccessible config without creating readiness", async () => {
    const { paths } = await fixture(); await chmod(paths.config, 0o644);
    const controller = new AbortController();
    await expect(runConfiguredFactoryPoolProcess(paths.config, controller.signal, dependencies(new ProcessDatabase(), controller, []))).rejects.toThrow("factory pool config is unavailable");
  });
});

test("main binds both stop signals, removes them, and marks failures", async () => {
  const listeners = new Map<string, () => void>(); let removed = 0; let failed = 0; let observed = false;
  const main = { runConfigured: async (_path: string, signal: AbortSignal) => { listeners.get("SIGTERM")!(); observed = signal.aborted; }, once: (event: "SIGINT" | "SIGTERM", listener: () => void) => { listeners.set(event, listener); }, removeListener: () => { removed++; }, fail: () => { failed++; } };
  await runFactoryPoolMain(["bun", "process.ts", "/private/pool.json"], main);
  expect({ observed, removed }).toEqual({ observed: true, removed: 2 });
  await expect(runFactoryPoolMain(["bun", "process.ts"], main)).rejects.toThrow("config path is required");
  startFactoryPoolMain(["bun", "/not-this-file.ts"], import.meta.url, main);
  startFactoryPoolMain(["bun", new URL(import.meta.url).pathname, "/private/pool.json"], import.meta.url, { ...main, runConfigured: async () => { throw new Error("failed"); } });
  await Bun.sleep(0);
  expect(failed).toBe(1);
});
