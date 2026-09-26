import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FACTORY_REQUIRED_SERVICES } from "./boot";
import { createFactoryPoolReadinessWriter } from "./pool/readiness";
import { createFactoryServiceReadinessWriter, factorySupervisorReadinessOptions } from "./service-readiness";
import {
  availableFactoryServices,
  factoryGatewayProbe,
  factoryOrchestrationProbes,
  factoryPoolProbe,
  factoryProbeDetail,
  factorySandboxProbe,
  factoryStorageProbe,
  factorySupervisorProbe,
  factorySupervisorReadinessProbe,
  FactoryServiceProbeError,
  probeFactoryServices,
  unavailableFactoryServices,
  type FactoryProbeIdentity,
  type FactoryProbeTraceEvent,
  type FactoryServiceProbe,
} from "./service-probes";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-probes-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function identity(root: string): FactoryProbeIdentity {
  return {
    installationId: "installation-01",
    tenantId: "tenant-01",
    poolId: "pool-01",
    temporalNamespace: "tenant-01.factory",
    orchestrationReadinessFilePath: join(root, "orchestration.json"),
    poolReadinessFilePath: join(root, "pool.json"),
    supervisorReadinessFilePath: join(root, "supervisor.json"),
    hostId: "host-01",
    readinessHeartbeatMs: 5_000,
  };
}

async function writeOrchestrationReadiness(path: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const state = {
    schemaVersion: "factory.orchestrator-readiness.v1",
    installationId: "installation-01",
    tenantId: "tenant-01",
    namespace: "tenant-01.factory",
    taskQueue: "factory-orchestrator",
    lifecycle: "ready",
    observedAtMs: Date.now(),
    workerPolling: true,
    dispatcherLive: true,
    credentialGeneration: 1,
    ...overrides,
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await chmod(path, 0o600);
}

function memoryStore(): { put(key: string, content: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array>; readonly written: Map<string, Uint8Array> } {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    async put(key, content) { written.set(key, content); },
    async get(key) {
      const value = written.get(key);
      if (!value) throw new FactoryServiceProbeError("object_missing");
      return value;
    },
  };
}

const open = new AbortController().signal;

describe("probeFactoryServices", () => {
  test("runs every probe and reports each verdict, so one failure hides no other", async () => {
    const probes: FactoryServiceProbe[] = [
      { service: "temporal", probe: async () => {} },
      { service: "object-storage", probe: async () => { throw new FactoryServiceProbeError("object_storage_down"); } },
      { service: "pool-admission", probe: async () => { throw new FactoryServiceProbeError("pool_down"); } },
    ];
    const results = await probeFactoryServices(probes, open);
    expect(results).toEqual([
      { service: "temporal", available: true, detail: "ready" },
      { service: "object-storage", available: false, detail: "object_storage_down" },
      { service: "pool-admission", available: false, detail: "pool_down" },
    ]);
    expect(availableFactoryServices(results)).toEqual(["temporal"]);
    expect(unavailableFactoryServices(results)).toEqual(["object-storage: object_storage_down", "pool-admission: pool_down"]);
  });

  test("a probe that never answers is reported by name at its own deadline, its signal is aborted, and the rest still run", async () => {
    let seen: AbortSignal | undefined;
    const events: FactoryProbeTraceEvent[] = [];
    const results = await probeFactoryServices([
      // Ignores its signal entirely: only the deadline race can end it.
      { service: "object-storage", probe: (signal) => { seen = signal; return new Promise<void>(() => {}); } },
      { service: "temporal", probe: async () => {} },
    ], open, { deadlineMs: 50, trace: (event) => events.push(event) });
    expect(results).toEqual([
      { service: "object-storage", available: false, detail: "object_storage_probe_timeout" },
      { service: "temporal", available: true, detail: "ready" },
    ]);
    expect(seen?.aborted).toBe(true);
    expect(events.map(({ service, available, detail }) => ({ service, available, detail }))).toEqual(results as never);
    expect(events.every((event) => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0)).toBe(true);
  });

  test("a probe that honours its signal is aborted with the named timeout", async () => {
    const results = await probeFactoryServices([{
      service: "pool-admission",
      probe: (signal) => new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }),
    }], open, { deadlineMs: 50 });
    expect(results).toEqual([{ service: "pool-admission", available: false, detail: "pool_admission_probe_timeout" }]);
  });

  test("the storage probe hands its signal to the store, so a hanging request is aborted at the deadline", async () => {
    const aborted: string[] = [];
    const hanging = {
      put: (_key: string, _content: Uint8Array, signal?: AbortSignal) => new Promise<unknown>((_, reject) => {
        signal!.addEventListener("abort", () => { aborted.push("put"); reject(signal!.reason); }, { once: true });
      }),
      get: async () => new Uint8Array(),
    };
    const results = await probeFactoryServices([factoryStorageProbe(hanging, "factory/readiness/installation-01")], open, { deadlineMs: 50 });
    expect(results).toEqual([{ service: "object-storage", available: false, detail: "object_storage_probe_timeout" }]);
    expect(aborted).toEqual(["put"]);
  });

  test("reports an aborted run as unavailable rather than as ready", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    const results = await probeFactoryServices([{ service: "temporal", probe: async () => { ran = true; } }], controller.signal);
    expect(ran).toBe(false);
    expect(results).toEqual([{ service: "temporal", available: false, detail: "probe_aborted" }]);
    expect(availableFactoryServices(results)).toEqual([]);
  });

  test("returns the available set in the required-service order", async () => {
    const probes = [...FACTORY_REQUIRED_SERVICES].reverse().map((service) => ({ service, probe: async () => {} }));
    const results = await probeFactoryServices(probes, open);
    expect(availableFactoryServices(results)).toEqual([...FACTORY_REQUIRED_SERVICES]);
    expect(unavailableFactoryServices(results)).toEqual([]);
  });
});

