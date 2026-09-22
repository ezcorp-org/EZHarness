import { afterEach, describe, expect, test } from "bun:test";
import type { RunnerInspection, WorkspaceFiles } from "@ezcorp/extension-contract";
import { certificates } from "../../__tests__/helpers/factory-certificates";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFactoryServiceReadiness, factorySupervisorReadinessOptions } from "../service-readiness";
import {
  loadFactoryHostKey,
  factorySupervisorRecord,
  FACTORY_SUPERVISOR_FACT_STALENESS_HEARTBEATS,
  FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS,
  parseFactorySupervisorProcessConfig,
  factoryHostRunnerProbe,
  runConfiguredFactorySupervisor,
  startFactoryConfiguredHostServices,
  runFactorySupervisorMain,
  startFactorySupervisorMain,
  factorySupervisorProductionDependencies,
  productionMainDependencies,
  type FactorySupervisorProcessConfig,
  type FactorySupervisorProcessDependencies,
} from "./supervisor-process";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-supervisor-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

function config(root: string, overrides: Partial<FactorySupervisorProcessConfig> = {}): Record<string, unknown> {
  return {
    schemaVersion: "factory.supervisor-process.v1",
    installationId: "installation-01",
    hostId: "host-01",
    hostKeyPath: join(root, "host.key"),
    hostKeyId: "host-key-1",
    runnerRoot: join(root, "runner"),
    readinessFilePath: join(root, "supervisor.json"),
    readinessHeartbeatMs: 1_000,
    ...overrides,
  };
}

function configFor(runnerRoot: string): Record<string, unknown> {
  return {
    schemaVersion: "factory.supervisor-process.v1", installationId: "installation-01", hostId: "host-01",
    hostKeyPath: "/run/secrets/host.key", hostKeyId: "host-key-1", runnerRoot,
    readinessFilePath: "/run/factory/supervisor.json", readinessHeartbeatMs: HEARTBEAT_MS,
  };
}

