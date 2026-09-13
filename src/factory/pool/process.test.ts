import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificates } from "../../__tests__/helpers/factory-certificates";
import { parseFactoryPoolProcessConfig, runConfiguredFactoryPoolProcess, runFactoryPoolMain, startFactoryPoolMain, type FactoryPoolProcessDependencies } from "./process";
import type { FactoryPoolReadinessUpdate } from "./readiness";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(overrides: Record<string, unknown> = {}) {
  const certs = await certificates(directories);
  const certificateRoot = directories.at(-1)!;
  const root = await mkdtemp(join(process.env.HOME!, ".factory-pool-process-")); directories.push(root);
  await Promise.all(["server.key", "server.pem", "ca.pem"].map(name => copyFile(join(certificateRoot, name), join(root, name))));
  await Promise.all(["server.key", "server.pem", "ca.pem"].map(name => chmod(join(root, name), 0o600)));
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const paths = { config: join(root, "pool.json"), database: join(root, "database.json"), publicKey: join(root, "token.pem"), readiness: join(root, "ready.json") };
  await Promise.all([
    writeFile(paths.database, JSON.stringify({ databaseUrl: "postgres://pool_role:private-secret@localhost:5432/pool_db" }), { mode: 0o600 }),
    writeFile(paths.publicKey, keys.publicKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 }),
  ]);
  const config = {
    schemaVersion: "factory.pool-process.v1", installationId: "installation-a", poolId: "pool-a", hostname: "127.0.0.1", port: 8443,
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
  identity: { installation_id: string; pool_id: string } | undefined;
  databaseChecks = 0;
  closed = false;
  failCheckAfter = Number.POSITIVE_INFINITY;
  resultRowsObject = false;
  invalidRows = false;
  failClose = false;
  async begin<Result>(work: (database: ProcessDatabase) => Promise<Result>): Promise<Result> { return work(this); }
  async unsafe(query: string, params: readonly unknown[] = []): Promise<unknown> {
    if (query.includes("current_database")) { this.databaseChecks++; if (this.databaseChecks > this.failCheckAfter) throw new Error("secret database error"); if (this.invalidRows) return {}; const value = [{ database: "pool_db", role: "pool_role" }]; return this.resultRowsObject ? { rows: value } : value; }
    if (query.startsWith("INSERT INTO factory_pool_identity")) { this.identity ??= { installation_id: String(params[0]), pool_id: String(params[1]) }; return []; }
    if (query.startsWith("SELECT installation_id")) return this.identity ? [this.identity] : [];
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
    readiness: () => ({ async write(update) { updates.push(update); return { schemaVersion: "factory.pool-readiness.v1", installationId: "i", poolId: "p", observedAtMs: 1, ...update }; } }),
    start: async input => { expect(input).toMatchObject({ hostname: "127.0.0.1", port: 8443 }); if (options.startError) throw new Error("secret listener error"); if (options.heartbeatSuccess) setTimeout(() => controller.abort(), 1_010); else if (!options.heartbeatError) controller.abort(); return { url: "https://127.0.0.1:8443", stop() { if (options.stopError) throw new Error("secret listener close failure"); updates.push({ lifecycle: "stopped", databaseReady: false, schemaReady: false, listenerReady: false }); } }; },
    ...(options.heartbeatSuccess ? {} : { wait: async (_milliseconds: number, signal: AbortSignal) => { if (!signal.aborted && !options.heartbeatError) controller.abort(); } }),
  };
}

describe("factory pool process config", () => {
  test("snapshots the exact bounded reference-only configuration", async () => {
    const { config } = await fixture();
    const parsed = parseFactoryPoolProcessConfig(config);
    config.installationId = "mutated";
    expect(parsed).toMatchObject({ installationId: "installation-a", resources: { capacities: { cpu: 4 }, gpuHosts: [] } });
  });

  test("rejects unknown, relative, empty, oversized, ambiguous, and unsupported configuration", async () => {
    const { config } = await fixture();
    const invalid = [
      { ...config, extra: true }, { ...config, schemaVersion: "other" }, { ...config, installationId: "" }, { ...config, port: 0 },
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
    ];
    for (const value of invalid) expect(() => parseFactoryPoolProcessConfig(value)).toThrow("factory pool config is invalid");
  });
});

describe("factory pool process lifecycle", () => {
  test("validates, initializes, binds resources, listens, and closes truthfully", async () => {
    const { paths } = await fixture({ resources: { capacities: { cpu: 4, memory: 8 }, gpuHosts: ["gpu-a"] }, identities: { tenants: { "tenant-a": { tenantId: "tenant-a", tokenSubject: "tenant-a" } }, supervisors: { supervisor: { supervisorId: "supervisor-a", tokenSubject: "supervisor", hostIds: ["gpu-a"] } } } });
    const database = new ProcessDatabase(); const controller = new AbortController(); const updates: FactoryPoolReadinessUpdate[] = [];
    await runConfiguredFactoryPoolProcess(paths.config, controller.signal, dependencies(database, controller, updates));
    expect(database.identity).toEqual({ installation_id: "installation-a", pool_id: "pool-a" });
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

    const wrongPool = await fixture(); const wrongPoolDatabase = new ProcessDatabase(); wrongPoolDatabase.identity = { installation_id: "other", pool_id: "other" };
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