describe("factoryProbeDetail", () => {
  test("prefers a typed code, then a carried code, then the error name", () => {
    expect(factoryProbeDetail(new FactoryServiceProbeError("typed_code"))).toBe("typed_code");
    const carried = Object.assign(new Error("boom"), { code: "ENOENT" });
    expect(factoryProbeDetail(carried)).toBe("ENOENT");
    const named = new Error("boom");
    named.name = "TimeoutError";
    expect(factoryProbeDetail(named)).toBe("TimeoutError");
    const anonymous = new Error("boom");
    anonymous.name = "";
    expect(factoryProbeDetail(anonymous)).toBe("probe_failed");
    expect(factoryProbeDetail("a string")).toBe("probe_failed");
    expect(factoryProbeDetail(Object.assign(new Error("boom"), { code: "" }))).toBe("Error");
  });

  test("carries no message text, so a probe cannot leak a credential into readiness", async () => {
    const secretish = new Error("connect failed for https://user:swordfish@store.example/bucket");
    const results = await probeFactoryServices([{ service: "object-storage", probe: async () => { throw secretish; } }], open);
    expect(results[0]!.detail).toBe("Error");
    expect(JSON.stringify(results)).not.toContain("swordfish");
  });
});

describe("the orchestration and pool probes read live readiness", () => {
  test("both orchestration services pass on a fresh ready record", async () => {
    const root = await privateRoot();
    const probes = factoryOrchestrationProbes(identity(root));
    await writeOrchestrationReadiness(identity(root).orchestrationReadinessFilePath);
    expect(probes.map((probe) => probe.service)).toEqual(["orchestration", "temporal"]);
    const results = await probeFactoryServices(probes, open);
    expect(results.every((result) => result.available)).toBe(true);
  });

  test("a stale, foreign, or not-yet-ready record fails both by name", async () => {
    const root = await privateRoot();
    const scope = identity(root);
    for (const overrides of [
      { observedAtMs: Date.now() - 60_000 },
      { namespace: "other-tenant.factory" },
      { lifecycle: "starting" },
      { workerPolling: false },
    ]) {
      await writeOrchestrationReadiness(scope.orchestrationReadinessFilePath, overrides);
      const results = await probeFactoryServices(factoryOrchestrationProbes(scope), open);
      expect(results.map((result) => result.detail)).toEqual(["factory_orchestration_unavailable", "factory_orchestration_unavailable"]);
    }
  });

  test("a missing record fails rather than defaulting to ready", async () => {
    const root = await privateRoot();
    const results = await probeFactoryServices(factoryOrchestrationProbes(identity(root)), open);
    expect(results.every((result) => !result.available)).toBe(true);
  });

  test("omitting the heartbeat still probes, using the reader's own default", async () => {
    const root = await privateRoot();
    const scope = { ...identity(root), readinessHeartbeatMs: undefined };
    await writeOrchestrationReadiness(scope.orchestrationReadinessFilePath);
    const results = await probeFactoryServices([...factoryOrchestrationProbes(scope), factoryPoolProbe(scope)], open);
    expect(results[0]!.available).toBe(true);
    expect(results[2]!.available).toBe(false);
  });

  test("the pool probe passes on a fresh ready record and fails closed on a foreign pool", async () => {
    const root = await privateRoot();
    const scope = identity(root);
    const writer = createFactoryPoolReadinessWriter({ poolId: scope.poolId, readinessFilePath: scope.poolReadinessFilePath, readinessHeartbeatMs: 5_000 });
    await writer.write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
    expect((await probeFactoryServices([factoryPoolProbe(scope)], open))[0]).toMatchObject({ available: true });

    const foreign = await probeFactoryServices([factoryPoolProbe({ ...scope, poolId: "pool-02" })], open);
    expect(foreign[0]).toEqual({ service: "pool-admission", available: false, detail: "factory_pool_unavailable" });
  });
});