async function writeConfig(root: string, overrides: Partial<FactorySupervisorProcessConfig> = {}): Promise<string> {
  const path = join(root, "supervisor-config.json");
  await writeFile(path, JSON.stringify(config(root, overrides)), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function writeHostKey(root: string): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const path = join(root, "host.key");
  await writeFile(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(path, 0o600);
}

let abortController: AbortController | undefined;
const certificateRoots: string[] = [];

const HEARTBEAT_MS = 1_000;

/**
 * Drives both loops without a real timer.
 *
 * The two loops are told apart by the interval they ask for: the cadence wait
 * is one heartbeat, and the probe bound is four. The fixture counts cadence
 * waits and stops after a bounded number, and leaves the bound pending so the
 * probe wins its race unless a test says otherwise. Nothing asserts on elapsed
 * time; `now` is a value the test moves by hand.
 *
 * The cadence wait yields a MACROTASK rather than resolving inline. A wait that
 * resolves on the microtask queue starves the other loop's file I/O: the
 * publish loop spins write-wait-write forever and the observation never lands,
 * which is a property of the fake and not of the code under test. A real timer
 * yields, so the fake yields too.
 */
function dependencies(overrides: Partial<FactorySupervisorProcessDependencies> = {}, cadenceWaitsBeforeStop = 4): FactorySupervisorProcessDependencies {
  let cadence = 0;
  return {
    loadHostKey: loadFactoryHostKey,
    createRunnerProbe: () => ({ probe: async () => {}, instance: () => undefined, close: async () => {} }),
    createReadiness: factorySupervisorProductionDependencies.createReadiness,
    startServices: async () => ({ stop: () => {} }),
    now: () => 1_000_000,
    wait: async (milliseconds, waitSignal) => {
      if (milliseconds !== HEARTBEAT_MS) {
        // The probe bound. Pending until the observation ends, so a probe that
        // returns always beats it.
        return new Promise<void>((resolve) => {
          if (waitSignal.aborted) return resolve();
          waitSignal.addEventListener("abort", () => { resolve(); }, { once: true });
        });
      }
      cadence += 1;
      if (cadence >= cadenceWaitsBeforeStop) abortController?.abort();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    },
    ...overrides,
  };
}

describe("parseFactorySupervisorProcessConfig", () => {
  test("accepts a complete document and refuses every incomplete one", async () => {
    const root = await privateRoot();
    expect(parseFactorySupervisorProcessConfig(config(root)).hostId).toBe("host-01");
    expect(parseFactorySupervisorProcessConfig({ ...config(root), readinessHeartbeatMs: undefined as never })).toBeDefined();

    for (const bad of [
      null, "text", [],
      { ...config(root), schemaVersion: "factory.supervisor-process.v2" },
      { ...config(root), installationId: "" },
      { ...config(root), hostId: "with\0null" },
      { ...config(root), hostKeyPath: "" },
      { ...config(root), hostKeyId: "" },
      { ...config(root), runnerRoot: "" },
      { ...config(root), readinessFilePath: "" },
      { ...config(root), readinessHeartbeatMs: 999 },
      { ...config(root), surprise: 1 },
    ]) {
      expect(() => parseFactorySupervisorProcessConfig(bad)).toThrow("factory supervisor config is invalid");
    }
    const missing = { ...config(root) } as Record<string, unknown>;
    delete missing.hostKeyId;
    expect(() => parseFactorySupervisorProcessConfig(missing)).toThrow("factory supervisor config is invalid");
  });
});

describe("loadFactoryHostKey", () => {
  test("proves the key loads and refuses bytes that are not a key", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    await expect(loadFactoryHostKey(join(root, "host.key"))).resolves.toBeUndefined();

    const wrong = join(root, "not-a-key");
    await writeFile(wrong, "not a key", { mode: 0o600 });
    await chmod(wrong, 0o600);
    await expect(loadFactoryHostKey(wrong)).rejects.toBeDefined();
    await expect(loadFactoryHostKey(join(root, "absent.key"))).rejects.toBeDefined();
  });
});

describe("factorySupervisorRecord", () => {
  const facts = { hostKeyReady: true, runnerReady: true, hostServicesReady: false };
  const none = { hostKeyReady: false, runnerReady: false, hostServicesReady: false };
  // A host that publishes no launch or stop service; the services cases below
  // set `servicesConfigured` themselves.
  const unpublished = { hostServicesReady: false, servicesConfigured: false };

  test("starting means it has not looked yet, and never carries a reason", () => {
    // A reader must be able to tell a supervisor that has not looked from one
    // that looked and did not like what it saw.
    expect(factorySupervisorRecord({ attempted: false, ...none, ...unpublished, observedAtMs: 0 }, 1_000, 500))
      .toEqual({ lifecycle: "starting", facts: none });
  });

  test("publishes ready only for a fresh observation of both facts", () => {
    expect(factorySupervisorRecord({ attempted: true, ...facts, ...unpublished, observedAtMs: 900 }, 1_000, 500)).toEqual({ lifecycle: "ready", facts });
    // Exactly at the bound is still current; one past it is not.
    expect(factorySupervisorRecord({ attempted: true, ...facts, ...unpublished, observedAtMs: 500 }, 1_000, 500)).toEqual({ lifecycle: "ready", facts });
    expect(factorySupervisorRecord({ attempted: true, ...facts, ...unpublished, observedAtMs: 499 }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts, errorCode: "observation_stale" });
  });

  test("never asserts a fact nobody is still checking", () => {
    const aged = factorySupervisorRecord({ attempted: true, ...facts, ...unpublished, observedAtMs: 1 }, 1_000_000, 500);
    expect(aged).toEqual({ lifecycle: "degraded", facts, errorCode: "observation_stale" });
  });

  test("a failed observation names the failing fact", () => {
    expect(factorySupervisorRecord({ attempted: true, hostKeyReady: true, runnerReady: false, ...unpublished, observedAtMs: 0, errorCode: "runner_unavailable" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: { hostKeyReady: true, runnerReady: false, hostServicesReady: false }, errorCode: "runner_unavailable" });
    expect(factorySupervisorRecord({ attempted: true, ...none, ...unpublished, observedAtMs: 0, errorCode: "host_key_unavailable" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: none, errorCode: "host_key_unavailable" });
    expect(factorySupervisorRecord({ attempted: true, hostKeyReady: true, runnerReady: false, ...unpublished, observedAtMs: 0, errorCode: "runner_probe_timeout" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: { hostKeyReady: true, runnerReady: false, hostServicesReady: false }, errorCode: "runner_probe_timeout" });
  });

  test("the cadence ratios leave the reader two missed writes of margin", () => {
    // The reader accepts within heartbeat * 3 and the publisher writes every
    // heartbeat, so the probe bound may exceed a write interval without ever
    // making a record arrive stale.
    expect(FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS).toBeGreaterThan(3);
    expect(FACTORY_SUPERVISOR_FACT_STALENESS_HEARTBEATS).toBeGreaterThan(FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS);
  });
});

describe("runConfiguredFactorySupervisor", () => {
  test("a probe slower than the write interval does not delay the heartbeat", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();

    // The defect this replaces: the probe was awaited BETWEEN writes, so the
    // write interval was probeLatency + heartbeat against a reader window of
    // heartbeat * 3. A probe that never returns within the cycle made every
    // record arrive already stale, intermittently, depending on host load.
    const writes: string[] = [];
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), instance: () => undefined, close: async () => {} }),
      createReadiness: () => ({ write: async (update) => { writes.push(update.lifecycle); return { ...update } as never; } }),
    }, 4));

    // Written on its own cadence while the probe never returned once.
    expect(writes.filter((lifecycle) => lifecycle !== "stopped").length).toBeGreaterThanOrEqual(2);
    expect(writes.at(-1)).toBe("stopped");
  });

  test("publishes ready once both facts are observed, and a reader accepts it", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const scope = factorySupervisorReadinessOptions({ installationId: "installation-01", hostId: "host-01", readinessFilePath: join(root, "supervisor.json"), readinessHeartbeatMs: 1_000 });

    let observed: unknown;
    let probes = 0;
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => { probes += 1; }, instance: () => undefined, close: async () => {} }),
      wait: async () => {
        // Both loops share this; read after the publish loop has written once.
        try { observed = await readFactoryServiceReadiness(scope); } catch { /* not ready yet */ }
        if (observed) abortController!.abort();
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      },
    }));
    expect(probes).toBeGreaterThan(0);
    expect(observed).toMatchObject({ service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } });
  });

  test("bounds the probe and names a timeout as its own failure", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const published: string[] = [];
    const asked: number[] = [];
    let cadence = 0;

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), instance: () => undefined, close: async () => {} }),
      wait: async (milliseconds) => {
        asked.push(milliseconds);
        // The bound elapses here, which is what proves the probe is raced
        // against it rather than awaited.
        if (milliseconds !== HEARTBEAT_MS) return;
        cadence += 1;
        if (cadence >= 4) abortController!.abort();
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      },
      createReadiness: () => ({ write: async (update) => { published.push(`${update.lifecycle}:${update.errorCode ?? ""}`); return { ...update } as never; } }),
    }));
    expect(asked).toContain(HEARTBEAT_MS * FACTORY_SUPERVISOR_PROBE_TIMEOUT_HEARTBEATS);
    expect(published.some((entry) => entry.includes("runner_probe_timeout"))).toBe(true);
  });

  test("a wait that ends because the process is stopping is not a timed-out probe", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const published: string[] = [];

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), instance: () => undefined, close: async () => {} }),
      wait: async () => { abortController!.abort(); await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); },
      createReadiness: () => ({ write: async (update) => { published.push(`${update.lifecycle}:${update.errorCode ?? ""}`); return { ...update } as never; } }),
    }));
    expect(published.some((entry) => entry.includes("runner_probe_timeout"))).toBe(false);
    expect(published.at(-1)).toBe("stopped:");
  });

  test("names which fact failed rather than simply not publishing", async () => {
    const root = await privateRoot();
    const path = await writeConfig(root);
    const published: string[] = [];
    const record = () => ({ write: async (update: { lifecycle: string; errorCode?: string }) => { published.push(`${update.lifecycle}:${update.errorCode ?? ""}`); return { ...update } as never; } });

    // No host key on disk: the first fact fails.
    abortController = new AbortController();
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({ createReadiness: record }, 6));
    expect(published.some((entry) => entry === "degraded:host_key_unavailable")).toBe(true);

    published.length = 0;
    abortController = new AbortController();
    await writeHostKey(root);
    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => { throw new Error("podman is not answering"); }, instance: () => undefined, close: async () => {} }),
      createReadiness: record,
    }, 6));
    expect(published.some((entry) => entry === "degraded:runner_unavailable")).toBe(true);
  });

  test("takes no observation at all when the signal has already aborted, and still records why", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    const controller = new AbortController();
    controller.abort();
    let probed = 0;
    let closed = 0;
    await runConfiguredFactorySupervisor(path, controller.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => { probed += 1; }, instance: () => undefined, close: async () => { closed += 1; } }),
    }));
    expect(probed).toBe(0);
    // The run still closes what it built, so an immediate abort leaves no
    // store lease behind either.
    expect(closed).toBe(1);
    expect(JSON.parse(await Bun.file(join(root, "supervisor.json")).text())).toMatchObject({ lifecycle: "stopped" });
  });

  test("refuses a config path that is not a readable document", async () => {
    const root = await privateRoot();
    const path = join(root, "bad.json");
    await writeFile(path, "{not json", { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(runConfiguredFactorySupervisor(path, new AbortController().signal, dependencies())).rejects.toThrow("factory supervisor config is invalid");
    await expect(runConfiguredFactorySupervisor(join(root, "absent.json"), new AbortController().signal, dependencies())).rejects.toBeDefined();
  });
});

