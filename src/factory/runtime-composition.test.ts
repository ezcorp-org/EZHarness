import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { getReadiness, resetReadiness } from "../readiness";
import { configureFactoryApplication, getFactoryApplication } from "./application";
import { FactoryBootError, type FactoryBootConfig } from "./boot";
import { createFactoryPoolReadinessWriter } from "./pool/readiness";
import { FACTORY_STARTUP_CONFIG_SCHEMA, FactoryStartupConfigError } from "./startup-config";
import { FactoryDisabledError, startFactoryRuntime, type FactoryRuntimeDependencies, type FactoryStartedListener } from "./runtime-composition";

const roots: string[] = [];
const started: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const runtime of started.splice(0)) await runtime.stop();
  configureFactoryApplication(null);
  resetReadiness();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-runtime-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  await mkdir(join(directory, "project"), { mode: 0o700 });
  await mkdir(join(directory, "secrets"), { mode: 0o700 });
  return directory;
}

function storage(kind: string) {
  return { endpoint: `https://127.0.0.1:8443/${kind}`, bucket: `tenant-01-${kind}`, prefix: `factory-${kind}`, credentialSet: `${kind}-set`, credentialsPath: `/run/secrets/${kind}.json` };
}

const tlsMaterial = { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" };

function document(root: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA,
    installationId: "installation-01",
    tenantId: "tenant-01",
    poolId: "pool-01",
    temporalNamespace: "tenant-01.factory",
    orchestrationReadinessFilePath: join(root, "orchestration.json"),
    poolReadinessFilePath: join(root, "pool.json"),
    supervisorReadinessFilePath: join(root, "supervisor.json"),
    hostId: "host-01",
    orphanSweepIntervalMs: 30_000,
    readinessHeartbeatMs: 5_000,
    gateway: { hostname: "127.0.0.1", port: 8443, tls: tlsMaterial },
    privateService: { hostname: "127.0.0.1", port: 8444, certificateIdentity: "factory-private", tls: tlsMaterial },
    pool: { baseUrl: "https://127.0.0.1:8445", serviceTokenPath: "/run/secrets/pool-token", tls: tlsMaterial },
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    keys: { masterKeyFilePath: "/run/secrets/master.key", masterKeyId: "master-1", wrappedKeyFilePath: "/run/secrets/wraps.json", grantableRoots: ["/srv/project"] },
    workers: { idleDelayMs: 10, batch: 2 },
    ...overrides,
  };
}

async function writeReadyRecords(root: string): Promise<void> {
  const state = {
    schemaVersion: "factory.orchestrator-readiness.v1",
    installationId: "installation-01", tenantId: "tenant-01", namespace: "tenant-01.factory", taskQueue: "factory-orchestrator",
    lifecycle: "ready", observedAtMs: Date.now(), workerPolling: true, dispatcherLive: true, credentialGeneration: 1,
  };
  const path = join(root, "orchestration.json");
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await chmod(path, 0o600);
  const writer = createFactoryPoolReadinessWriter({ installationId: "installation-01", poolId: "pool-01", readinessFilePath: join(root, "pool.json"), readinessHeartbeatMs: 5_000 });
  await writer.write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
}

/**
 * `assertFactoryBootConfiguration` canonicalises both paths, and an
 * unresolvable one fails closed, so the fixture uses real directories: a
 * project root that may be granted to an extension, and a secrets directory
 * outside it.
 */
function bootConfig(root: string, overrides: Partial<FactoryBootConfig> = {}): FactoryBootConfig {
  return {
    enabled: true, requireSandbox: true, installationId: "installation-01",
    secretsDir: join(root, "secrets"), projectRoot: join(root, "project"), grantableRoots: [join(root, "project")],
    ...overrides,
  };
}

function listener(record: string[], name: string): FactoryStartedListener {
  return { url: `https://127.0.0.1/${name}`, stop: () => { record.push(name); } };
}

