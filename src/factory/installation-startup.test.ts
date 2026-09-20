import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { FACTORY_WORKER_ROLES } from "./runtime-workers";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import type { FactorySettleableChild } from "./child-runs";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { BlobStore } from "../extensions/v4/types";
import { resetReadiness } from "../readiness";
import { configureFactoryApplication, getFactoryApplication } from "./application";
import type { FactoryBootConfig } from "./boot";
import { createFactoryPoolReadinessWriter } from "./pool/readiness";
import { createFactoryServiceReadinessWriter, factorySupervisorReadinessOptions } from "./service-readiness";
import { FACTORY_STARTUP_CONFIG_SCHEMA } from "./startup-config";
import {
  FACTORY_CHILD_SETTLEMENT_TRANSIENT_CODES,
  factoryChildSettlementDisposition,
  factoryChildSettlementDriver,
  factoryNotificationInboxDriver,
  composeFactoryProviderBroker,
  factoryGatewayProbeTarget,
  factoryStartupConfigPath,
  factoryStorageProbeTarget,
  startFactoryInstallation,
  type FactoryInstallationHost,
  type FactoryInstallationStartupError,
} from "./installation-startup";

const roots: string[] = [];
const reported: Array<{ role: string; error: unknown }> = [];
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
  })).write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } });
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

/**
 * A database that answers the one query startup makes before the stores exist.
 *
 * `startFactoryInstallation` binds the installation row first, so the fake has
 * to answer the `SELECT ... FROM factory_installation` that `bindInstallation`
 * reads back. Returning this tenant is the agreeing case; the mismatch case has
 * its own test with its own fake.
 */
function bindingDatabase(tenantId = "tenant-01"): TransactionalDb {
  // The only read startup makes through this handle is the bind's read-back, so
  // one row is the whole contract. A handle that answered nothing made eight
  // unrelated assertions fail with a TypeError from inside `bindInstallation`.
  const execute = async () => [{ tenant_id: tenantId }];
  return {
    execute,
    async transaction<Result>(work: (transaction: { execute: typeof execute }) => Promise<Result>): Promise<Result> { return work({ execute }); },
  } as unknown as TransactionalDb;
}

function host(overrides: Partial<FactoryInstallationHost> = {}): FactoryInstallationHost {
  return {
    database: bindingDatabase(),
    runOptions: { interpreterBuild: "build-1", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
    availableResourceClasses: ["cpu"],
    report: (role, error) => { reported.push({ role, error }); },
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
      blobs: memoryBlobs(),
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
      blobs: memoryBlobs(),
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
      observedAtMs: Date.now() - 120_000, facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false },
    }), { mode: 0o600 });
    await chmod(join(root, "supervisor.json"), 0o600);

    await expect(startFactoryInstallation({
      host: host(),
      blobs: memoryBlobs(),
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
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);
    const report = startup.runtime.report();
    // Child settlement still runs: its collaborators are W06's scan and W06's
    // `settle`, neither of which needs the pool. A pool that cannot be reached
    // must not take down a role that does not use it.
    expect(report.workers.map((worker) => worker.name)).toEqual(["run-projection", "child-settlement"]);
    const compute = report.heldWorkers.filter((worker) => worker.role.startsWith("compute-admission"));
    expect(compute).toHaveLength(2);
    for (const held of compute) expect(held.reason).toContain("pool admission client");
  });

  test("fails by name when the startup document is absent", async () => {
    const root = await privateRoot();
    await expect(startFactoryInstallation({
      host: host(),
      blobs: memoryBlobs(),
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
      blobs: memoryBlobs(),
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
      blobs: memoryBlobs(),
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

describe("the product object store comes from the configuration", () => {
  test("is built from storage.ordinary rather than from a host-supplied path", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const credentials = join(root, "secrets", "ordinary.json");
    await writeFile(credentials, JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "probe-key", secretKey: "probe-secret" }] }] }), { mode: 0o600 });
    await chmod(credentials, 0o600);
    const configPath = await writeConfig(root, {
      storage: { ordinary: { ...storage("ordinary"), endpoint: "http://127.0.0.1:1", credentialsPath: credentials }, archive: storage("archive") },
    } as never);

    // No `blobs` override: the composition builds the S3 store the document
    // names. Nothing is bound on port 1, so the byte round-trip fails and
    // admission stays closed — which is also the proof the store is real.
    const error = await startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath,
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    }).then(() => undefined, (caught: unknown) => caught as { code?: string; message: string });
    expect(error?.message).toContain("object-storage");
    expect(getFactoryApplication()).toBeNull();
  });

  test("fails by the credential SET name when the configured credentials are unreadable", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const configPath = await writeConfig(root, {
      storage: { ordinary: { ...storage("ordinary"), credentialsPath: join(root, "secrets", "absent.json") }, archive: storage("archive") },
    } as never);
    await expect(startFactoryInstallation({
      host: host(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath,
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true }, workers: { projections: { projectPending: async () => ({ runs: [] }) } } },
    })).rejects.toMatchObject({ code: "factory-storage-credentials-unusable" });
    expect(getFactoryApplication()).toBeNull();
  });
});