describe("factoryHostRunnerProbe", () => {
  test("builds the runner ONCE and probes it repeatedly", async () => {
    const constructed: string[] = [];
    let initialized = 0;
    class Runner {
      constructor(readonly options: { root: string }) { constructed.push(options.root); }
      // The host services share this one instance, so the fake carries the
      // whole container surface even where a test only drives `initialize`.
      async build(): Promise<never> { throw new Error("the probe must not build"); }
      async start(): Promise<never> { throw new Error("the probe must not start a guest"); }
      async cancel(): Promise<void> {}
      async inspect(id: string): Promise<RunnerInspection> { return { id, state: "unknown", diagnostics: [] }; }
      async collectArtifacts(): Promise<WorkspaceFiles> { return {}; }
      async initialize(): Promise<void> { initialized += 1; }
      async close(): Promise<void> {}
    }
    const probe = factoryHostRunnerProbe(async () => Runner);
    const config = parseFactorySupervisorProcessConfig(configFor("/tmp/w09-runner-root"));

    await probe.probe(config);
    await probe.probe(config);
    await probe.probe(config);

    // The defect this replaces: a runner per call. PodmanRunner's store lease is
    // an exclusive flock child held for the instance's life, so the second
    // instance on the same root fails runner_store_busy and every successful
    // one leaks a child.
    expect(constructed).toEqual(["/tmp/w09-runner-root"]);
    expect(initialized).toBe(3);
  });

  test("closes the instance it built, and builds a fresh one afterwards", async () => {
    let closed = 0;
    const constructed: string[] = [];
    class Runner {
      constructor(readonly options: { root: string }) { constructed.push(options.root); }
      // The host services share this one instance, so the fake carries the
      // whole container surface even where a test only drives `initialize`.
      async build(): Promise<never> { throw new Error("the probe must not build"); }
      async start(): Promise<never> { throw new Error("the probe must not start a guest"); }
      async cancel(): Promise<void> {}
      async inspect(id: string): Promise<RunnerInspection> { return { id, state: "unknown", diagnostics: [] }; }
      async collectArtifacts(): Promise<WorkspaceFiles> { return {}; }
      async initialize(): Promise<void> {}
      async close(): Promise<void> { closed += 1; }
    }
    const probe = factoryHostRunnerProbe(async () => Runner);
    const config = parseFactorySupervisorProcessConfig(configFor("/tmp/w09-runner-root"));

    await probe.probe(config);
    await probe.close();
    expect(closed).toBe(1);
    // Closing twice must not close a runner that is no longer held.
    await probe.close();
    expect(closed).toBe(1);

    await probe.probe(config);
    expect(constructed).toHaveLength(2);
  });

  test("closing before any probe is safe", async () => {
    // The supervisor closes the probe in its run's `finally`, which is reached
    // even when the run fails before the first heartbeat. That close must not
    // construct the very runner the failed start was avoiding.
    let loaded = 0;
    const probe = factoryHostRunnerProbe(async () => { loaded += 1; throw new Error("the loader must not be reached"); });
    await expect(probe.close()).resolves.toBeUndefined();
    expect(loaded).toBe(0);
  });

  test("a failed initialize propagates, and the next probe retries the same instance", async () => {
    let attempts = 0;
    const constructed: string[] = [];
    class Runner {
      constructor(readonly options: { root: string }) { constructed.push(options.root); }
      // The host services share this one instance, so the fake carries the
      // whole container surface even where a test only drives `initialize`.
      async build(): Promise<never> { throw new Error("the probe must not build"); }
      async start(): Promise<never> { throw new Error("the probe must not start a guest"); }
      async cancel(): Promise<void> {}
      async inspect(id: string): Promise<RunnerInspection> { return { id, state: "unknown", diagnostics: [] }; }
      async collectArtifacts(): Promise<WorkspaceFiles> { return {}; }
      async initialize(): Promise<void> { attempts += 1; if (attempts === 1) throw new Error("isolation_unavailable"); }
      async close(): Promise<void> {}
    }
    const probe = factoryHostRunnerProbe(async () => Runner);
    const config = parseFactorySupervisorProcessConfig(configFor("/tmp/w09-runner-root"));

    await expect(probe.probe(config)).rejects.toThrow("isolation_unavailable");
    // The runner clears its own memo on failure, so the retry is a real retry
    // against the instance that already holds the store lease.
    await probe.probe(config);
    expect(constructed).toHaveLength(1);
    expect(attempts).toBe(2);
  });
});