function dependencies(overrides: Partial<FactoryRuntimeDependencies> = {}): FactoryRuntimeDependencies {
  const stored = new Map<string, Uint8Array>();
  return {
    database: {} as TransactionalDb,
    application: {
      blobs: {} as BlobStore,
      runOptions: { interpreterBuild: "immutable-build", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
      availableResourceClasses: ["cpu"],
    },
    listeners: [],
    storage: { async put(key, content) { stored.set(key, content); }, async get(key) { return stored.get(key)!; } },
    gateway: { health: async () => true },
    supervisor: { preflight: async () => {} },
    service: { subject: "factory-private", tenantId: "tenant-01" },
    workers: {
      compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
      attempts: { dispatchOne: async () => ({ kind: "idle" }) },
      projections: { projectPending: async () => ({ runs: [] }) },
    },
    report: () => {},
    ...overrides,
  };
}

async function start(root: string, overrides: Partial<FactoryRuntimeDependencies> = {}, documentOverrides: Record<string, unknown> = {}) {
  const controller = new AbortController();
  const runtime = await startFactoryRuntime(document(root, documentOverrides), "postgres://product", dependencies(overrides), controller.signal, bootConfig(root));
  started.push(runtime);
  return runtime;
}


/** Awaits a start that must fail closed, and returns the boot error it raised. */
async function bootFailure(starting: Promise<unknown>): Promise<FactoryBootError> {
  try {
    await starting;
  } catch (caught) {
    return caught as FactoryBootError;
  }
  throw new Error("the runtime started when it should have refused");
}

describe("startFactoryRuntime refuses before it builds", () => {
  test("starts no factory service when the flag is off", async () => {
    const root = await privateRoot();
    const stops: string[] = [];
    await expect(startFactoryRuntime(document(root), "postgres://product", dependencies({ listeners: [listener(stops, "gateway")] }), new AbortController().signal,
      bootConfig(root, { enabled: false }))).rejects.toBeInstanceOf(FactoryDisabledError);
    expect(getFactoryApplication()).toBeNull();
    // The disabled path never got as far as owning a listener.
    expect(stops).toEqual([]);
  });

  test("the disabled error carries the reason string C09 names", async () => {
    const root = await privateRoot();
    let error: FactoryDisabledError | undefined;
    try {
      await startFactoryRuntime(document(root), "postgres://product", dependencies(), new AbortController().signal, bootConfig(root, { enabled: false }));
    } catch (caught) {
      error = caught as FactoryDisabledError;
    }
    expect(error).toBeInstanceOf(FactoryDisabledError);
    expect(error!.code).toBe("factory-disabled");
  });

  test("names every missing dependency before opening a credential or binding a port", async () => {
    const root = await privateRoot();
    const incomplete = document(root);
    delete incomplete.poolReadinessFilePath;
    delete (incomplete.keys as Record<string, unknown>).masterKeyId;
    await expect(startFactoryRuntime(incomplete, "postgres://product", dependencies(), new AbortController().signal, bootConfig(root)))
      .rejects.toThrow(/Missing: poolReadinessFilePath, keys\.masterKeyId/);
    expect(getFactoryApplication()).toBeNull();
  });

  test("a flag-on PGlite installation fails by name before any probe", async () => {
    const root = await privateRoot();
    let probed = false;
    const error = await bootFailure(startFactoryRuntime(document(root), undefined,
      dependencies({ gateway: { health: async () => { probed = true; return true; } } }), new AbortController().signal, bootConfig(root)));
    expect(error).toBeInstanceOf(FactoryBootError);
    expect(error.code).toBe("factory-pglite-unsupported");
    expect(probed).toBe(false);
    expect(getFactoryApplication()).toBeNull();
  });
});

describe("startFactoryRuntime keeps admission closed until every probe passes", () => {
  test("refuses to configure the application when a required service is down", async () => {
    const root = await privateRoot();
    // No readiness records exist, so orchestration, temporal, and the pool fail.
    const stops: string[] = [];
    const error = await bootFailure(start(root, { listeners: [listener(stops, "gateway"), listener(stops, "private")] }));
    expect(error).toBeInstanceOf(FactoryBootError);
    expect(error.code).toBe("factory-services-unavailable");
    expect(error.message).toContain("temporal");
    expect(error.message).toContain("orchestration");
    expect(error.message).toContain("pool-admission");
    expect(getFactoryApplication()).toBeNull();
    // A failed start stops what it already started, in registration order.
    expect(stops).toEqual(["gateway", "private"]);
    expect(getReadiness()).toMatchObject({ state: "degraded", reason: "factory-services-unavailable" });
  });

  test("records the named reason for each unavailable service in readiness detail", async () => {
    const root = await privateRoot();
    await start(root).catch(() => undefined);
    const detail = getReadiness().detail as { unavailable: string[] };
    expect(detail.unavailable).toContain("temporal: factory_orchestration_unavailable");
    expect(detail.unavailable).toContain("pool-admission: factory_pool_unavailable");
  });

  test("a single failing probe is enough to keep admission closed", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const error = await bootFailure(start(root, { gateway: { health: async () => false } }));
    expect(error.code).toBe("factory-services-unavailable");
    expect(error.message).toContain("execution-gateway");
    expect(getFactoryApplication()).toBeNull();
  });

  test("a configuration that does not enforce the sandbox keeps admission closed", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const controller = new AbortController();
    await expect(startFactoryRuntime(document(root), "postgres://product", dependencies(), controller.signal, bootConfig(root, { requireSandbox: false })))
      .rejects.toThrow(/required-sandbox/);
    expect(getFactoryApplication()).toBeNull();
  });
});

