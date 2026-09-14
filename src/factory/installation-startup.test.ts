import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { resetReadiness } from "../readiness";
import { configureFactoryApplication, getFactoryApplication } from "./application";
import type { FactoryBootConfig } from "./boot";
import { createFactoryPoolReadinessWriter } from "./pool/readiness";
import { createFactoryServiceReadinessWriter, factorySupervisorReadinessOptions } from "./service-readiness";
import { FACTORY_STARTUP_CONFIG_SCHEMA } from "./startup-config";
import {
  FactoryInstallationStartupError,
  factoryGatewayProbeTarget,
  factoryStartupConfigPath,
  factoryStorageProbeTarget,
  startFactoryInstallation,
  type FactoryInstallationHost,
} from "./installation-startup";

const roots: string[] = [];
const started: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const startup of started.splice(0)) await startup.stop();
  configureFactoryApplication(null);
  resetReadiness();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-install-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  await mkdir(join(directory, "project"), { mode: 0o700 });
  await mkdir(join(directory, "secrets"), { mode: 0o700 });
  return directory;
}

const tlsMaterial = { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" };

function storage(kind: string) {
  return { endpoint: `https://127.0.0.1:8443/${kind}`, bucket: `tenant-01-${kind}`, prefix: `factory-${kind}`, credentialSet: `${kind}-set`, credentialsPath: `/run/secrets/${kind}.json` };
}

function document(root: string): Record<string, unknown> {
  return {
    schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA,
    installationId: "installation-01",
    tenantId: "tenant-01",
    poolId: "pool-01",
    hostId: "host-01",
    temporalNamespace: "tenant-01.factory",
    orchestrationReadinessFilePath: join(root, "orchestration.json"),
    poolReadinessFilePath: join(root, "pool.json"),
    supervisorReadinessFilePath: join(root, "supervisor.json"),
    readinessHeartbeatMs: 5_000,
    gateway: { hostname: "127.0.0.1", port: 8443, tls: tlsMaterial },
    privateService: { hostname: "127.0.0.1", port: 8444, certificateIdentity: "factory-private", tls: tlsMaterial },
    pool: { baseUrl: "https://127.0.0.1:8445", serviceTokenPath: join(root, "pool-token"), tls: tlsMaterial },
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    keys: { masterKeyFilePath: join(root, "secrets", "master.key"), masterKeyId: "master-1", wrappedKeyFilePath: join(root, "secrets", "wraps.json"), grantableRoots: [join(root, "project")] },
    workers: { idleDelayMs: 10, batch: 1 },
  };
}

async function writeConfig(root: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const path = join(root, "secrets", "factory-startup.json");
  await writeFile(path, JSON.stringify({ ...document(root), ...overrides }), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function writeReadyRecords(root: string): Promise<void> {
  const orchestration = {
    schemaVersion: "factory.orchestrator-readiness.v1",
    installationId: "installation-01", tenantId: "tenant-01", namespace: "tenant-01.factory", taskQueue: "factory-orchestrator",
    lifecycle: "ready", observedAtMs: Date.now(), workerPolling: true, dispatcherLive: true, credentialGeneration: 1,
  };
  const path = join(root, "orchestration.json");
  await writeFile(path, JSON.stringify(orchestration), { mode: 0o600 });
  await chmod(path, 0o600);
  await createFactoryPoolReadinessWriter({ installationId: "installation-01", poolId: "pool-01", readinessFilePath: join(root, "pool.json"), readinessHeartbeatMs: 5_000 })
    .write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
  await createFactoryServiceReadinessWriter(factorySupervisorReadinessOptions({
    installationId: "installation-01", hostId: "host-01", readinessFilePath: join(root, "supervisor.json"), readinessHeartbeatMs: 5_000,
  })).write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true } });
}

function bootConfig(root: string, overrides: Partial<FactoryBootConfig> = {}): FactoryBootConfig {
  return {
    enabled: true, requireSandbox: true, installationId: "installation-01",
    secretsDir: join(root, "secrets"), projectRoot: join(root, "project"), grantableRoots: [join(root, "project")],
    ...overrides,
  };
}

function memoryBlobs(): BlobStore & { readonly stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    async put(content: Uint8Array) {
      const digest = `sha256-${stored.size}`;
      stored.set(digest, content);
      return digest as never;
    },
    async get(digest: string) {
      const value = stored.get(digest);
      if (!value) throw new Error("absent");
      return value;
    },
  } as unknown as BlobStore & { readonly stored: Map<string, Uint8Array> };
}