describe("runFactorySupervisorMain", () => {
  test("wires both stop signals and removes them again", async () => {
    const once: string[] = [];
    const removed: string[] = [];
    let observed: AbortSignal | undefined;
    await runFactorySupervisorMain(["bun", "supervisor-process.ts", "/run/config.json"], {
      runConfigured: async (path, signal) => { expect(path).toBe("/run/config.json"); observed = signal; },
      once: (event) => { once.push(event); },
      removeListener: (event) => { removed.push(event); },
      fail: () => { throw new Error("must not fail"); },
    });
    expect(once).toEqual(["SIGINT", "SIGTERM"]);
    expect(removed).toEqual(["SIGINT", "SIGTERM"]);
    expect(observed?.aborted).toBe(false);
  });

  test("a stop signal aborts the run", async () => {
    const listeners: Array<() => void> = [];
    let aborted = false;
    await runFactorySupervisorMain(["bun", "supervisor-process.ts", "/run/config.json"], {
      runConfigured: async (_path, signal) => {
        signal.addEventListener("abort", () => { aborted = true; });
        for (const listener of listeners) listener();
      },
      once: (_event, listener) => { listeners.push(listener); },
      removeListener: () => {},
      fail: () => {},
    });
    expect(aborted).toBe(true);
  });

  test("requires exactly one config path", async () => {
    const unused = { runConfigured: async () => {}, once: () => {}, removeListener: () => {}, fail: () => {} };
    await expect(runFactorySupervisorMain(["bun", "supervisor-process.ts"], unused)).rejects.toThrow("config path is required");
    await expect(runFactorySupervisorMain(["bun", "supervisor-process.ts", "a", "b"], unused)).rejects.toThrow("config path is required");
  });
});