describe("startFactoryRuntime opens admission only after the probes pass", () => {
  test("configures the application, starts the roles, and reports ready", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const runtime = await start(root);

    expect(getFactoryApplication()).toBe(runtime.application);
    expect(runtime.application.tenantId).toBe("tenant-01");
    expect(getReadiness().state).toBe("ready");
    // Which roles run and which are held is readable from readiness itself.
    expect(getReadiness().detail).toEqual({
      factory: {
        tenantId: "tenant-01",
        running: ["compute-admission-dispatch", "compute-admission-poll", "attempt-dispatch", "run-projection"],
        held: [
          { role: "notification-inbox-delivery", workPackage: "W07/W08" },
          { role: "child-settlement", workPackage: "W06" },
          { role: "release-outcome", workPackage: "W07/W08" },
          { role: "usage-reconciliation", workPackage: "W03" },
          { role: "notification-send", workPackage: "W17" },
          { role: "stop-settlement", workPackage: "W03" },
        ],
      },
    });

    const report = runtime.report();
    expect(report.admissionOpen).toBe(true);
    expect(report.probes.every((probe) => probe.available)).toBe(true);
    expect(report.workers.map((worker) => worker.name)).toEqual([
      "compute-admission-dispatch", "compute-admission-poll", "attempt-dispatch", "run-projection",
    ]);
    expect(report.workers.every((worker) => worker.running)).toBe(true);
    expect(report.heldWorkers.map((held) => held.role)).toContain("stop-settlement");
    expect(report.seams.every((seam) => !seam.present)).toBe(true);
  });

  test("drives its registered roles against the real durable primitives", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    let dispatched = 0;
    let projected = 0;
    const runtime = await start(root, {
      workers: {
        compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
        attempts: { dispatchOne: async () => { dispatched++; return { kind: "idle" }; } },
        projections: { projectPending: async () => { projected++; return { runs: [] }; } },
      },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(dispatched).toBeGreaterThan(0);
    expect(projected).toBeGreaterThan(0);
    await runtime.stop();
  });

  test("registers the notification inbox role once its driver is supplied", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const runtime = await start(root, {
      workers: {
        compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
        attempts: { dispatchOne: async () => ({ kind: "idle" }) },
        projections: { projectPending: async () => ({ runs: [] }) },
        notificationInbox: { deliverNextAcrossProjects: async () => false },
      },
    });
    expect(runtime.report().workers.map((worker) => worker.name)).toContain("notification-inbox-delivery");
  });

  test("a supplied seam is reported as present and removes its hold", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const runtime = await start(root, { seams: { physicalStopper: { step: async () => false } } });
    expect(runtime.seams.physicalStopper.present).toBe(true);
    expect(runtime.report().heldWorkers.map((held) => held.role)).not.toContain("stop-settlement");
    // Registered and running, not merely un-held.
    expect(runtime.report().workers.map((worker) => worker.name)).toContain("stop-settlement");
    expect(runtime.workers.get("stop-settlement").state.running).toBe(true);
  });
});