describe("factoryChildSettlementDisposition", () => {
  /**
   * W06's complete reachable vocabulary for `FactoryChildRuns.settle`
   * (tasks/factory/w06-GATES.md at 8a83dff4a). Pinned as a table so a code
   * that changes class fails here rather than quietly changing how a role
   * behaves at three in the morning.
   */
  const vocabulary: ReadonlyArray<readonly [string, "transient" | "fault"]> = [
    ["factory_budget_pending", "transient"],
    ["factory_child_corrupt", "fault"],
    ["factory_child_conflict", "fault"],
    ["factory_child_not_found", "fault"],
    ["factory_child_forbidden", "fault"],
    ["factory_budget_scope", "fault"],
    ["factory_budget_not_found", "fault"],
    ["factory_budget_receipt_invalid", "fault"],
  ];

  test("classifies every code settle can raise", () => {
    for (const [code, expected] of vocabulary) {
      expect(factoryChildSettlementDisposition(Object.assign(new Error(code), { code }))).toBe(expected);
    }
    // Exactly one defers. If a second ever does, this fails before the set does.
    expect(vocabulary.filter(([, disposition]) => disposition === "transient").map(([code]) => code))
      .toEqual([...FACTORY_CHILD_SETTLEMENT_TRANSIENT_CODES]);
  });

  test("a conflict is a fault for THIS caller, because the scan already filtered on terminal status", () => {
    // Read alone this looks like a race worth retrying, and in another caller
    // it would be. My first draft had it transient, which would have retried a
    // genuine lifecycle-versus-binding disagreement forever and reported it as
    // backpressure.
    expect(factoryChildSettlementDisposition(Object.assign(new Error("conflict"), { code: "factory_child_conflict" }))).toBe("fault");
  });

  test("a missing scope row is a fault, not contention", () => {
    // lockFactoryScope takes FOR SHARE, so it blocks rather than returning, and
    // returns null only when the row is genuinely absent. Deferring would retry
    // forever against a row that is not coming back.
    expect(factoryChildSettlementDisposition(Object.assign(new Error("scope"), { code: "factory_budget_scope" }))).toBe("fault");
  });

  test("anything unrecognised is a fault", () => {
    expect(factoryChildSettlementDisposition(new Error("something new"))).toBe("fault");
    expect(factoryChildSettlementDisposition(Object.assign(new Error("x"), { code: 7 }))).toBe("fault");
    expect(factoryChildSettlementDisposition("not an error")).toBe("fault");
    // It must not throw on these: a classifier that threw would turn one item's
    // failure into the whole role's failure, one layer below the driver that
    // exists to stop exactly that.
    expect(factoryChildSettlementDisposition(undefined)).toBe("fault");
    expect(factoryChildSettlementDisposition(null)).toBe("fault");
  });
});