describe("startFactorySupervisorMain", () => {
  test("runs only when this module is the process entry", () => {
    const calls: string[] = [];
    const dependenciesFor = { runConfigured: async (path: string) => { calls.push(path); }, once: () => {}, removeListener: () => {}, fail: () => {} };
    startFactorySupervisorMain(["bun", "/other/entry.ts", "/run/config.json"], import.meta.url, dependenciesFor);
    expect(calls).toEqual([]);
    startFactorySupervisorMain([], import.meta.url, dependenciesFor);
    expect(calls).toEqual([]);
  });

  test("reports a failed run through the injected failure path", async () => {
    const failures: number[] = [];
    startFactorySupervisorMain(["bun", new URL(import.meta.url).pathname, "/run/config.json"], import.meta.url, {
      runConfigured: async () => { throw new Error("boom"); },
      once: () => {}, removeListener: () => {},
      fail: () => { failures.push(1); },
    });
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(failures).toEqual([1]);
  });
});

describe("factorySupervisorProductionDependencies", () => {
  test("its wait resolves on abort and on elapse, never rejecting", async () => {
    const controller = new AbortController();
    const settled: string[] = [];
    const waiting = factorySupervisorProductionDependencies.wait(60_000, controller.signal)
      .then(() => settled.push("resolved"), () => settled.push("rejected"));
    controller.abort();
    await waiting;
    expect(settled).toEqual(["resolved"]);

    const aborted = new AbortController();
    aborted.abort();
    await factorySupervisorProductionDependencies.wait(60_000, aborted.signal);
    await factorySupervisorProductionDependencies.wait(1, new AbortController().signal);
    expect(settled).toEqual(["resolved"]);
  });

  test("builds a readiness writer for the exact host it is configured for", async () => {
    const root = await privateRoot();
    const writer = factorySupervisorProductionDependencies.createReadiness(parseFactorySupervisorProcessConfig(config(root)));
    const published = await writer.write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true , hostServicesReady: false } });
    expect(published).toMatchObject({ service: "host-supervisor", installationId: "installation-01", instanceId: "host-01" });

    const noHeartbeat = factorySupervisorProductionDependencies.createReadiness(parseFactorySupervisorProcessConfig(config(root, { readinessHeartbeatMs: undefined })));
    expect(await noHeartbeat.write({ lifecycle: "starting", facts: { hostKeyReady: false, runnerReady: false , hostServicesReady: false } })).toMatchObject({ lifecycle: "starting" });
  });
});