describe("startFactoryRuntime shuts down in reverse", () => {
  test("closes admission, drains the roles, then stops the listeners", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const order: string[] = [];
    let inFlight = 0;
    const runtime = await start(root, {
      listeners: [listener(order, "gateway"), listener(order, "private")],
      workers: {
        compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
        attempts: {
          dispatchOne: async () => {
            inFlight++;
            await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
            inFlight--;
            order.push("attempt-step");
            return { kind: "idle" };
          },
        },
        projections: { projectPending: async () => ({ runs: [] }) },
      },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    await runtime.stop();
    // Admission closed first, so nothing new arrived while the roles drained.
    expect(getFactoryApplication()).toBeNull();
    expect(runtime.report().admissionOpen).toBe(false);
    expect(runtime.report().workers.every((worker) => !worker.running)).toBe(true);
    // No step was abandoned, and the listeners closed after the roles.
    expect(inFlight).toBe(0);
    expect(order.indexOf("gateway")).toBeGreaterThan(order.lastIndexOf("attempt-step"));
    expect(order.slice(-2)).toEqual(["gateway", "private"]);
  });

  test("stop is idempotent, so a signal and an explicit stop do not double-close", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const order: string[] = [];
    const runtime = await start(root, { listeners: [listener(order, "gateway")] });
    await runtime.stop();
    await runtime.stop();
    expect(order).toEqual(["gateway"]);
  });

  test("stops the listeners and closes admission even when a role refuses to stop", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const order: string[] = [];
    // A role whose step never settles cannot be awaited, so `stop()` rejects.
    // The listeners must still close: a shutdown that leaves a bound port
    // because one role is wedged is exactly the leak the pass sentence forbids.
    let release!: () => void;
    const wedged = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await start(root, {
      listeners: [listener(order, "gateway"), listener(order, "private")],
      workers: {
        compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
        attempts: { dispatchOne: async () => { await wedged; return { kind: "idle" }; } },
        projections: { projectPending: async () => ({ runs: [] }) },
      },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

    const stopping = runtime.stop();
    // Admission is already closed while the wedged role is still being awaited.
    expect(getFactoryApplication()).toBeNull();
    release();
    await stopping;
    expect(order).toEqual(["gateway", "private"]);
  });

  test("the shutdown signal stops the roles without an explicit stop call", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const controller = new AbortController();
    const runtime = await startFactoryRuntime(document(root), "postgres://product", dependencies(), controller.signal, bootConfig(root));
    started.push(runtime);
    expect(runtime.report().workers.every((worker) => worker.running)).toBe(true);
    controller.abort(new Error("server shutting down"));
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(runtime.report().workers.every((worker) => worker.stopping)).toBe(true);
  });
});