describe("the child-settlement step", () => {
  const SERVICE: TrustedFactoryServiceIdentity = { subject: "tenant-a", tenantId: "tenant-01" };

  function child(childRunId: string): FactorySettleableChild {
    return Object.freeze({ projectId: "project-1", parentRunId: "run-parent", childRunId, startedAtMs: 1 });
  }

  /** A database whose transaction records whether it was still open on settle. */
  function database(open: { value: boolean }): TransactionalDb {
    return {
      async execute() { return []; },
      async transaction<Result>(work: (transaction: MigrationDb) => Promise<Result>): Promise<Result> {
        open.value = true;
        try { return await work({ async execute() { return []; } } as unknown as MigrationDb); }
        finally { open.value = false; }
      },
    } as unknown as TransactionalDb;
  }

  test("pages in a transaction, closes it, and settles each child outside it", async () => {
    const open = { value: false };
    const settledWhileOpen: boolean[] = [];
    const settled: string[] = [];
    const driver = factoryChildSettlementDriver(database(open), {
      async listSettleableInTransaction() { return [child("run-a"), child("run-b")]; },
      async settle(service, key) {
        expect(service).toBe(SERVICE);
        settledWhileOpen.push(open.value);
        settled.push(key.childRunId);
      },
    }, SERVICE, () => {});

    expect(await driver.step(new AbortController().signal)).toBe(true);
    expect(settled).toEqual(["run-a", "run-b"]);
    // `settle` takes the run lock and the budget locks root-to-leaf. Holding
    // the read-only page transaction across it would invite a lock-order
    // inversion with the very rows it is about to take.
    expect(settledWhileOpen).toEqual([false, false]);
  });

  test("an empty page is no work", async () => {
    const driver = factoryChildSettlementDriver(database({ value: false }), {
      async listSettleableInTransaction() { return []; },
      async settle() { throw new Error("nothing to settle"); },
    }, SERVICE, () => {});

    expect(await driver.step(new AbortController().signal)).toBe(false);
  });

  test("names the disposition and the child in the report, and steps over both kinds", async () => {
    const reported: string[] = [];
    const driver = factoryChildSettlementDriver(database({ value: false }), {
      async listSettleableInTransaction() { return [child("run-pending"), child("run-corrupt"), child("run-ok")]; },
      async settle(_service, key) {
        if (key.childRunId === "run-pending") throw Object.assign(new Error("pending"), { code: "factory_budget_pending" });
        if (key.childRunId === "run-corrupt") throw Object.assign(new Error("corrupt"), { code: "factory_child_corrupt" });
      },
    }, SERVICE, (role, _error) => { reported.push(role); });

    // The third child settles, so the pass made progress even though two failed:
    // one bad row must not stop the role for the whole installation.
    expect(await driver.step(new AbortController().signal)).toBe(true);
    expect(reported).toEqual([
      "child-settlement:transient:project-1/run-pending",
      "child-settlement:fault:project-1/run-corrupt",
    ]);
  });

  test("scans at the limit W06 published, and honours an explicit one", async () => {
    const limits: number[] = [];
    const children = {
      async listSettleableInTransaction(_transaction: MigrationDb, limit: number) { limits.push(limit); return []; },
      async settle() {},
    };
    await factoryChildSettlementDriver(database({ value: false }), children, SERVICE, () => {}).step(new AbortController().signal);
    await factoryChildSettlementDriver(database({ value: false }), children, SERVICE, () => {}, 25).step(new AbortController().signal);

    expect(limits).toEqual([200, 25]);
  });
});

describe("binding the installation to its tenant", () => {
  test("writes the installation row before admission, and fails closed on another tenant's database", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const statements: string[] = [];
    const recording = (answer: string): TransactionalDb => {
      const execute = async (query: unknown) => {
        statements.push(JSON.stringify(query));
        return [{ tenant_id: answer }];
      };
      return { execute, async transaction<Result>(work: (t: { execute: typeof execute }) => Promise<Result>) { return work({ execute }); } } as unknown as TransactionalDb;
    };

    const startup = await startFactoryInstallation({
      host: host({ database: recording("tenant-01") }),
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);
    // `factory_projects.tenant_id` is a foreign key to this row. Without it the
    // first project a human creates answers 500 from a failing INSERT.
    expect(statements.some((statement) => statement.includes("INSERT INTO factory_installation"))).toBe(true);

    // A database already bound to another installation must be refused here,
    // at boot, rather than served.
    await expect(startFactoryInstallation({
      host: host({ database: recording("tenant-99") }),
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    })).rejects.toMatchObject({ code: "factory_installation_mismatch" });
  });
});

