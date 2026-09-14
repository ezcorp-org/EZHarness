import { afterEach, describe, expect, test } from "bun:test";
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
  factoryGatewayProbeTarget,
  factoryStartupConfigPath,
  factoryStorageProbeTarget,
  startFactoryInstallation,
  type FactoryInstallationHost,
  type FactoryInstallationStartupError,
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
      observedAtMs: Date.now() - 120_000, facts: { hostKeyReady: true, runnerReady: true },
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