describe("the host services this supervisor publishes", () => {
  const services = (root: string) => ({
    hostname: "127.0.0.1",
    port: 8600,
    allowedPeers: ["tenant-a"],
    hostKeyIdPath: join(root, "host.kid"),
    tls: { caPath: join(root, "ca.pem"), certificatePath: join(root, "server.pem"), privateKeyPath: join(root, "server.key") },
  });

  test("the parser takes a complete section and refuses every incomplete one", async () => {
    const root = await privateRoot();
    const complete = services(root);
    expect(parseFactorySupervisorProcessConfig(config(root, { services: complete } as never)).services).toEqual(complete as never);
    // Absent is legal: a deployment whose runner lives in the product process
    // publishes no host services.
    expect(parseFactorySupervisorProcessConfig(config(root)).services).toBeUndefined();

    for (const broken of [
      { ...complete, hostname: "" },
      { ...complete, port: 0 },
      { ...complete, port: 70_000 },
      { ...complete, allowedPeers: [] },
      { ...complete, allowedPeers: ["ok", ""] },
      { ...complete, hostKeyIdPath: "" },
      { ...complete, tls: { caPath: "a", certificatePath: "b" } },
      { ...complete, tls: { ...complete.tls, extra: "x" } },
      { ...complete, extra: "x" },
      "not a record",
    ]) {
      expect(() => parseFactorySupervisorProcessConfig(config(root, { services: broken } as never))).toThrow("factory supervisor config is invalid");
    }
  });

  test("the pool section is optional, complete, or refused", async () => {
    const root = await privateRoot();
    const complete = services(root);
    const pool = {
      baseUrl: "https://127.0.0.1:8700",
      serviceTokenPath: join(root, "pool.token"),
      tls: { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key") },
    };
    // With a pool this host can tell C03 that a process group is gone, which is
    // the only way the product's own confirmation ever settles.
    expect(parseFactorySupervisorProcessConfig(config(root, { services: { ...complete, pool } } as never)).services?.pool).toEqual(pool as never);
    // Without one it still signs; the product reports its own refusal by name.
    expect(parseFactorySupervisorProcessConfig(config(root, { services: complete } as never)).services?.pool).toBeUndefined();

    for (const broken of [
      { ...pool, baseUrl: "" },
      { ...pool, serviceTokenPath: "" },
      { ...pool, tls: { caPath: "a", certificatePath: "b" } },
      { ...pool, tls: { ...pool.tls, extra: "x" } },
      { ...pool, extra: "x" },
      "not a record",
    ]) {
      expect(() => parseFactorySupervisorProcessConfig(config(root, { services: { ...complete, pool: broken } } as never))).toThrow("factory supervisor config is invalid");
    }
  });

  test("binds once after the first good probe, publishes the fact, and releases on stop", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root, { services: services(root) } as never);
    abortController = new AbortController();
    const published: Array<{ lifecycle: string; hostServicesReady: boolean }> = [];
    let started = 0;
    let stopped = 0;
    const runner = { async initialize() {}, async close() {} } as never;

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => {}, instance: () => runner, close: async () => {} }),
      startServices: async () => { started += 1; return { stop: () => { stopped += 1; } }; },
      createReadiness: () => ({ write: async (update) => { published.push({ lifecycle: update.lifecycle, hostServicesReady: update.facts.hostServicesReady! }); return { ...update } as never; } }),
    }, 5));

    // Bound ONCE across several heartbeats: rebinding each beat would drop live
    // connections, and the listener is released before the process says stopped.
    expect(started).toBe(1);
    expect(stopped).toBe(1);
    expect(published.some((entry) => entry.lifecycle === "ready" && entry.hostServicesReady)).toBe(true);
    expect(published.at(-1)).toEqual({ lifecycle: "stopped", hostServicesReady: false });
  });

  test("a bind that fails degrades by name and is retried on the next heartbeat", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root, { services: services(root) } as never);
    abortController = new AbortController();
    const published: string[] = [];
    let attempts = 0;
    const runner = { async initialize() {}, async close() {} } as never;

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => {}, instance: () => runner, close: async () => {} }),
      startServices: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("address in use");
        return { stop: () => {} };
      },
      createReadiness: () => ({ write: async (update) => { published.push(`${update.lifecycle}:${update.errorCode ?? ""}`); return { ...update } as never; } }),
    }, 6));

    expect(attempts).toBeGreaterThan(1);
    expect(published.some((entry) => entry === "degraded:host_services_unavailable")).toBe(true);
    expect(published.some((entry) => entry === "ready:")).toBe(true);
  });

  test("a runner that never answers never publishes a host service", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root, { services: services(root) } as never);
    abortController = new AbortController();
    let started = 0;

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      createRunnerProbe: () => ({ probe: async () => { throw new Error("isolation_unavailable"); }, instance: () => undefined, close: async () => {} }),
      startServices: async () => { started += 1; return { stop: () => {} }; },
    }));

    // A host that accepted a launch its runner cannot serve would report a start
    // it never made.
    expect(started).toBe(0);
  });

  test("a host that publishes no services stays ready on its own two facts", async () => {
    const root = await privateRoot();
    await writeHostKey(root);
    const path = await writeConfig(root);
    abortController = new AbortController();
    const published: Array<{ lifecycle: string; errorCode?: string }> = [];
    let started = 0;

    await runConfiguredFactorySupervisor(path, abortController.signal, dependencies({
      startServices: async () => { started += 1; return { stop: () => {} }; },
      createReadiness: () => ({ write: async (update) => { published.push({ lifecycle: update.lifecycle, ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }) }); return { ...update } as never; } }),
    }, 5));

    expect(started).toBe(0);
    expect(published.some((entry) => entry.lifecycle === "ready")).toBe(true);
    expect(published.some((entry) => entry.errorCode === "host_services_unavailable")).toBe(false);
  });

  test("a configured host whose listener never bound reads as degraded, not ready", () => {
    const facts = { hostKeyReady: true, runnerReady: true, hostServicesReady: false };
    expect(factorySupervisorRecord({ attempted: true, ...facts, servicesConfigured: true, observedAtMs: 900 }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts, errorCode: "host_services_unavailable" });
    // The same observation on a host that publishes none is simply ready.
    expect(factorySupervisorRecord({ attempted: true, ...facts, servicesConfigured: false, observedAtMs: 900 }, 1_000, 500))
      .toEqual({ lifecycle: "ready", facts });
  });

  test("startFactoryConfiguredHostServices refuses when the section is absent", async () => {
    const root = await privateRoot();
    await expect(startFactoryConfiguredHostServices(parseFactorySupervisorProcessConfig(config(root)), {} as never))
      .rejects.toThrow("factory supervisor host services are not configured");
  });

  test("startFactoryConfiguredHostServices binds from the configured material", async () => {
    const root = await privateRoot();
    const certs = await certificates(certificateRoots, "tenant-a");
    for (const [name, value] of [["ca.pem", certs.ca], ["server.pem", certs.serverCert], ["server.key", certs.serverKey]] as const) {
      await writeFile(join(root, name), value, { mode: 0o600 });
      await chmod(join(root, name), 0o600);
    }
    await writeFile(join(root, "host.kid"), "host-key-1", { mode: 0o600 });
    await writeHostKey(root);
    // The parser refuses port 0 as a deployment fact, so the test takes a real
    // free port and releases it before the listener binds it.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    const parsed = parseFactorySupervisorProcessConfig(config(root, { services: { ...services(root), port } } as never));
    const listener = await startFactoryConfiguredHostServices(parsed, { async initialize() {}, async close() {} } as never);
    try {
      expect(listener).toBeDefined();
    } finally {
      listener.stop();
    }
  });

  test("a configured pool becomes the client the stop route presents to", async () => {
    const root = await privateRoot();
    const certs = await certificates(certificateRoots, "tenant-a");
    for (const [name, value] of [["ca.pem", certs.ca], ["server.pem", certs.serverCert], ["server.key", certs.serverKey], ["client.pem", certs.clientCert], ["client.key", certs.clientKey]] as const) {
      await writeFile(join(root, name), value, { mode: 0o600 });
      await chmod(join(root, name), 0o600);
    }
    await writeFile(join(root, "host.kid"), "host-key-1", { mode: 0o600 });
    await writeFile(join(root, "pool.token"), "supervisor-token", { mode: 0o600 });
    await chmod(join(root, "pool.token"), 0o600);
    await writeHostKey(root);
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    // Built before the listener binds. The pool is not reached here — building
    // the client reads its secrets and nothing else — so this asserts the
    // configured material composes, not that a pool answered.
    const parsed = parseFactorySupervisorProcessConfig(config(root, {
      services: {
        ...services(root), port,
        pool: {
          baseUrl: "https://127.0.0.1:1",
          serviceTokenPath: join(root, "pool.token"),
          tls: { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key") },
        },
      },
    } as never));
    const listener = await startFactoryConfiguredHostServices(parsed, { async initialize() {}, async close() {} } as never);
    try {
      expect(listener).toBeDefined();
    } finally {
      listener.stop();
    }
  });
});