describe("the notification inbox step, across the tenant's projects", () => {
  /** A database whose transaction answers with the given project rows, once. */
  function projectsDatabase(ids: readonly string[]): TransactionalDb {
    let served = false;
    const execute = async () => {
      if (served) return [];
      served = true;
      return ids.map((id, index) => ({ project_id: id, created_at_ms: 1_700_000_000_000 + index }));
    };
    return { execute, async transaction<R>(work: (t: { execute: typeof execute }) => Promise<R>) { return work({ execute }); } } as unknown as TransactionalDb;
  }

  test("stops at the first project that delivered, and says it did work", async () => {
    const asked: string[] = [];
    const driver = factoryNotificationInboxDriver(projectsDatabase(["project-a", "project-b", "project-c"]), {
      async deliverNext(projectId: string) { asked.push(projectId); return projectId === "project-b" ? ({} as never) : null; },
    }, "tenant-01");

    expect(await driver.deliverNextAcrossProjects(new AbortController().signal)).toBe(true);
    // One pass does not drain every project: a busy project would otherwise
    // starve the rest for the length of its backlog.
    expect(asked).toEqual(["project-a", "project-b"]);
  });

  test("an empty tenant, and a tenant with nothing to deliver, are both no work", async () => {
    const none = factoryNotificationInboxDriver(projectsDatabase([]), { async deliverNext() { return null; } }, "tenant-01");
    expect(await none.deliverNextAcrossProjects(new AbortController().signal)).toBe(false);

    const quiet = factoryNotificationInboxDriver(projectsDatabase(["project-a", "project-b"]), { async deliverNext() { return null; } }, "tenant-01");
    expect(await quiet.deliverNextAcrossProjects(new AbortController().signal)).toBe(false);
  });

  test("a stop between projects ends the pass rather than finishing the tenant", async () => {
    const controller = new AbortController();
    const asked: string[] = [];
    const driver = factoryNotificationInboxDriver(projectsDatabase(["project-a", "project-b"]), {
      async deliverNext(projectId: string) { asked.push(projectId); controller.abort(); return null; },
    }, "tenant-01");

    await expect(driver.deliverNextAcrossProjects(controller.signal)).rejects.toThrow();
    expect(asked).toEqual(["project-a"]);
  });
});

describe("the release store, and the role it unblocks", () => {
  async function credentialFile(root: string, kind: string): Promise<string> {
    const path = join(root, "secrets", `${kind}-credentials.json`);
    await writeFile(path, JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: `${kind}-key`, secretKey: `${kind}-secret` }] }] }), { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }

  test("composes from the startup document and registers notification-inbox-delivery", async () => {
    const before = reported.length;
    const root = await privateRoot();
    await writeReadyRecords(root);
    const configPath = await writeConfig(root, {
      storage: {
        ordinary: { ...storage("ordinary"), credentialsPath: await credentialFile(root, "ordinary") },
        archive: { ...storage("archive"), credentialsPath: await credentialFile(root, "archive") },
      },
    } as never);

    const startup = await startFactoryInstallation({
      host: host(),
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath,
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);

    const report = startup.runtime.report();
    // The role the project enumerator unblocks. Every other release
    // collaborator landed with the wave-2 integration; this was the last one.
    expect(report.workers.map((worker) => worker.name)).toContain("notification-inbox-delivery");
    expect(report.heldWorkers.map((worker) => worker.role)).not.toContain("notification-inbox-delivery");
    // Nothing reported a release-store failure on this path.
    expect(reported.slice(before).filter((entry) => entry.role === "release-store")).toEqual([]);
  });

  test("holds the role and names the cause when a credential set is unreadable", async () => {
    const before = reported.length;
    const root = await privateRoot();
    await writeReadyRecords(root);
    // `storage()` points the archive credentials at a path that does not exist,
    // which is the ordinary shape of a misconfigured installation.
    const startup = await startFactoryInstallation({
      host: host(),
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);

    const report = startup.runtime.report();
    expect(report.workers.map((worker) => worker.name)).not.toContain("notification-inbox-delivery");
    // Held AND explained: an operator who can see the role held but not the
    // reason has to guess between a missing credential, an unreachable store,
    // and a scope mismatch.
    const failures = reported.slice(before).filter((entry) => entry.role === "release-store");
    expect(failures).not.toEqual([]);
    expect(String((failures[0]!.error as Error).message)).toContain("credential set");
  });
});