function host(overrides: Partial<FactoryInstallationHost> = {}): FactoryInstallationHost {
  return {
    database: {} as TransactionalDb,
    blobs: memoryBlobs(),
    runOptions: { interpreterBuild: "build-1", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
    availableResourceClasses: ["cpu"],
    report: () => {},
    ...overrides,
  };
}

describe("factoryStartupConfigPath", () => {
  test("prefers an explicit path and otherwise sits beside the private material", () => {
    expect(factoryStartupConfigPath({ EZCORP_FACTORY_STARTUP_CONFIG: "/run/custom.json" }, bootConfig("/srv"))).toBe("/run/custom.json");
    expect(factoryStartupConfigPath({ EZCORP_FACTORY_STARTUP_CONFIG: "  " }, bootConfig("/srv"))).toBe("/srv/secrets/factory-startup.json");
    expect(factoryStartupConfigPath({}, bootConfig("/srv"))).toBe("/srv/secrets/factory-startup.json");
    expect(factoryStartupConfigPath({}, { ...bootConfig("/srv"), secretsDir: "/srv/secrets///" })).toBe("/srv/secrets/factory-startup.json");
  });

  test("refuses by name when neither the path nor the secrets directory is set", () => {
    for (const secretsDir of [undefined, "  "]) {
      let error: FactoryInstallationStartupError | undefined;
      try {
        factoryStartupConfigPath({}, { ...bootConfig("/srv"), secretsDir });
      } catch (caught) {
        error = caught as FactoryInstallationStartupError;
      }
      expect(error?.code).toBe("factory-startup-config-missing");
    }
  });
});

describe("factoryStorageProbeTarget", () => {
  test("round-trips through the store the application will really use", async () => {
    const blobs = memoryBlobs();
    const target = factoryStorageProbeTarget(blobs);
    const written = new TextEncoder().encode("probe");
    await target.put("probe-key", written);
    expect(await target.get("probe-key")).toEqual(written);
    expect(blobs.stored.size).toBe(1);
  });

  test("refuses to read a key it never wrote rather than inventing bytes", async () => {
    const target = factoryStorageProbeTarget(memoryBlobs());
    await expect(target.get("never-written")).rejects.toMatchObject({ code: "factory-startup-blobs-missing" });
  });

  test("a store that returns a structured handle is read back by its digest", async () => {
    const stored = new Map<string, Uint8Array>();
    const structured = {
      async put(content: Uint8Array) { stored.set("sha256-x", content); return { blobDigest: "sha256-x", storageVersion: "v1" }; },
      async get(digest: string) { return stored.get(digest)!; },
    } as unknown as BlobStore;
    const target = factoryStorageProbeTarget(structured);
    const written = new TextEncoder().encode("probe");
    await target.put("k", written);
    expect(await target.get("k")).toEqual(written);
  });
});

describe("factoryGatewayProbeTarget", () => {
  test("reports the transport's own failure when the gateway is not listening", async () => {
    const root = await privateRoot();
    const target = factoryGatewayProbeTarget({ ...document(root), gateway: { hostname: "127.0.0.1", port: 1, tls: tlsMaterial } } as never);
    // Nothing is bound on port 1 and the TLS material does not exist, so the
    // probe fails rather than reporting a healthy gateway.
    await expect(target.health(new AbortController().signal)).rejects.toBeDefined();
  });
});

describe("startFactoryInstallation", () => {
  test("composes, opens admission, and runs the roles it can drive", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: {
        gateway: { health: async () => true },
        workers: { projections: { projectPending: async () => ({ runs: [] }) } },
      },
    });
    started.push(startup);

    // The dispositive fact: composition really ran, so admission is open.
    expect(getFactoryApplication()).toBe(startup.runtime.application);
    const report = startup.runtime.report();
    expect(report.admissionOpen).toBe(true);
    expect(report.probes.every((probe) => probe.available)).toBe(true);
    expect(report.workers.map((worker) => worker.name)).toContain("run-projection");
    expect(report.workers.every((worker) => worker.running)).toBe(true);
  });

  test("reads the host supervisor's own record when this process holds no runner", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    });
    started.push(startup);
    expect(startup.runtime.report().probes.find((probe) => probe.service === "host-supervisor")).toEqual({
      service: "host-supervisor", available: true, detail: "ready",
    });
  });

  test("keeps admission closed when the supervisor stops publishing", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    await writeFile(join(root, "supervisor.json"), JSON.stringify({
      schemaVersion: "factory.supervisor-readiness.v1", service: "host-supervisor",
      installationId: "installation-01", instanceId: "host-01", lifecycle: "ready",
      observedAtMs: Date.now() - 120_000, facts: { hostKeyReady: true, runnerReady: true },
    }), { mode: 0o600 });
    await chmod(join(root, "supervisor.json"), 0o600);

    await expect(startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    })).rejects.toThrow(/host-supervisor/);
    expect(getFactoryApplication()).toBeNull();
  });

  test("holds the compute roles by name when the pool client cannot be built", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    // The configured pool TLS material does not exist, so `createPoolAdmissionClient`
    // throws and the two compute roles have no driver. They must hold, not run.
    const startup = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);
    const report = startup.runtime.report();
    expect(report.workers.map((worker) => worker.name)).toEqual(["run-projection"]);
    const compute = report.heldWorkers.filter((worker) => worker.role.startsWith("compute-admission"));
    expect(compute).toHaveLength(2);
    for (const held of compute) expect(held.reason).toContain("pool admission client");
  });

  test("fails by name when the startup document is absent", async () => {
    const root = await privateRoot();
    await expect(startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      boot: bootConfig(root),
    })).rejects.toThrow(/Factory startup configuration is incomplete|ENOENT|private/i);
    expect(getFactoryApplication()).toBeNull();
  });

  test("stops the runtime and closes admission through its handle", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    });
    await startup.stop();
    expect(getFactoryApplication()).toBeNull();
    expect(startup.runtime.report().workers.every((worker) => !worker.running)).toBe(true);
  });

  test("supplying a seam registers its role through the installation path too", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      seams: { usageReconciler: { step: async () => false } },
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    });
    started.push(startup);
    expect(startup.runtime.report().workers.map((worker) => worker.name)).toContain("usage-reconciliation");
  });
});