describe("startFactoryRuntime survives what a live deployment does to it", () => {
  test("a dependency lost after startup is reported and retried, never reported as done", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const reported: Array<{ role: string; message: string }> = [];
    let calls = 0;
    const runtime = await start(root, {
      report: (role, error) => { reported.push({ role, message: String(error) }); },
      workers: {
        compute: { dispatchNext: async () => ({ status: "idle" }), pollNext: async () => ({ status: "idle" }) },
        attempts: {
          dispatchOne: async () => {
            calls++;
            // The queue's database goes away for exactly one pass, then returns.
            if (calls === 3) throw new Error("connection terminated");
            return { kind: "idle" };
          },
        },
        projections: { projectPending: async () => ({ runs: [] }) },
      },
    }, { workers: { idleDelayMs: 10, errorDelayMs: 10, maxErrorDelayMs: 20, batch: 1 } });

    // Quiesce the role's own loop, then drive it by hand so nothing depends on
    // elapsed time. `stop()` awaits the step already in flight.
    const worker = runtime.workers.get("attempt-dispatch");
    await worker.stop();
    const before = worker.state;
    calls = 0;
    const controller = new AbortController();

    expect(await worker.runBatch(controller.signal)).toBe("idle");
    expect(await worker.runBatch(controller.signal)).toBe("idle");
    await expect(worker.runBatch(controller.signal)).rejects.toThrow("connection terminated");
    // The dependency comes back and the role picks up where it left off; the
    // failed pass was never recorded as work it did not do.
    expect(await worker.runBatch(controller.signal)).toBe("idle");
    expect(worker.state.worked).toBe(before.worked);
    expect(worker.state.idle).toBe(before.idle + 3);
    expect(reported.length).toBe(0);
    await runtime.stop();
  });

  test("a queue refusing new work backs the role off instead of spinning on it", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const reported: string[] = [];
    let attempts = 0;
    const runtime = await start(root, {
      report: (_role, error) => { reported.push(String(error)); },
      workers: {
        compute: {
          // C08's durable inbox refuses past 128 unacknowledged events. A role
          // that treated that as a transient nothing would spin a core.
          dispatchNext: async () => { attempts++; throw Object.assign(new Error("factory_inbox_full"), { code: "factory_inbox_full" }); },
          pollNext: async () => ({ status: "idle" }),
        },
        attempts: { dispatchOne: async () => ({ kind: "idle" }) },
        projections: { projectPending: async () => ({ runs: [] }) },
      },
    }, { workers: { idleDelayMs: 10, errorDelayMs: 10, maxErrorDelayMs: 20, batch: 4 } });

    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const worker = runtime.workers.get("compute-admission-dispatch");
    // Each pass costs one refusal, not `batch` of them: the pass aborts on the
    // first throw rather than hammering a queue that just said it is full.
    expect(worker.state.failures).toBe(attempts);
    expect(reported.every((message) => message.includes("factory_inbox_full"))).toBe(true);
    await runtime.stop();
  });

  test("a stopped runtime re-drives safely on the same inputs", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const first = await start(root);
    const firstApplication = first.application;
    await first.stop();
    expect(getFactoryApplication()).toBeNull();

    // A second composition over the same configuration and the same database.
    const second = await start(root);
    expect(getFactoryApplication()).toBe(second.application);
    expect(second.application).not.toBe(firstApplication);
    expect(second.report().workers.every((worker) => worker.running)).toBe(true);
    expect(second.report().probes.every((probe) => probe.available)).toBe(true);
    await second.stop();
  });

  test("a credential set that rotates is re-read, and an unreadable one fails by name", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    // The storage probe writes and reads back through the store the product
    // uses, so a rotated credential that still works passes, and a store that
    // stops answering fails without ever reporting ready.
    let live = true;
    const stored = new Map<string, Uint8Array>();
    const rotating = {
      async put(key: string, content: Uint8Array) {
        if (!live) throw Object.assign(new Error("InvalidAccessKeyId"), { code: "InvalidAccessKeyId" });
        stored.set(key, content);
      },
      async get(key: string) {
        if (!live) throw Object.assign(new Error("InvalidAccessKeyId"), { code: "InvalidAccessKeyId" });
        return stored.get(key)!;
      },
    };
    const runtime = await start(root, { storage: rotating });
    expect(runtime.report().probes.find((probe) => probe.service === "object-storage")).toMatchObject({ available: true });
    await runtime.stop();

    live = false;
    const error = await bootFailure(start(root, { storage: rotating }));
    expect(error.code).toBe("factory-services-unavailable");
    expect(error.message).toContain("object-storage");
    const detail = getReadiness().detail as { unavailable: string[] };
    expect(detail.unavailable).toContain("object-storage: InvalidAccessKeyId");
    expect(getFactoryApplication()).toBeNull();
  });

  test("an expired readiness record closes admission on the next start", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const runtime = await start(root);
    expect(runtime.report().admissionOpen).toBe(true);
    await runtime.stop();

    // The orchestration process stopped heartbeating; its record is now stale.
    const stale = {
      schemaVersion: "factory.orchestrator-readiness.v1",
      installationId: "installation-01", tenantId: "tenant-01", namespace: "tenant-01.factory", taskQueue: "factory-orchestrator",
      lifecycle: "ready", observedAtMs: Date.now() - 60_000, workerPolling: true, dispatcherLive: true, credentialGeneration: 2,
    };
    const path = join(root, "orchestration.json");
    await writeFile(path, JSON.stringify(stale), { mode: 0o600 });
    await chmod(path, 0o600);

    const error = await bootFailure(start(root));
    expect(error.code).toBe("factory-services-unavailable");
    expect(error.message).toContain("temporal");
    expect(getFactoryApplication()).toBeNull();
  });
});

describe("startFactoryRuntime validates its own inputs", () => {
  test("refuses a document whose schema version is not the one it parses", async () => {
    const root = await privateRoot();
    await expect(startFactoryRuntime(document(root, { schemaVersion: "factory.startup.v0" }), "postgres://product", dependencies(), new AbortController().signal, bootConfig(root)))
      .rejects.toBeInstanceOf(FactoryStartupConfigError);
  });

  test("adds a deployment's extra probe to the required set", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    let ran = false;
    const runtime = await start(root, {
      extraProbes: [{ service: "object-storage", probe: async () => { ran = true; } }],
    });
    expect(ran).toBe(true);
    expect(runtime.report().probes.filter((probe) => probe.service === "object-storage")).toHaveLength(2);
  });
});

/**
 * The bring-up deadlock, and the gate that does not weaken to break it.
 *
 * The Node orchestrator's readiness requires reaching this process's private
 * service; this process's readiness requires the orchestrator's record. With
 * one probe round, whichever starts second loses and the listener the other
 * needs is already closed. Re-probing with the listener bound is what lets both
 * converge — and admission stays closed for the whole window, so the gate is
 * unchanged.
 */