describe("the real supervisor entry", () => {
  test("prints the cause before it sets the exit code", () => {
    // A silent exit 1 is the one symptom a reader cannot act on, and this
    // default is what the process actually runs with. The line is written
    // first, so a reader still sees it if anything later in the shutdown path
    // throws.
    const printed: unknown[][] = [];
    const error = console.error;
    const previous = process.exitCode;
    console.error = (...parts: unknown[]) => { printed.push(parts); expect(process.exitCode).toBe(previous); };
    try {
      productionMainDependencies.fail(new Error("supervisor configuration refused"));
    } finally {
      console.error = error;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = previous ?? 0;
    expect(printed).toHaveLength(1);
    expect(String(printed[0]![1])).toContain("supervisor configuration refused");

    // A refusal that is not an Error still names itself rather than printing
    // "[object Object]".
    const second: unknown[][] = [];
    console.error = (...parts: unknown[]) => { second.push(parts); };
    try {
      productionMainDependencies.fail("factory-configuration-invalid");
    } finally {
      console.error = error;
    }
    process.exitCode = previous ?? 0;
    expect(String(second[0]![1])).toBe("factory-configuration-invalid");
  });

  test("the signal hooks it installs are the process's own", () => {
    // `once` and `removeListener` are the pair that lets a SIGTERM stop the
    // supervisor exactly once; a default nothing measures is a default that
    // can be wrong.
    const listener = () => {};
    productionMainDependencies.once("SIGTERM", listener);
    expect(process.listeners("SIGTERM")).toContain(listener);
    productionMainDependencies.removeListener("SIGTERM", listener);
    expect(process.listeners("SIGTERM")).not.toContain(listener);
  });
});