describe("a pool and a supervisor shared by two installations (C12, coordinator ruling 2026-09-22)", () => {
  const facts = { hostKeyReady: true, runnerReady: true, hostServicesReady: true };

  async function sharedHost(root: string) {
    const pool = createFactoryPoolReadinessWriter({ poolId: "pool.host-a", readinessFilePath: join(root, "pool.json"), readinessHeartbeatMs: 5_000 });
    await pool.write({ lifecycle: "ready", databaseReady: true, schemaReady: true, listenerReady: true });
    const supervisor = createFactoryServiceReadinessWriter(factorySupervisorReadinessOptions({ hostId: "host-a", readinessFilePath: join(root, "supervisor.json"), readinessHeartbeatMs: 5_000 }));
    return supervisor.write({ lifecycle: "ready", facts });
  }
  const installation = (root: string, installationId: string, tenantId: string): FactoryProbeIdentity => ({ ...identity(root), installationId, tenantId, poolId: "pool.host-a", hostId: "host-a" });

  test("both installations reach ready on one pool record and one supervisor record, which name no installation", async () => {
    const root = await privateRoot();
    const record = await sharedHost(root);
    expect(record).toEqual({ schemaVersion: "factory.supervisor-readiness.v1", service: "host-supervisor", instanceId: "host-a", lifecycle: "ready", observedAtMs: record.observedAtMs, facts });
    for (const scope of [installation(root, "installation-01", "tenant-01"), installation(root, "installation-02", "tenant-02")]) {
      expect(await probeFactoryServices([factoryPoolProbe(scope), factorySupervisorReadinessProbe(scope)], open)).toEqual([
        { service: "pool-admission", available: true, detail: "ready" },
        { service: "host-supervisor", available: true, detail: "ready" },
      ]);
    }
  });

  test("an installation that names another pool or another host is refused, indistinguishably from a pool or host that is down", async () => {
    const root = await privateRoot();
    await sharedHost(root);
    const misrouted = { ...installation(root, "installation-03", "tenant-03"), poolId: "pool.host-b", hostId: "host-b" };
    expect(await probeFactoryServices([factoryPoolProbe(misrouted), factorySupervisorReadinessProbe(misrouted)], open)).toEqual([
      { service: "pool-admission", available: false, detail: "factory_pool_unavailable" },
      { service: "host-supervisor", available: false, detail: "host-supervisor" },
    ]);
  });
});

describe("the storage, gateway, supervisor, and sandbox probes", () => {
  test("object storage passes only when the bytes read back equal the bytes written", async () => {
    const store = memoryStore();
    const passing = await probeFactoryServices([factoryStorageProbe(store, "factory/readiness/installation-01")], open);
    expect(passing[0]).toMatchObject({ service: "object-storage", available: true });
    expect(store.written.has("factory/readiness/installation-01")).toBe(true);

    const silentlyDropping = { put: async () => {}, get: async () => new TextEncoder().encode("something else") };
    const dropped = await probeFactoryServices([factoryStorageProbe(silentlyDropping, "k")], open);
    expect(dropped[0]).toEqual({ service: "object-storage", available: false, detail: "object_storage_roundtrip_mismatch" });

    const truncating = { put: async () => {}, get: async () => new Uint8Array(2) };
    expect((await probeFactoryServices([factoryStorageProbe(truncating, "k")], open))[0]!.detail).toBe("object_storage_roundtrip_mismatch");

    const unreachable = { put: async () => { throw new FactoryServiceProbeError("connection_refused"); }, get: async () => new Uint8Array() };
    expect((await probeFactoryServices([factoryStorageProbe(unreachable, "k")], open))[0]!.detail).toBe("connection_refused");
  });

  test("the gateway probe fails on an unhealthy answer as well as on a thrown one", async () => {
    expect((await probeFactoryServices([factoryGatewayProbe({ health: async () => true })], open))[0]).toMatchObject({ available: true });
    expect((await probeFactoryServices([factoryGatewayProbe({ health: async () => false })], open))[0])
      .toEqual({ service: "execution-gateway", available: false, detail: "execution_gateway_unhealthy" });
    expect((await probeFactoryServices([factoryGatewayProbe({ health: async () => { throw new FactoryServiceProbeError("tls_handshake_failed"); } })], open))[0]!.detail)
      .toBe("tls_handshake_failed");
  });

  test("the gateway probe passes the caller's deadline through", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    await probeFactoryServices([factoryGatewayProbe({ health: async (signal) => { observed = signal; return true; } })], controller.signal);
    // The probe runs under the caller's signal combined with its own deadline: aborting the caller aborts it.
    const signal = observed as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort(new Error("caller deadline"));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("caller deadline");
  });

  test("the supervisor probe reports its preflight verdict", async () => {
    expect((await probeFactoryServices([factorySupervisorProbe({ preflight: async () => {} })], open))[0]).toMatchObject({ service: "host-supervisor", available: true });
    expect((await probeFactoryServices([factorySupervisorProbe({ preflight: async () => { throw new FactoryServiceProbeError("runner_unavailable"); } })], open))[0]!.detail)
      .toBe("runner_unavailable");
  });

  test("the sandbox probe refuses a configuration that does not enforce the sandbox", async () => {
    expect((await probeFactoryServices([factorySandboxProbe({ requireSandbox: true })], open))[0]).toMatchObject({ available: true });
    for (const requireSandbox of [false, undefined]) {
      expect((await probeFactoryServices([factorySandboxProbe({ requireSandbox })], open))[0])
        .toEqual({ service: "required-sandbox", available: false, detail: "required_sandbox_not_enforced" });
    }
  });
});