describe("the readiness retry converges a distributed bring-up", () => {
  const retry = { delayMs: 10, windowMs: 10_000 };

  test("keeps the listener bound and admission closed, then opens when the service arrives", async () => {
    const root = await privateRoot();
    const stops: string[] = [];
    let live = false;
    const controller = new AbortController();
    const runtime = await startFactoryRuntime(document(root, { readinessRetry: retry }), "postgres://product", dependencies({
      listeners: [listener(stops, "private-service")],
      // Stands in for the orchestration and pool records: absent on the first
      // round, present once the peer has had a chance to start.
      gateway: { health: async () => { if (!live) throw new Error("not listening yet"); return true; } },
      readinessRetry: retry,
      wait: async () => { await writeReadyRecords(root); live = true; },
    }), controller.signal, bootConfig(root));
    started.push(runtime);

    // Admission is closed on return and the listener is still bound: a peer
    // that needs to reach this process still can.
    expect(runtime.report().admissionOpen).toBe(false);
    expect(getFactoryApplication()).toBeNull();
    expect(stops).toEqual([]);
    expect(getReadiness().state).toBe("degraded");

    await runtime.converged;

    expect(runtime.report().admissionOpen).toBe(true);
    expect(getFactoryApplication()).toBe(runtime.application);
    expect(getReadiness().state).toBe("ready");
    expect(stops).toEqual([]);
  });

  test("gives up at the end of the window, stops what it started, and stays degraded", async () => {
    const root = await privateRoot();
    const stops: string[] = [];
    let rounds = 0;
    const controller = new AbortController();
    const runtime = await startFactoryRuntime(document(root, { readinessRetry: { delayMs: 10, windowMs: 30 } }), "postgres://product", dependencies({
      listeners: [listener(stops, "private-service")],
      gateway: { health: async () => { throw new Error("never arrives"); } },
      readinessRetry: { delayMs: 10, windowMs: 30 },
      // Three whole delays, counted; nothing here reads a clock.
      wait: async () => { rounds += 1; },
    }), controller.signal, bootConfig(root));
    started.push(runtime);
    await runtime.converged;
    expect(rounds).toBe(3);

    expect(runtime.report().admissionOpen).toBe(false);
    expect(stops).toEqual(["private-service"]);
    expect(getReadiness().state).toBe("degraded");
    expect(getReadiness().reason).toBe("factory-services-unavailable");
  });

  test("a configuration fault is never retried, because no wait fixes it", async () => {
    const root = await privateRoot();
    await writeReadyRecords(root);
    const stops: string[] = [];
    let waits = 0;
    const error = await bootFailure(startFactoryRuntime(document(root, { readinessRetry: retry }), undefined, dependencies({
      listeners: [listener(stops, "private-service")],
      readinessRetry: retry,
      wait: async () => { waits += 1; },
    }), new AbortController().signal, bootConfig(root)));

    // PGlite is not a service that arrives; it is a deployment an operator has
    // to change, and waiting on it would be waiting on nobody.
    expect(error.code).toBe("factory-pglite-unsupported");
    expect(waits).toBe(0);
    expect(stops).toEqual(["private-service"]);
  });

  test("a stop during the window ends it rather than waiting it out", async () => {
    const root = await privateRoot();
    const stops: string[] = [];
    const controller = new AbortController();
    const runtime = await startFactoryRuntime(document(root, { readinessRetry: retry }), "postgres://product", dependencies({
      listeners: [listener(stops, "private-service")],
      gateway: { health: async () => { throw new Error("not listening yet"); } },
      readinessRetry: retry,
      wait: async (_ms, signal) => { controller.abort(); expect(signal).toBeDefined(); },
    }), controller.signal, bootConfig(root));
    started.push(runtime);
    await runtime.converged;
    expect(runtime.report().admissionOpen).toBe(false);
    expect(stops).toEqual(["private-service"]);
  });

  test("without a retry the first round is the verdict, exactly as before", async () => {
    const root = await privateRoot();
    const stops: string[] = [];
    const error = await bootFailure(startFactoryRuntime(document(root), "postgres://product", dependencies({
      listeners: [listener(stops, "private-service")],
      gateway: { health: async () => { throw new Error("not listening yet"); } },
    }), new AbortController().signal, bootConfig(root)));
    expect(error.code).toBe("factory-services-unavailable");
    expect(stops).toEqual(["private-service"]);
  });
});
