import { afterEach, describe, expect, test } from "bun:test";
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
  runFactorySupervisorMain,
  startFactorySupervisorMain,
  factorySupervisorProductionDependencies,
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
    createRunnerProbe: () => ({ probe: async () => {}, close: async () => {} }),
    createReadiness: factorySupervisorProductionDependencies.createReadiness,
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
  const facts = { hostKeyReady: true, runnerReady: true };
  const none = { hostKeyReady: false, runnerReady: false };

  test("starting means it has not looked yet, and never carries a reason", () => {
    // A reader must be able to tell a supervisor that has not looked from one
    // that looked and did not like what it saw.
    expect(factorySupervisorRecord({ attempted: false, ...none, observedAtMs: 0 }, 1_000, 500))
      .toEqual({ lifecycle: "starting", facts: none });
  });

  test("publishes ready only for a fresh observation of both facts", () => {
    expect(factorySupervisorRecord({ attempted: true, ...facts, observedAtMs: 900 }, 1_000, 500)).toEqual({ lifecycle: "ready", facts });
    // Exactly at the bound is still current; one past it is not.
    expect(factorySupervisorRecord({ attempted: true, ...facts, observedAtMs: 500 }, 1_000, 500)).toEqual({ lifecycle: "ready", facts });
    expect(factorySupervisorRecord({ attempted: true, ...facts, observedAtMs: 499 }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts, errorCode: "observation_stale" });
  });

  test("never asserts a fact nobody is still checking", () => {
    const aged = factorySupervisorRecord({ attempted: true, ...facts, observedAtMs: 1 }, 1_000_000, 500);
    expect(aged).toEqual({ lifecycle: "degraded", facts, errorCode: "observation_stale" });
  });

  test("a failed observation names the failing fact", () => {
    expect(factorySupervisorRecord({ attempted: true, hostKeyReady: true, runnerReady: false, observedAtMs: 0, errorCode: "runner_unavailable" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: { hostKeyReady: true, runnerReady: false }, errorCode: "runner_unavailable" });
    expect(factorySupervisorRecord({ attempted: true, ...none, observedAtMs: 0, errorCode: "host_key_unavailable" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: none, errorCode: "host_key_unavailable" });
    expect(factorySupervisorRecord({ attempted: true, hostKeyReady: true, runnerReady: false, observedAtMs: 0, errorCode: "runner_probe_timeout" }, 1_000, 500))
      .toEqual({ lifecycle: "degraded", facts: { hostKeyReady: true, runnerReady: false }, errorCode: "runner_probe_timeout" });
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
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), close: async () => {} }),
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
      createRunnerProbe: () => ({ probe: async () => { probes += 1; }, close: async () => {} }),
      wait: async () => {
        // Both loops share this; read after the publish loop has written once.
        try { observed = await readFactoryServiceReadiness(scope); } catch { /* not ready yet */ }
        if (observed) abortController!.abort();
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      },
    }));
    expect(probes).toBeGreaterThan(0);
    expect(observed).toMatchObject({ service: "host-supervisor", instanceId: "host-01", lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true } });
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
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), close: async () => {} }),
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
      createRunnerProbe: () => ({ probe: () => new Promise<void>(() => {}), close: async () => {} }),
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
      createRunnerProbe: () => ({ probe: async () => { throw new Error("podman is not answering"); }, close: async () => {} }),
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
      createRunnerProbe: () => ({ probe: async () => { probed += 1; }, close: async () => { closed += 1; } }),
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
    const probe = factoryHostRunnerProbe(async () => { throw new Error("the loader must not be reached"); });
    await probe.close();
  });

  test("a failed initialize propagates, and the next probe retries the same instance", async () => {
    let attempts = 0;
    const constructed: string[] = [];
    class Runner {
      constructor(readonly options: { root: string }) { constructed.push(options.root); }
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
    const published = await writer.write({ lifecycle: "ready", facts: { hostKeyReady: true, runnerReady: true } });
    expect(published).toMatchObject({ service: "host-supervisor", installationId: "installation-01", instanceId: "host-01" });

    const noHeartbeat = factorySupervisorProductionDependencies.createReadiness(parseFactorySupervisorProcessConfig(config(root, { readinessHeartbeatMs: undefined })));
    expect(await noHeartbeat.write({ lifecycle: "starting", facts: { hostKeyReady: false, runnerReady: false } })).toMatchObject({ lifecycle: "starting" });
  });
});