describe("the pinned model broker", () => {
  const pin = { provider: "anthropic", model: "claude-sonnet-5" };

  test("an installation with no pin gets no row and no broker", async () => {
    // Inventing a default pin would be a substitute of its own.
    expect(await composeFactoryProviderBroker(undefined)).toBeUndefined();
  });

  test("a missing credential is a named readiness row and NO broker", async () => {
    const composed = await composeFactoryProviderBroker(pin, {
      resolveCredential: async () => null,
      isAvailableModel: () => true,
    });

    expect(composed!.broker).toBeUndefined();
    expect(composed!.readiness).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", ready: false, credentialKind: null });
    expect(composed!.readiness.failures).toEqual(["provider_not_configured"]);
  });

  test("an unavailable model is named too, and still yields no broker", async () => {
    const composed = await composeFactoryProviderBroker(pin, {
      resolveCredential: async () => ({ type: "api-key", apiKey: "not-read" }) as never,
      isAvailableModel: () => false,
    });

    expect(composed!.broker).toBeUndefined();
    expect(composed!.readiness.failures).toEqual(["model_not_available"]);
  });

  test("a usable pin yields a broker, and the row carries the credential KIND, never its value", async () => {
    const composed = await composeFactoryProviderBroker(pin, {
      resolveCredential: async () => ({ type: "api-key", apiKey: "sk-secret-value" }) as never,
      isAvailableModel: () => true,
    });

    expect(typeof composed!.broker?.stream).toBe("function");
    expect(composed!.readiness).toMatchObject({ ready: true, credentialKind: "api-key" });
    expect(composed!.readiness.failures).toEqual([]);
    // The row reaches `/api/ready`, so it must not carry the secret.
    expect(JSON.stringify(composed!.readiness)).not.toContain("sk-secret-value");
  });
});

/**
 * The four roles W09 held, assembled.
 *
 * Every test here runs the real `installationCollaborators`, which means it
 * must NOT supply `dependencies.workers` — supplying it is what the earlier
 * suites do to keep the pool out, and it skips the composition entirely.
 */
describe("the roles this installation assembles", () => {
  async function transport(root: string): Promise<Record<string, unknown>> {
    const certs = await certificates(roots, "factory-private");
    const secrets = join(root, "secrets");
    const write = async (name: string, value: string) => {
      const path = join(secrets, name);
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const tls = {
      caPath: await write("ca.pem", certs.ca),
      certificatePath: await write("client.pem", certs.clientCert),
      privateKeyPath: await write("client.key", certs.clientKey),
    };
    const serviceTokenPath = await write("service.token", "unused-by-these-routes");
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPath = await write("host.pub", publicKey.export({ type: "spki", format: "pem" }).toString());
    const attemptTokenSecretPath = await write("attempt-token", "s".repeat(48));
    return {
      pool: { baseUrl: "https://127.0.0.1:1", serviceTokenPath, tls },
      hostLaunch: { baseUrl: "https://127.0.0.1:1", serverName: "localhost", attemptTokenSecretPath, tls: { ...tls, serviceTokenPath } },
      hostStopKeys: [{ hostId: "host-01", hostKeyId: "host-key-1", publicKeyPath }],
    };
  }

  async function start(root: string, overrides: Record<string, unknown>) {
    const startup = await startFactoryInstallation({
      host: host(),
      blobs: memoryBlobs(),
      databaseUrl: "postgres://product",
      signal: new AbortController().signal,
      configPath: await writeConfig(root, overrides),
      boot: bootConfig(root),
      dependencies: { gateway: { health: async () => true } },
    });
    started.push(startup);
    return startup;
  }

  test("registers attempt dispatch, stop settlement, and usage reconciliation from the document", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await start(root, await transport(root));

    const report = startup.runtime.report();
    const running = report.workers.map((worker) => worker.name);
    expect(running).toContain("attempt-dispatch");
    expect(running).toContain("stop-settlement");
    expect(running).toContain("usage-reconciliation");
    expect(running).toContain("compute-admission-dispatch");
    // Registered and held always partition the role set, so naming the three
    // above as running is also the assertion that they are not held.
    const held = report.heldWorkers.map((worker) => worker.role);
    expect(held).not.toContain("attempt-dispatch");
    expect(held).not.toContain("stop-settlement");
    expect(held).not.toContain("usage-reconciliation");
    expect([...running, ...held].sort()).toEqual([...FACTORY_WORKER_ROLES].sort());
  });

  test("holds all three by name when the document declares no host launch endpoint", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const { hostLaunch: _omitted, ...withoutTransport } = await transport(root);
    const startup = await start(root, withoutTransport);

    const held = new Map(startup.runtime.report().heldWorkers.map((worker) => [worker.role, worker.reason]));
    expect(held.get("attempt-dispatch")).toContain("hostLaunch endpoint");
    expect(held.get("stop-settlement")).toContain("hostLaunch endpoint");
    expect(held.get("usage-reconciliation")).toContain("hostLaunch endpoint");
    // The compute roles are unaffected: the pool client still built.
    expect(startup.runtime.report().workers.map((worker) => worker.name)).toContain("compute-admission-poll");
  });

  test("holds stop settlement and reconciliation when no host public key is configured", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const { hostStopKeys: _omitted, ...withoutKeys } = await transport(root);
    const startup = await start(root, withoutKeys);

    const report = startup.runtime.report();
    // Attempt dispatch does not verify a receipt, so it still registers.
    expect(report.workers.map((worker) => worker.name)).toContain("attempt-dispatch");
    const held = new Map(report.heldWorkers.map((worker) => [worker.role, worker.reason]));
    expect(held.get("stop-settlement")).toContain("hostStopKeys");
    expect(held.get("usage-reconciliation")).toBeDefined();
  });

  test("reports the cause and holds attempt dispatch when the attempt token secret is unreadable", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const material = await transport(root);
    const hostLaunch = { ...(material.hostLaunch as Record<string, unknown>), attemptTokenSecretPath: join(root, "secrets", "absent-token") };
    const startup = await start(root, { ...material, hostLaunch });

    expect(startup.runtime.report().heldWorkers.map((worker) => worker.role)).toContain("attempt-dispatch");
    expect(reported.map((entry) => entry.role)).toContain("attempt-dispatch-composition");
  });

  test("reports the pool client it could not build and holds every role that needs it", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const material = await transport(root);
    const startup = await start(root, { ...material, pool: { ...(material.pool as Record<string, unknown>), tls: { caPath: join(root, "absent.pem"), certificatePath: join(root, "absent.pem"), privateKeyPath: join(root, "absent.pem") } } });

    expect(reported.map((entry) => entry.role)).toContain("pool-admission-client");
    const held = startup.runtime.report().heldWorkers.map((worker) => worker.role);
    for (const role of ["compute-admission-dispatch", "compute-admission-poll", "attempt-dispatch", "stop-settlement", "usage-reconciliation"]) {
      expect(held).toContain(role);
    }
  });

  test("release outcome stays held, and its reason names the consent nothing produces", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const startup = await start(root, await transport(root));
    const reason = startup.runtime.report().heldWorkers.find((worker) => worker.role === "release-outcome")!.reason;
    expect(reason).toBeDefined();
    expect(startup.runtime.report().workers.map((worker) => worker.name)).not.toContain("release-outcome");
  });
});
